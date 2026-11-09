// HTTP surface from architecture Part 4. Long work is always a job: POST returns
// 202 with a job id, progress streams over SSE, and results are fetched by id.
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import Fastify from 'fastify';
import type {FastifyReply} from 'fastify';
import {z} from 'zod';
import {ExtractedDesignSystem, TERMINAL_JOB_STATUSES} from '@gapscan/schema';
import type {JobEvent, JobType} from '@gapscan/schema';
import type {Infra, JobHandler} from '@gapscan/infra';
import {createSiteMemory, createUrlAdapter, figmaFileKey, SITE_MEMORY_MAX_AGE_DAYS, writeZip} from '@gapscan/adapters';
import type {Adapter} from '@gapscan/adapters';
import {listReferences, loadReference} from '@gapscan/library';
import {planningTotals} from '@gapscan/estimate';
import {Assumptions, GapScanReport, ObjectKind} from '@gapscan/schema';
import {CODE_FILE, createExtractHandler} from './extract-job.ts';
import {projectSpecimen} from '@gapscan/gapscan';
import {buildDesignSystem, buildFigmaPlan, EXPORT_FORMATS, exportTokens, planFigmaSync, renderDesignSystemHtml} from '@gapscan/exports';
import type {ExistingVariables} from '@gapscan/exports';
import {buildObjects, contentHash, isDraftable} from '@gapscan/objects';
import {approvalsKey, createDraftHandler, draftsKey, readApprovals, readDrafts, readSuggestions} from './draft-job.ts';
import type {Ai} from './draft-job.ts';
import {assetKey, BOOK, createRenderHandler} from './render-job.ts';
import {createUsageHandler, githubRepo, loadUsageReport} from './usage-job.ts';
import {buildBrandKit, TEMPLATES} from '@gapscan/assets';
import {approvalKey, computeReport, createGapScanHandler, loadExtraction, loadGapScan, saveReport, summarize} from './gapscan-job.ts';
import {codemodPlan, createCodemodHandler, loadCodemodRun} from './codemod-job.ts';
import {buildScript} from '@gapscan/codemod';
import {isVisitor, registerAuth} from './auth.ts';
import {missingItems} from './missing.ts';
import {createScraplingAdapter, scraplingAvailable} from './scrapling.ts';
import type {AuthConfig} from './auth.ts';
import {createUrlGuard, publicUrl, UnsafeUrlError, createPinnedResolver} from './url-safety.ts';
import {lookup} from 'node:dns/promises';
const lookupAll = (hostname: string) => lookup(hostname, {all: true, verbatim: true});

export const MAX_CODE_BYTES = 1_500_000;
export const MAX_FILE_BYTES = 40_000_000;
// Uploaded files are typed by extension; the adapter then checks the content itself.
const FILE_KINDS: [RegExp, 'pptx' | 'docx' | 'pdf' | 'zip' | 'image' | 'code'][] = [[/\.pptx$/i, 'pptx'], [/\.docx$/i, 'docx'], [/\.pdf$/i, 'pdf'], [/\.zip$/i, 'zip'], [/\.(png|jpe?g|webp|gif)$/i, 'image'], [CODE_FILE, 'code']];
const HEARTBEAT_MS = 15_000;

const SourceRole = z.enum(['system', 'application']).default('system');
const CreateProjectBody = z.object({name: z.string().trim().min(1).max(200)});
const AddSourceBody = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('url'), uri: z.string().min(1).max(2048), consent: z.boolean().optional(), role: SourceRole, reader: z.enum(['default', 'scrapling']).optional()}),
  z.object({kind: z.literal('code'), name: z.string().trim().min(1).max(200).regex(/^[\w .()@-]+$/, 'Use letters, numbers, spaces, dots, dashes, underscores or @.'), content: z.string().min(1), role: SourceRole}),
  z.object({kind: z.literal('file'), name: z.string().trim().min(1).max(200).regex(/^[\w .()@-]+$/, 'Use letters, numbers, spaces, dots, dashes, underscores or @.'), base64: z.string().min(1), role: SourceRole}),
]);
const IdParams = z.object({id: z.string().min(1)});

export type AppOptions = {infra: Infra; handlers?: Partial<Record<JobType, JobHandler>>; logger?: boolean; heartbeatMs?: number; figma?: {token?: string; fetch?: typeof fetch}; auth?: AuthConfig;
  // Drafting with Claude; absent unless GAPSCAN_AI=claude.
  ai?: Ai};

export function buildApp({infra, handlers = {}, logger = false, heartbeatMs = HEARTBEAT_MS, figma = {token: process.env.GAPSCAN_FIGMA_TOKEN}, auth = {mode: 'off'}, ai}: AppOptions) {
  const {store, blobs, bus, queue} = infra;
  // Every page and sub-request the browser makes must pass the same public-URL check as intake.
  // Each extraction gets a fresh guard, so DNS answers are cached for one job only.
  // Websites already read are kept (pages plus crawl progress) and reused or continued on the next import.
  const siteMemory = createSiteMemory(blobs, {maxAgeDays: Number(process.env.GAPSCAN_SITE_MAX_AGE_DAYS) || SITE_MEMORY_MAX_AGE_DAYS});
  const urlAdapter: Adapter = (input, context) =>
    createUrlAdapter({allowUrl: createUrlGuard(lookupAll), egress: createPinnedResolver(lookupAll), maxPages: Number(process.env.GAPSCAN_MAX_PAGES) || 8, maxSitePages: Number(process.env.GAPSCAN_SITE_MAX_PAGES) || 24, memory: siteMemory})(input, context);
  // The alternative website reader; each read gets its own URL guard and pinned resolver, as above.
  const scraplingAdapter: Adapter = (input, context) =>
    createScraplingAdapter({allowUrl: createUrlGuard(lookupAll), resolve: createPinnedResolver(lookupAll), maxPages: Number(process.env.GAPSCAN_MAX_PAGES) || 8})(input, context);
  queue.register('extract', handlers.extract ?? createExtractHandler({store, blobs, urlAdapter, scraplingAdapter}));
  queue.register('gapscan', handlers.gapscan ?? createGapScanHandler({store, blobs}));
  queue.register('render', handlers.render ?? createRenderHandler({store, blobs}));
  queue.register('usage', handlers.usage ?? createUsageHandler({store, blobs, allowUrl: url => createUrlGuard(lookupAll)(url)}));
  if (handlers.generate ?? ai) queue.register('generate', handlers.generate ?? createDraftHandler({store, blobs, ai: ai!}));
  queue.register('codemod', handlers.codemod ?? createCodemodHandler({store, blobs, allowUrl: url => createUrlGuard(lookupAll)(url)}));
  const app = Fastify({logger, bodyLimit: Math.ceil(MAX_FILE_BYTES * 1.4)});
  // Action endpoints like POST /extractions take no body; clients that still send
  // `content-type: application/json` with nothing in it should not get a 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', {parseAs: 'string'}, (_request, body, done) => {
    if (body === '') return done(null, undefined);
    try { done(null, JSON.parse(body as string)); }
    catch { done(Object.assign(new Error('Request body is not valid JSON.'), {statusCode: 400}), undefined); }
  });

  const fail = (reply: FastifyReply, status: number, error: string, issues?: unknown) => reply.code(status).send({error, ...(issues ? {issues} : {})});
  const parse = <T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | undefined => {
    const result = schema.safeParse(value);
    if (!result.success) { void fail(reply, 400, 'Invalid request.', z.flattenError(result.error as z.ZodError<Record<string, unknown>>)); return undefined; }
    return result.data;
  };

  // Accounts first: its hook guards every route below.
  registerAuth(app, store, auth, fail);
  app.get('/health', async () => ({ok: true}));

  // The extraction UI: a few static files, no build step. Only known names are served.
  const PUBLIC = new URL('../public/', import.meta.url), TYPES: Record<string, string> = {html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8'};
  app.get('/', async (_request, reply) => reply.redirect('/app/'));
  // For load balancers: the store answers (a missing row is fine; a lost connection is not).
  app.get('/healthz', async (_request, reply) => {
    try { await store.getProject('00000000-0000-0000-0000-000000000000'); return {ok: true}; }
    catch { return fail(reply, 503, 'The database is not reachable.'); }
  });
  app.get('/app/*', async (request, reply) => {
    const name = (request.params as {'*': string})['*'] || 'index.html';
    if (!/^[a-z-]+\.(html|css|js)$/.test(name)) return fail(reply, 404, 'Not found.');
    try {
      const body = await readFile(new URL(name, PUBLIC));
      return reply.type(TYPES[name.split('.').pop()!]!).header('cache-control', 'no-cache').header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:").send(body);
    } catch { return fail(reply, 404, 'Not found.'); }
  });

  app.post('/v1/projects', async (request, reply) => {
    const body = parse(CreateProjectBody, request.body, reply); if (!body) return reply;
    const project = await store.createProject(body.name);
    if (request.user) await store.setMember(project.id, request.user.id, 'owner');
    return reply.code(201).send(project);
  });

  // Your projects (all of them when accounts are off), newest activity first, with what's in each.
  const projectSummaries = async (projects: Awaited<ReturnType<typeof store.listProjects>>) => {
    const listed = await Promise.all(projects.map(async project => {
      const [extractions, sources] = await Promise.all([store.listExtractions(project.id), store.listSources(project.id)]);
      const latest = extractions.reduce<typeof extractions[number] | null>((a, b) => !a || b.createdAt > a.createdAt ? b : a, null);
      return {...project, sources: sources.filter(s => s.role === 'system').length, extractions: extractions.length,
        latestExtraction: latest ? {id: latest.id, version: latest.version, createdAt: latest.createdAt} : null,
        lastActivity: [project.createdAt, latest?.createdAt, ...sources.map(s => s.createdAt)].filter((d): d is string => Boolean(d)).sort().at(-1)!};
    }));
    return listed.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  };
  app.get('/v1/projects', async request => projectSummaries(request.user ? await store.listProjectsFor(request.user.id) : await store.listProjects()));
  // Admin: the latest jobs on every project, failures with their reason, and the project's name.
  const JOB_LABEL: Record<string, string> = {extract: 'Read a design system', gapscan: 'Comparison', generate: 'Claude draft', render: 'Render', usage: 'App-code scan', codemod: 'Codemod dry run'};
  app.get('/v1/admin/activity', async () => {
    const jobs = await store.listRecentJobs(100), names = new Map<string, string>();
    for (const projectId of new Set(jobs.map(j => j.projectId))) names.set(projectId, (await store.getProject(projectId))?.name ?? 'Deleted project');
    return jobs.map(j => ({id: j.id, type: j.type, label: JOB_LABEL[j.type] ?? j.type, status: j.status, project: names.get(j.projectId), projectId: j.projectId,
      resultId: j.resultId ?? null, error: j.error?.message ?? null, createdAt: j.createdAt, updatedAt: j.updatedAt}));
  });
  // Admin: what this GapScan is set up with. Never secrets, only whether something is configured.
  app.get('/v1/admin/settings', async () => ({
    accounts: auth.mode === 'off' ? 'Off' : auth.visitors ? 'Visitors without sign-in; admins sign in' : 'Everyone signs in',
    admins: auth.mode === 'off' ? [] : auth.admins ?? [],
    signIn: auth.mode === 'off' ? [] : [...(auth.emailLinks !== false ? ['Email links'] : []), ...(auth.sso?.list().map(p => p.name) ?? []), ...(auth.testUsers?.length ? ['Test accounts (local only)'] : [])],
    drafting: ai ? {enabled: true, provider: 'Anthropic', model: ai.model, effort: ai.effort} : {enabled: false},
    figmaToken: Boolean(figma.token),
    references: (await listReferences()).map(r => ({id: r.id, library: r.library, version: r.version, framework: r.framework, components: r.components, pinnedAt: r.pinnedAt})),
  }));

  // Admin: every design system on this GapScan, with who it belongs to (visitors stay anonymous).
  app.get('/v1/admin/design-systems', async () => {
    const listed = await projectSummaries(await store.listProjects());
    return Promise.all(listed.map(async p => {
      const owner = (await store.listMembers(p.id)).find(m => m.role === 'owner');
      return {...p, owner: owner ? (isVisitor(owner) ? 'Visitor' : owner.email) : null};
    }));
  });
  app.patch('/v1/projects/:id', async (request, reply) => {
    const {id} = IdParams.parse(request.params);
    const body = parse(CreateProjectBody, request.body, reply); if (!body) return reply;
    return (await store.renameProject(id, body.name)) ?? fail(reply, 404, 'Project not found.');
  });

  // Whether Figma links can be read here (never the token itself).
  app.get('/v1/figma', async () => ({connected: Boolean(figma.token)}));
  // Ways to read a website: GapScan's browser always; Scrapling when it's installed on the server.
  app.get('/v1/readers', async () => {
    const scrapling = await scraplingAvailable();
    return [{id: 'default', label: 'GapScan’s browser', description: 'Renders each page at three widths and in dark mode, measures hover and focus states, and takes screenshots.', available: true},
      {id: 'scrapling', label: 'Scrapling', description: 'Downloads the pages and their stylesheets with Scrapling’s HTTP fetcher and reads the CSS. Faster; no screenshots, measured states or dark mode.', available: scrapling.available, ...(scrapling.reason ? {reason: scrapling.reason} : {})}];
  });

  // What's saved for a website: pages read, pages still queued, when it was first read.
  app.get('/v1/saved-sites', async (request, reply) => {
    const url = String((request.query as {url?: string}).url ?? '');
    let parsed: URL;
    try { parsed = publicUrl(url); } catch { return fail(reply, 400, 'Give a public https:// address.'); }
    const saved = await siteMemory.info(parsed.href), limit = Number(process.env.GAPSCAN_SITE_MAX_PAGES) || 24;
    return {url: parsed.href, saved: saved ? {...saved, limit, full: saved.pages >= limit} : null};
  });

  app.get('/v1/projects/:id', async (request, reply) => {
    const {id} = IdParams.parse(request.params);
    const project = await store.getProject(id);
    if (!project) return fail(reply, 404, 'Project not found.');
    const extractions = (await store.listExtractions(id)).map(({id: eid, version, createdAt}) => ({id: eid, version, createdAt}));
    return {...project, sources: await store.listSources(id), extractions, ...(request.user ? {role: await store.roleOf(id, request.user.id)} : {})};
  });

  // Sources are validated and stored only; nothing is fetched or parsed until an extraction job runs.
  app.post('/v1/projects/:id/sources', async (request, reply) => {
    const {id: projectId} = IdParams.parse(request.params);
    if (!await store.getProject(projectId)) return fail(reply, 404, 'Project not found.');
    const body = parse(AddSourceBody, request.body, reply); if (!body) return reply;
    const id = randomUUID(), createdAt = new Date().toISOString();
    if (body.kind === 'url') {
      let url: URL;
      try { url = publicUrl(body.uri); } catch (error) { return fail(reply, 400, error instanceof UnsafeUrlError ? error.message : 'Invalid URL.'); }
      if (body.role === 'application' && !githubRepo(url.href)) return fail(reply, 400, 'Application code links must be public github.com repositories (https://github.com/owner/repo).');
      const kind = /^(www\.)?figma\.com$/.test(url.hostname) ? 'figma' as const : 'url' as const;
      // Figma's API needs a token for every file, public or not; without one, say so now rather than fail later.
      if (kind === 'figma' && !figma.token) return fail(reply, 400, 'Figma files can’t be read here yet: this GapScan isn’t connected to Figma. Add the file’s styles another way (export them as CSS or token JSON, or paste the link of the live site), or ask whoever runs GapScan to connect Figma.');
      const scrapling = kind === 'url' && body.role === 'system' && body.reader === 'scrapling';
      if (scrapling) { const check = await scraplingAvailable(); if (!check.available) return fail(reply, 400, `${check.reason} Use GapScan’s own reader for this site.`); }
      const source = {id, projectId, kind, uri: url.href, label: url.hostname, sha256: createHash('sha256').update(url.href).digest('hex'),
        bytes: 0, budget: {maxPages: 40, maxBytes: 20_000_000}, ...(body.consent !== undefined ? {consent: body.consent} : {}), role: body.role, ...(scrapling ? {reader: 'scrapling' as const} : {}), createdAt};
      await store.addSource(source);
      return reply.code(201).send(source);
    }
    if (body.kind === 'file') {
      const kind = FILE_KINDS.find(([pattern]) => pattern.test(body.name))?.[1];
      if (!kind) return fail(reply, 415, `${body.name} is not a supported file type. Use PDF, PowerPoint, Word, ZIP, CSS/SCSS/Less, token JSON, HTML, Markdown, component code (JS/TS, Vue, Svelte), or a PNG, JPEG, WebP or GIF image.`);
      const data = Buffer.from(body.base64, 'base64');
      if (!data.length) return fail(reply, 400, 'The file is empty or not base64-encoded.');
      if (data.length > MAX_FILE_BYTES) return fail(reply, 413, `${body.name} is ${data.length} bytes; the limit is ${MAX_FILE_BYTES}.`);
      const blobKey = await blobs.put(`sources/${projectId}/${id}`, data);
      const source = {id, projectId, kind, uri: `upload:${body.name}`, label: body.name, sha256: createHash('sha256').update(data).digest('hex'),
        bytes: data.length, blobKey, budget: {maxPages: 200, maxBytes: MAX_FILE_BYTES}, role: body.role, createdAt};
      await store.addSource(source);
      return reply.code(201).send(source);
    }
    const bytes = Buffer.byteLength(body.content, 'utf8');
    if (bytes > MAX_CODE_BYTES) return fail(reply, 413, `Pasted code is ${bytes} bytes; the limit is ${MAX_CODE_BYTES}. Upload a smaller file.`);
    const blobKey = await blobs.put(`sources/${projectId}/${id}`, body.content);
    const source = {id, projectId, kind: 'code' as const, uri: `inline:${body.name}`, label: body.name, sha256: createHash('sha256').update(body.content).digest('hex'),
      bytes, blobKey, budget: {maxPages: 1, maxBytes: MAX_CODE_BYTES}, role: body.role, createdAt};
    await store.addSource(source);
    return reply.code(201).send(source);
  });

  app.post('/v1/projects/:id/extractions', async (request, reply) => {
    const {id: projectId} = IdParams.parse(request.params);
    if (!await store.getProject(projectId)) return fail(reply, 404, 'Project not found.');
    if (!(await store.listSources(projectId)).length) return fail(reply, 400, 'Add at least one source before extracting.');
    // `refresh` reads saved websites again instead of reusing and continuing them.
    const refresh = (request.body as {refresh?: unknown} | undefined)?.refresh === true;
    const job = await store.createJob({type: 'extract', projectId, payload: refresh ? {refresh} : {}});
    await queue.enqueue(job);
    return reply.code(202).header('location', `/v1/jobs/${job.id}`).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });

  app.get('/v1/jobs/:id', async (request, reply) => {
    const job = await store.getJob(IdParams.parse(request.params).id);
    return job ?? fail(reply, 404, 'Job not found.');
  });

  app.delete('/v1/jobs/:id', async (request, reply) => {
    const job = await store.getJob(IdParams.parse(request.params).id);
    if (!job) return fail(reply, 404, 'Job not found.');
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return fail(reply, 409, `Job already ${job.status}.`);
    return await queue.cancel(job.id) ? reply.code(202).send({status: 'cancelling'}) : fail(reply, 409, 'Job is not running in this server process.');
  });

  // Server-sent events with resume: the client's Last-Event-ID (or ?after=) is the
  // last sequence it saw. We subscribe before replaying so nothing is missed, drop
  // duplicates by sequence, and end the stream after the terminal event.
  app.get('/v1/jobs/:id/events', async (request, reply) => {
    const {id} = IdParams.parse(request.params);
    if (!await store.getJob(id)) return fail(reply, 404, 'Job not found.');
    const query = request.query as {after?: string}, header = request.headers['last-event-id'];
    const after = Math.max(0, Number(Array.isArray(header) ? header[0] : header ?? query.after ?? 0) || 0);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no'});
    res.write('retry: 2000\n\n');

    let cursor = after, ended = false, replaying = true, heartbeat: NodeJS.Timeout | undefined;
    const pending: JobEvent[] = [];
    const isTerminal = (event: JobEvent) => event.body.type === 'complete' || event.body.type === 'failed' || event.body.type === 'cancelled';
    const end = () => { if (ended) return; ended = true; clearInterval(heartbeat); unsubscribe(); res.end(); };
    const send = (event: JobEvent) => {
      if (ended || event.seq <= cursor) return;
      cursor = event.seq;
      if (isTerminal(event)) clearInterval(heartbeat);   // no heartbeat may follow the terminal event
      res.write(`id: ${event.seq}\nevent: ${event.body.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (isTerminal(event)) end();
    };
    const unsubscribe = bus.subscribe(id, event => { if (replaying) pending.push(event); else send(event); });
    request.raw.on('close', end);

    for (const event of await store.listEvents(id, after)) send(event);
    replaying = false;
    for (const event of pending.sort((a, b) => a.seq - b.seq)) send(event);
    if (!ended && (await store.listEvents(id, 0)).some(event => isTerminal(event) && event.seq <= cursor)) end();   // client already saw the end
    if (!ended) heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
  });

  app.get('/v1/extractions/:id/scales', async (request, reply) => {
    const record = await store.getExtraction(IdParams.parse(request.params).id);
    const blob = record && await blobs.get(`extractions/${record.id}.scales.json`);
    return blob ? JSON.parse(blob.toString('utf8')) : fail(reply, 404, 'Scales not found for this extraction.');
  });

  // The extraction as a Figma-style library: JSON for tools, or a self-contained page to read and share.
  const designSystem = async (id: string) => {
    const record = await store.getExtraction(id), eds = await loadExtraction(store, blobs, id);
    const scales = record && await blobs.get(`extractions/${record.id}.scales.json`);
    if (!record || !eds) return null;
    const project = await store.getProject(record.projectId), host = eds.sources.map(s => { try { return new URL(s.uri).hostname.replace(/^www\./, ''); } catch { return ''; } }).find(Boolean);
    return buildDesignSystem(eds, scales ? JSON.parse(scales.toString('utf8')) : {}, host ?? project?.name ?? 'Design system');
  };
  // Commonly expected components and foundations this extraction didn't find, so people can add them.
  app.get('/v1/extractions/:id/missing', async (request, reply) => {
    const eds = await loadExtraction(store, blobs, IdParams.parse(request.params).id);
    return eds ? missingItems(eds) : fail(reply, 404, 'Extraction not found.');
  });
  app.get('/v1/extractions/:id/design-system', async (request, reply) => (await designSystem(IdParams.parse(request.params).id)) ?? fail(reply, 404, 'Extraction not found.'));
  // Export to Figma: a build plan the GapScan Importer plugin applies inside Figma. GapScan itself never writes to Figma.
  app.get('/v1/extractions/:id/figma-export.json', async (request, reply) => {
    const doc = await designSystem(IdParams.parse(request.params).id);
    if (!doc) return fail(reply, 404, 'Extraction not found.');
    return reply.type('application/json; charset=utf-8').header('content-disposition', `attachment; filename="${doc.name.replace(/[^\w.-]/g, '-')}.figma.json"`).send(JSON.stringify(buildFigmaPlan(doc), null, 1));
  });
  app.get('/v1/figma-plugin.zip', async (_request, reply) => {
    const dir = new URL('../../figma-plugin/', import.meta.url);
    const files = Object.fromEntries(await Promise.all(['manifest.json', 'code.js', 'ui.html'].map(async name => [`gapscan-importer/${name}`, await readFile(new URL(name, dir))] as const)));
    return reply.type('application/zip').header('content-disposition', 'attachment; filename="gapscan-importer.zip"').send(writeZip(files));
  });
  app.get('/v1/extractions/:id/design-system.html', async (request, reply) => {
    const doc = await designSystem(IdParams.parse(request.params).id);
    if (!doc) return fail(reply, 404, 'Extraction not found.');
    // ?embed=1 is the preview inside GapScan's result page, which has its own export actions.
    const embed = (request.query as {embed?: string}).embed === '1';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${renderDesignSystemHtml(doc, embed ? {} : {figmaExport: 'figma-export.json', reviewHref: `/app/review.html?id=${encodeURIComponent(IdParams.parse(request.params).id)}#export-figma`})}`;
    // No scripts at all; styles inline, fonts from Google Fonts only.
    return reply.type('text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:")
      .header('content-disposition', `${(request.query as {download?: string}).download ? 'attachment' : 'inline'}; filename="${doc.name.replace(/[^\w.-]/g, '-')}-design-system.html"`).send(html);
  });

  app.get('/v1/extractions/:id', async (request, reply) => {
    const record = await store.getExtraction(IdParams.parse(request.params).id);
    if (!record) return fail(reply, 404, 'Extraction not found.');
    if ((request.query as {include?: string}).include !== 'full') return record;
    const blob = await blobs.get(record.blobKey);
    return blob ? ExtractedDesignSystem.parse(JSON.parse(blob.toString('utf8'))) : fail(reply, 500, 'Stored extraction payload is missing.');
  });

  // ── Hand-offs and missing objects (architecture Part 3) ────────────────────
  app.get('/v1/extractions/:id/export', async (request, reply) => {
    const eds = await loadExtraction(store, blobs, IdParams.parse(request.params).id);
    if (!eds) return fail(reply, 404, 'Extraction not found.');
    const query = z.object({format: z.enum(['dtcg', 'css', 'tailwind4', 'scss']), palette: z.enum(['0', '1']).optional()}).safeParse(request.query);
    if (!query.success) return fail(reply, 400, 'Choose format=dtcg, css, tailwind4 or scss.');
    const format = EXPORT_FORMATS[query.data.format];
    return reply.type(`${format.type}; charset=utf-8`).header('content-disposition', `attachment; filename="${format.file}"`).send(exportTokens(eds, query.data.format, {includeInferredPalette: query.data.palette === '1'}));
  });

  app.get('/v1/extractions/:id/objects', async (request, reply) => {
    const {id} = IdParams.parse(request.params), eds = await loadExtraction(store, blobs, id);
    if (!eds) return fail(reply, 404, 'Extraction not found.');
    return buildObjects(eds, await readApprovals(blobs, id), await readDrafts(blobs, id));
  });

  // Approves exactly the content the reviewer saw; regenerated content shows as stale until re-approved.
  app.put('/v1/extractions/:id/objects/:kind/sections/:sectionId/approval', async (request, reply) => {
    const params = z.object({id: z.string().min(1), kind: ObjectKind, sectionId: z.string().min(1)}).safeParse(request.params);
    if (!params.success) return fail(reply, 404, 'Unknown object.');
    const body = parse(z.object({by: z.string().trim().min(1).max(200)}), request.body, reply); if (!body) return reply;
    const eds = await loadExtraction(store, blobs, params.data.id);
    if (!eds) return fail(reply, 404, 'Extraction not found.');
    const drafts = await readDrafts(blobs, params.data.id);
    const section = buildObjects(eds, {}, drafts).find(o => o.kind === params.data.kind)?.sections.find(s => s.id === params.data.sectionId);
    if (!section) return fail(reply, 404, 'Section not found.');
    const approvals = await readApprovals(blobs, params.data.id);
    approvals[`${params.data.kind}:${params.data.sectionId}`] = {by: body.by, at: new Date().toISOString(), hash: contentHash(section.content)};
    await blobs.put(approvalsKey(params.data.id), JSON.stringify(approvals));
    return buildObjects(eds, approvals, drafts).find(o => o.kind === params.data.kind);
  });

  // ── Drafting with Claude (only with GAPSCAN_AI=claude; every result waits for a person) ──
  app.get('/v1/ai', async () => ({enabled: Boolean(ai), ...(ai ? {provider: 'Anthropic', model: ai.model} : {})}));
  const SectionParams = z.object({id: z.string().min(1), kind: ObjectKind, sectionId: z.string().min(1)});
  app.post('/v1/extractions/:id/objects/:kind/sections/:sectionId/draft', async (request, reply) => {
    if (!ai) return fail(reply, 503, 'Drafting with Claude is not turned on for this GapScan.');
    const params = SectionParams.safeParse(request.params);
    if (!params.success) return fail(reply, 404, 'Unknown object.');
    const extraction = await store.getExtraction(params.data.id), eds = extraction && await loadExtraction(store, blobs, params.data.id);
    if (!extraction || !eds) return fail(reply, 404, 'Extraction not found.');
    const section = buildObjects(eds).find(o => o.kind === params.data.kind)?.sections.find(s => s.id === params.data.sectionId);
    if (!section) return fail(reply, 404, 'Section not found.');
    if (!isDraftable(section)) return fail(reply, 400, 'This section is read straight from your sources, so it is not redrafted.');
    const job = await store.createJob({type: 'generate', projectId: extraction.projectId, subjectId: eds.id, payload: {task: 'section', edsId: eds.id, kind: params.data.kind, sectionId: section.id}});
    await queue.enqueue(job);
    return reply.code(202).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });
  // Write every document (or the ones named) with Claude from the extraction, as one job.
  app.post('/v1/extractions/:id/documents', async (request, reply) => {
    if (!ai) return fail(reply, 503, 'Writing documents with AI isn’t turned on for this GapScan.');
    const {id} = IdParams.parse(request.params), extraction = await store.getExtraction(id);
    if (!extraction) return fail(reply, 404, 'Extraction not found.');
    const body = parse(z.object({kinds: z.array(ObjectKind).min(1).optional()}).default({}), request.body ?? {}, reply); if (!body) return reply;
    const job = await store.createJob({type: 'generate', projectId: extraction.projectId, subjectId: id, payload: {task: 'documents', edsId: id, ...(body.kinds ? {kinds: body.kinds} : {})}});
    await queue.enqueue(job);
    return reply.code(202).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });
  // Discards a draft: the section goes back to GapScan's generated text.
  app.delete('/v1/extractions/:id/objects/:kind/sections/:sectionId/draft', async (request, reply) => {
    const params = SectionParams.safeParse(request.params);
    if (!params.success) return fail(reply, 404, 'Unknown object.');
    const eds = await loadExtraction(store, blobs, params.data.id);
    if (!eds) return fail(reply, 404, 'Extraction not found.');
    const drafts = await readDrafts(blobs, eds.id);
    delete drafts[`${params.data.kind}:${params.data.sectionId}`];
    await blobs.put(draftsKey(eds.id), JSON.stringify(drafts));
    return buildObjects(eds, await readApprovals(blobs, eds.id), drafts).find(o => o.kind === params.data.kind);
  });

  // ── Application impact ────────────────────────────────────────────────────
  app.post('/v1/projects/:id/usage', async (request, reply) => {
    const {id: projectId} = IdParams.parse(request.params);
    const body = parse(z.object({edsId: z.string().min(1)}), request.body, reply); if (!body) return reply;
    const extraction = await store.getExtraction(body.edsId);
    if (!extraction || extraction.projectId !== projectId) return fail(reply, 404, 'Extraction not found in this project.');
    if (!(await store.listSources(projectId)).some(s => s.role === 'application')) return fail(reply, 400, 'Add application code to this project first.');
    const job = await store.createJob({type: 'usage', projectId, subjectId: body.edsId, payload: body});
    await queue.enqueue(job);
    return reply.code(202).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });
  app.get('/v1/projects/:id/usage', async (request, reply) => (await loadUsageReport(blobs, IdParams.parse(request.params).id)) ?? fail(reply, 404, 'No usage scan yet.'));

  // ── Figma Variables sync: preview first, then a confirmed apply of that exact plan ──
  const FigmaSync = z.object({fileUrl: z.string().url(), collection: z.string().trim().min(1).max(80).default('GapScan tokens')});
  const figmaCall = async (path: string, init: RequestInit = {}) => {
    const response = await (figma.fetch ?? fetch)(`https://api.figma.com/v1${path}`, {...init, headers: {'X-Figma-Token': figma.token!, 'content-type': 'application/json'}});
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {ok: response.ok, status: response.status, body};
  };
  const syncPlan = async (edsId: string, fileUrl: string, collection: string, reply: FastifyReply) => {
    if (!figma.token) { void fail(reply, 400, 'Figma is not connected. Set GAPSCAN_FIGMA_TOKEN on the server.'); return null; }
    const eds = await loadExtraction(store, blobs, edsId);
    if (!eds) { void fail(reply, 404, 'Extraction not found.'); return null; }
    let key: string;
    try { key = figmaFileKey(fileUrl); } catch (error) { void fail(reply, 400, (error as Error).message); return null; }
    const existing = await figmaCall(`/files/${key}/variables/local`);
    if (!existing.ok) { void fail(reply, existing.status === 403 ? 403 : 502, existing.status === 403 ? 'This account cannot read or write variables through the Figma API (it needs a plan with REST variable access and edit rights on the file).' : `Figma returned ${existing.status}.`); return null; }
    return {key, plan: planFigmaSync(eds, existing.body as ExistingVariables, collection)};
  };
  app.post('/v1/extractions/:id/figma-sync/plan', async (request, reply) => {
    const body = parse(FigmaSync, request.body, reply); if (!body) return reply;
    const result = await syncPlan(IdParams.parse(request.params).id, body.fileUrl, body.collection, reply);
    if (!result) return reply;
    const {payload: _payload, ...plan} = result.plan;
    return plan;
  });
  app.post('/v1/extractions/:id/figma-sync/apply', async (request, reply) => {
    const body = parse(FigmaSync.extend({hash: z.string().regex(/^[0-9a-f]{16}$/), confirm: z.literal(true)}), request.body, reply); if (!body) return reply;
    const result = await syncPlan(IdParams.parse(request.params).id, body.fileUrl, body.collection, reply);
    if (!result) return reply;
    if (result.plan.hash !== body.hash) return fail(reply, 409, 'The file or the tokens changed since the preview. Preview again before applying.');
    if (!result.plan.create.length && !result.plan.update.length) return {applied: false, message: 'Nothing to change.'};
    const written = await figmaCall(`/files/${result.key}/variables`, {method: 'POST', body: JSON.stringify(result.plan.payload)});
    if (!written.ok) return fail(reply, 502, `Figma refused the change (${written.status}).`);
    return {applied: true, created: result.plan.create.length, updated: result.plan.update.length, idMap: written.body.meta ?? null};
  });

  // ── Brand assets (architecture Part 3 §3.2) ──────────────────────────────
  app.get('/v1/templates', async () => Object.values(TEMPLATES));
  app.get('/v1/extractions/:id/brandkit', async (request, reply) => {
    const eds = await loadExtraction(store, blobs, IdParams.parse(request.params).id);
    return eds ? buildBrandKit(eds, String((request.query as {name?: string}).name ?? 'Your brand').slice(0, 80)) : fail(reply, 404, 'Extraction not found.');
  });
  const StartRender = z.object({template: z.string().refine(id => id in TEMPLATES, 'Unknown template.'), brandName: z.string().trim().max(80).optional(), data: z.record(z.string(), z.string().max(4000)).default({})});
  app.post('/v1/extractions/:id/assets', async (request, reply) => {
    const {id} = IdParams.parse(request.params), extraction = await store.getExtraction(id);
    if (!extraction) return fail(reply, 404, 'Extraction not found.');
    const body = parse(StartRender, request.body, reply); if (!body) return reply;
    const job = await store.createJob({type: 'render', projectId: extraction.projectId, subjectId: id, payload: {edsId: id, ...body}});
    await queue.enqueue(job);
    return reply.code(202).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });
  // The design-system book (PDF): the laid-out system plus approved documentation, rendered as a `render` job.
  app.post('/v1/extractions/:id/book', async (request, reply) => {
    const {id} = IdParams.parse(request.params), extraction = await store.getExtraction(id);
    if (!extraction) return fail(reply, 404, 'Extraction not found.');
    const project = await store.getProject(extraction.projectId);
    const job = await store.createJob({type: 'render', projectId: extraction.projectId, subjectId: id, payload: {edsId: id, template: BOOK, brandName: project?.name ?? 'Design system', data: {}}});
    await queue.enqueue(job);
    return reply.code(202).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });
  app.get('/v1/assets/:id', async (request, reply) => {
    const blob = await blobs.get(assetKey(IdParams.parse(request.params).id, 'manifest.json'));
    return blob ? JSON.parse(blob.toString('utf8')) : fail(reply, 404, 'Asset not found.');
  });
  app.get('/v1/assets/:id/file', async (request, reply) => {
    const {id} = IdParams.parse(request.params), manifest = await blobs.get(assetKey(id, 'manifest.json'));
    if (!manifest) return fail(reply, 404, 'Asset not found.');
    const {file, contentType} = JSON.parse(manifest.toString('utf8')) as {file: string; contentType: string};
    const bytes = await blobs.get(assetKey(id, file));
    // Generated HTML (emails) is served sandboxed: no scripts, no same-origin access, no network except images.
    if (contentType.startsWith('text/html')) reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https: data:");
    return bytes ? reply.type(contentType).header('content-disposition', `${(request.query as {download?: string}).download ? 'attachment' : 'inline'}; filename="${file}"`).send(bytes) : fail(reply, 404, 'Asset file missing.');
  });

  // ── GapScan (architecture Part 2) ─────────────────────────────────────────
  const StartGapScan = z.object({edsId: z.string().min(1), referenceId: z.string().min(1), assumptions: Assumptions.partial().optional()});
  const ApproveMatch = z.object({targetId: z.string().min(1).nullable(), by: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1000)});
  const loadReport = (id: string) => loadGapScan(store, blobs, id);

  app.get('/v1/library', async () => listReferences());
  app.get('/v1/library/:id', async (request, reply) => {
    const reference = await loadReference(IdParams.parse(request.params).id);
    if (!reference) return fail(reply, 404, 'Reference not found.');
    return {id: reference.id, library: reference.library, version: reference.libraryVersion, pinnedAt: reference.pinnedAt,
      sources: reference.sources.map(s => ({uri: s.uri, sha256: s.sha256})),
      components: reference.components.map(c => ({id: c.id, canonical: c.canonical, category: c.category, variants: c.variants.map(v => v.name), sizes: c.sizes, states: c.statesObserved}))};
  });

  // Recommends references by how much of your inventory each one covers; a suggestion, not a verdict.
  app.get('/v1/extractions/:id/recommendations', async (request, reply) => {
    const {id} = IdParams.parse(request.params);
    if (!await loadExtraction(store, blobs, id)) return fail(reply, 404, 'Extraction not found.');
    const ranked = [];
    for (const reference of await listReferences()) {
      const report = await computeReport(store, blobs, id, reference.id), mine = report.items.filter(i => i.decision !== 'optional');
      const covered = mine.filter(i => i.match.status !== 'unresolved').length;
      ranked.push({...reference, fit: mine.length ? Math.round(covered / mine.length * 100) : 0, covered, compared: mine.length, complexity: report.totals.complexity,
        reason: `${covered} of ${mine.length} of your components have a likely counterpart`});
    }
    return ranked.sort((a, b) => b.fit - a.fit || (a.complexity ?? 9) - (b.complexity ?? 9));
  });

  // Reports already run on this extraction, newest first, so people can get back to them.
  app.get('/v1/extractions/:id/gapscans', async (request, reply) => {
    const {id} = IdParams.parse(request.params);
    if (!await store.getExtraction(id)) return fail(reply, 404, 'Extraction not found.');
    return (await store.listGapScans(id)).map(r => ({id: r.id, referenceId: r.referenceId, createdAt: r.createdAt, updatedAt: r.updatedAt, summary: r.summary}));
  });

  app.post('/v1/gapscans', async (request, reply) => {
    const body = parse(StartGapScan, request.body, reply); if (!body) return reply;
    const extraction = await store.getExtraction(body.edsId);
    if (!extraction) return fail(reply, 404, 'Extraction not found.');
    if (!(await listReferences()).some(r => r.id === body.referenceId)) return fail(reply, 400, 'Choose a reference system from the library.');
    const job = await store.createJob({type: 'gapscan', projectId: extraction.projectId, subjectId: body.edsId, payload: body});
    await queue.enqueue(job);
    return reply.code(202).header('location', `/v1/jobs/${job.id}`).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });

  // The executive layer by default; per-item technical detail only with ?include=tech.
  app.get('/v1/gapscans/:id', async (request, reply) => {
    const loaded = await loadReport(IdParams.parse(request.params).id);
    if (!loaded) return fail(reply, 404, 'Report not found.');
    if ((request.query as {include?: string}).include === 'tech') return loaded.report;
    return {...loaded.report, items: loaded.report.items.map(({tech: _tech, ...item}) => item)};
  });

  app.get('/v1/gapscans/:id/items/:itemId/projection', async (request, reply) => {
    const {id, itemId} = z.object({id: z.string().min(1), itemId: z.string().min(1)}).parse(request.params);
    const loaded = await loadReport(id), item = loaded?.report.items.find(i => i.id === itemId);
    if (!loaded || !item) return fail(reply, 404, 'Item not found.');
    const reference = await loadReference(loaded.report.reference.id), specimen = reference?.specimens.find(s => s.id === item.afterSpecimenId);
    if (!specimen?.css) return fail(reply, 404, 'The reference has no example for this component.');
    const projected = projectSpecimen(specimen.css, (item.tech?.tokenDiff ?? []) as {before: string; after: string | null; change: string}[]);
    return {html: specimen.html ?? '', css: projected.css, origin: 'projected', substitutions: projected.substitutions};
  });

  // Totals are recalculated on the server only, so every view and export shows the same numbers.
  app.put('/v1/gapscans/:id/assumptions', async (request, reply) => {
    const loaded = await loadReport(IdParams.parse(request.params).id);
    if (!loaded) return fail(reply, 404, 'Report not found.');
    const body = parse(Assumptions.partial(), request.body, reply); if (!body) return reply;
    const assumptions = Assumptions.parse({...loaded.report.assumptions, ...body});
    const report = {...loaded.report, assumptions, totals: planningTotals(loaded.report.items, loaded.report.tokenCategories, assumptions)};
    await saveReport(store, blobs, report, loaded.record.projectId, loaded.record.extractionId, loaded.record.createdAt);
    return {assumptions, totals: report.totals, summary: summarize(report)};
  });

  // A reviewer confirms or overrides a mapping; the scan re-runs so decisions and totals follow.
  app.put('/v1/gapscans/:id/matches/:sourceId', async (request, reply) => {
    const {id, sourceId} = z.object({id: z.string().min(1), sourceId: z.string().min(1)}).parse(request.params);
    const loaded = await loadReport(id);
    if (!loaded) return fail(reply, 404, 'Report not found.');
    const body = parse(ApproveMatch, request.body, reply); if (!body) return reply;
    if (!loaded.report.items.some(i => i.match.sourceId === sourceId)) return fail(reply, 404, 'That component is not in this report.');
    await store.saveApproval({key: approvalKey(loaded.report.edsFingerprint, loaded.report.reference.id, sourceId), edsFingerprint: loaded.report.edsFingerprint,
      referenceId: loaded.report.reference.id, sourceId, targetId: body.targetId, by: body.by, reason: body.reason, at: new Date().toISOString()});
    const report = {id, ...await computeReport(store, blobs, loaded.record.extractionId, loaded.report.reference.id, loaded.report.assumptions)};
    await saveReport(store, blobs, report, loaded.record.projectId, loaded.record.extractionId, loaded.record.createdAt);
    return {item: report.items.find(i => i.match.sourceId === sourceId), totals: report.totals, summary: summarize(report)};
  });

  // Claude's suggested counterpart for a component GapScan couldn't settle. Approving it goes
  // through PUT …/matches/:sourceId like any reviewer decision.
  app.post('/v1/gapscans/:id/matches/:sourceId/suggestion', async (request, reply) => {
    if (!ai) return fail(reply, 503, 'Drafting with Claude is not turned on for this GapScan.');
    const {id, sourceId} = z.object({id: z.string().min(1), sourceId: z.string().min(1)}).parse(request.params);
    const loaded = await loadReport(id), item = loaded?.report.items.find(i => i.match.sourceId === sourceId);
    if (!loaded || !item) return fail(reply, 404, 'That component is not in this report.');
    if (item.match.status === 'confirmed') return fail(reply, 400, 'This match is already confirmed.');
    if (sourceId.startsWith('target:')) return fail(reply, 400, 'This component exists only in the reference system.');
    const job = await store.createJob({type: 'generate', projectId: loaded.record.projectId, subjectId: id, payload: {task: 'match', gapscanId: id, sourceId}});
    await queue.enqueue(job);
    return reply.code(202).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });
  app.get('/v1/gapscans/:id/suggestions', async (request, reply) => {
    const {id} = IdParams.parse(request.params);
    if (!await store.getGapScan(id)) return fail(reply, 404, 'Report not found.');
    return readSuggestions(blobs, id);
  });

  // ── Codemods: a dry run on the application's code, and the same rewriter as a script ──
  app.post('/v1/gapscans/:id/codemod', async (request, reply) => {
    const loaded = await loadReport(IdParams.parse(request.params).id);
    if (!loaded) return fail(reply, 404, 'Report not found.');
    if (!(await store.listSources(loaded.record.projectId)).some(s => s.role === 'application')) return fail(reply, 400, 'Add application code to this project first.');
    const job = await store.createJob({type: 'codemod', projectId: loaded.record.projectId, subjectId: loaded.report.id, payload: {gapscanId: loaded.report.id}});
    await queue.enqueue(job);
    return reply.code(202).send({jobId: job.id, events: `/v1/jobs/${job.id}/events`});
  });
  app.get('/v1/gapscans/:id/codemod', async (request, reply) => (await loadCodemodRun(blobs, IdParams.parse(request.params).id)) ?? fail(reply, 404, 'No dry run yet.'));
  // Rules only, no application code needed: what the script will change and what it leaves to a person.
  app.get('/v1/gapscans/:id/codemod/rules', async (request, reply) => {
    const loaded = await loadReport(IdParams.parse(request.params).id);
    if (!loaded) return fail(reply, 404, 'Report not found.');
    return codemodPlan(store, blobs, loaded.report, loaded.record);
  });
  app.get('/v1/gapscans/:id/codemod.mjs', async (request, reply) => {
    const loaded = await loadReport(IdParams.parse(request.params).id);
    if (!loaded) return fail(reply, 404, 'Report not found.');
    const plan = await codemodPlan(store, blobs, loaded.report, loaded.record), reference = await loadReference(loaded.report.reference.id);
    const script = await buildScript(plan, {reportId: loaded.report.id, library: reference?.library ?? loaded.report.reference.id, version: loaded.report.reference.version, generatedAt: new Date().toISOString()});
    return reply.type('text/javascript; charset=utf-8').header('content-disposition', 'attachment; filename="gapscan-codemod.mjs"').send(script);
  });

  return app;
}
