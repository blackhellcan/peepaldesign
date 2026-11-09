import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configFromEnv, createInfra} from '@gapscan/infra';
import type {Infra} from '@gapscan/infra';
import {GapScanReport} from '@gapscan/schema';
import type {ExtractedDesignSystem, JobEvent} from '@gapscan/schema';
import {buildApp, MAX_CODE_BYTES} from '../src/app.ts';
import {createExtractHandler} from '../src/extract-job.ts';

const CSS = ':root{--brand:#0B5FD6;--space-2:8px;--alias:var(--missing)} .btn{background:var(--brand);padding:4px} .btn:hover{background:#004} .card{border-radius:4px}';

async function harness(options: {stageDelayMs?: number} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-api-'));
  const infra: Infra = await createInfra({...configFromEnv({}), dataDir});
  const app = buildApp({infra, handlers: {extract: createExtractHandler({store: infra.store, blobs: infra.blobs, stageDelayMs: options.stageDelayMs ?? 0})}, heartbeatMs: 50});
  const json = async <T = any>(method: string, url: string, payload?: unknown) => {
    const response = await app.inject({method: method as 'GET', url, ...(payload === undefined ? {} : {payload: payload as object})});
    return {status: response.statusCode, body: (response.body ? JSON.parse(response.body) : null) as T};
  };
  const project = (await json('POST', '/v1/projects', {name: 'Acme'})).body as {id: string};
  const close = async () => { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); };
  return {app, infra, json, project, close};
}

// Minimal SSE reader: returns parsed events until the server ends the stream.
async function readEvents(base: string, jobId: string, lastEventId?: number, limit = Infinity): Promise<JobEvent[]> {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/jobs/${jobId}/events`, {headers: lastEventId ? {'last-event-id': String(lastEventId)} : {}, signal: controller.signal});
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events: JobEvent[] = [], decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, {stream: true});
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as JobEvent);
        if (events.length >= limit) { controller.abort(); return events; }
      }
    }
  } catch (error) { if (!controller.signal.aborted) throw error; }
  return events;
}

test('pasted code becomes a versioned, schema-valid extraction with plain-language findings', async () => {
  const h = await harness();
  try {
    assert.equal((await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS})).status, 201);
    const started = await h.json('POST', `/v1/projects/${h.project.id}/extractions`);
    assert.equal(started.status, 202);
    await h.infra.queue.idle();
    const job = (await h.json('GET', `/v1/jobs/${started.body.jobId}`)).body;
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    const summary = (await h.json('GET', `/v1/extractions/${job.resultId}`)).body;
    assert.equal(summary.version, 1);
    const eds = (await h.json<ExtractedDesignSystem>('GET', `/v1/extractions/${job.resultId}?include=full`)).body;
    assert.ok(eds.tokens.some(t => t.path === '--brand' && t.type === 'color' && t.status === 'resolved'));
    assert.ok(eds.tokens.some(t => t.path === '--alias' && t.status === 'unresolved'));
    const button = eds.components.find(c => c.rawNames.includes('btn'));
    assert.equal(button?.category, 'Actions');
    assert.deepEqual(button?.statesObserved, ['hover']);
    assert.ok(eds.quirks.some(q => q.kind === 'missing_state' && /keyboard focus/.test(q.summary)));
    assert.ok(eds.quirks.some(q => q.kind === 'unresolved_value'));
    assert.ok(eds.evidence.every(e => e.trust === 'declared' || e.trust === 'observed'));

    const again = await h.json('POST', `/v1/projects/${h.project.id}/extractions`);
    await h.infra.queue.idle();
    const second = (await h.json('GET', `/v1/jobs/${again.body.jobId}`)).body;
    const secondSummary = (await h.json('GET', `/v1/extractions/${second.resultId}`)).body;
    assert.equal(secondSummary.version, 2);
    assert.equal(secondSummary.fingerprint, summary.fingerprint, 'identical inputs give an identical fingerprint');
  } finally { await h.close(); }
});

test('source intake rejects private URLs and oversized code, and accepts public URLs without fetching', async () => {
  const h = await harness();
  try {
    for (const uri of ['http://example.com', 'https://localhost/x', 'https://192.168.1.4/', 'https://intranet.local/'])
      assert.equal((await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'url', uri})).status, 400, uri);
    assert.equal((await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'url', uri: 'https://polaris.shopify.com/components'})).status, 201);
    assert.equal((await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'big.css', content: 'a'.repeat(MAX_CODE_BYTES + 1)})).status, 413);
    assert.equal((await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: '../etc/passwd', content: 'x'})).status, 400);
    assert.equal((await h.json('POST', '/v1/projects/nope/sources', {kind: 'code', name: 'a.css', content: 'x'})).status, 404);
    const emptyJson = await h.app.inject({method: 'POST', url: `/v1/projects/${h.project.id}/extractions`, headers: {'content-type': 'application/json'}, payload: ''});
    assert.equal(emptyJson.statusCode, 202, 'an empty JSON body on an action endpoint is accepted');
    const broken = await h.app.inject({method: 'POST', url: '/v1/projects', headers: {'content-type': 'application/json'}, payload: '{name:'});
    assert.equal(broken.statusCode, 400);
    await h.infra.queue.idle();
  } finally { await h.close(); }
});

test('unreadable sources are reported honestly: alone they fail the job, alongside code they become coverage gaps', async () => {
  const h = await harness();
  try {
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'url', uri: 'https://polaris.shopify.com/components'});
    const urlOnly = await h.json('POST', `/v1/projects/${h.project.id}/extractions`);
    await h.infra.queue.idle();
    const failed = (await h.json('GET', `/v1/jobs/${urlOnly.body.jobId}`)).body;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.message, /nothing to extract/);

    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const mixed = await h.json('POST', `/v1/projects/${h.project.id}/extractions`);
    await h.infra.queue.idle();
    const job = (await h.json('GET', `/v1/jobs/${mixed.body.jobId}`)).body;
    assert.equal(job.status, 'completed');
    const eds = (await h.json<ExtractedDesignSystem>('GET', `/v1/extractions/${job.resultId}?include=full`)).body;
    assert.ok(eds.quirks.some(q => q.kind === 'coverage_gap' && /not configured/.test(q.summary)));
    const events = await h.infra.store.listEvents(job.id);
    assert.ok(events.some(e => e.body.type === 'progress' && /^Skipped polaris/.test(e.body.message)), 'a skipped source is never reported as read');
    assert.equal(eds.coverage.perAsset.filter(a => a.failed.length).length, 1);
    assert.ok((await h.infra.store.listEvents(job.id)).some(e => e.body.type === 'warning'));
  } finally { await h.close(); }
});

test('SSE streams to the terminal event and resumes from Last-Event-ID without duplicates', async () => {
  const h = await harness({stageDelayMs: 30});
  try {
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const base = await h.app.listen({port: 0, host: '127.0.0.1'});
    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;

    const firstTwo = await readEvents(base, jobId, undefined, 2);       // client drops after two events
    assert.deepEqual(firstTwo.map(e => e.seq), [1, 2]);
    const rest = await readEvents(base, jobId, firstTwo.at(-1)!.seq);   // reconnect with the last id seen
    assert.equal(rest[0]?.seq, 3, 'resumes right after the last event seen');
    assert.equal(rest.at(-1)?.body.type, 'complete');
    const all = [...firstTwo, ...rest].map(e => e.seq);
    assert.deepEqual(all, all.map((_, i) => i + 1), 'no gaps and no duplicates');

    assert.deepEqual(await readEvents(base, jobId, rest.at(-1)!.seq), [], 'after the end, a resume closes immediately');
    assert.equal((await readEvents(base, jobId)).length, all.length, 'a fresh client replays the whole history');
  } finally { await h.close(); }
});

test('a running extraction can be cancelled, and the stream ends with a cancelled event', async () => {
  const h = await harness({stageDelayMs: 200});
  try {
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const base = await h.app.listen({port: 0, host: '127.0.0.1'});
    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
    const streamed = readEvents(base, jobId);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await h.json('DELETE', `/v1/jobs/${jobId}`)).status, 202);
    const events = await streamed;
    assert.equal(events.at(-1)?.body.type, 'cancelled');
    assert.equal((await h.json('GET', `/v1/jobs/${jobId}`)).body.status, 'cancelled');
    assert.equal((await h.json('DELETE', `/v1/jobs/${jobId}`)).status, 409, 'cannot cancel twice');
  } finally { await h.close(); }
});

test('uploaded PPTX, PDF and zipped code go through their adapters into one extraction', async () => {
  const {pptx} = await import('../../../packages/adapters/test/fixtures.ts');
  const {brandPdf} = await import('../../../packages/adapters/test/pdf-fixture.ts');
  const {writeZip} = await import('@gapscan/adapters');
  const h = await harness();
  try {
    const upload = (name: string, data: Uint8Array) => h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'file', name, base64: Buffer.from(data).toString('base64')});
    assert.equal((await upload('brand.pptx', pptx())).body.kind, 'pptx');
    assert.equal((await upload('guide.pdf', brandPdf([{lines: [[28, 'Colour'], [11, 'Primary Blue'], [11, 'HEX #0052CC']]}]))).body.kind, 'pdf');
    assert.equal((await upload('site.zip', writeZip({'src/tokens.css': ':root{--brand:#0B5FD6} .btn{background:#0B5FD6;color:#fff;padding:8px 16px}', 'node_modules/x/y.css': '.junk{color:red}'}))).body.kind, 'zip');
    assert.equal((await upload('photo.heic', new Uint8Array([1]))).status, 415);
    // Without a Figma token, a Figma link is refused when added, with what to do instead.
    assert.deepEqual((await h.json('GET', '/v1/figma')).body, {connected: false});
    const figma = await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'url', uri: 'https://www.figma.com/design/AbCdEf1234567890/Acme'});
    assert.equal(figma.status, 400);
    assert.match(figma.body.error, /isn’t connected to Figma/);

    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
    await h.infra.queue.idle();
    const job = (await h.json('GET', `/v1/jobs/${jobId}`)).body;
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    const eds = (await h.json<ExtractedDesignSystem>('GET', `/v1/extractions/${job.resultId}?include=full`)).body;
    assert.ok(eds.tokens.some(t => t.path === 'font.family.heading' && t.value === 'Inter Display'), 'deck heading font');
    assert.ok(eds.tokens.some(t => t.path === '--brand'), 'zipped CSS token');
    assert.ok(!eds.evidence.some(e => /node_modules/.test(e.locator)), 'dependency folders are skipped');
    assert.ok(eds.quirks.some(q => q.kind === 'declared_observed_drift'), 'guide and deck blue differ from the site blue');

    const scales = (await h.json('GET', `/v1/extractions/${job.resultId}/scales`)).body;
    assert.ok(Array.isArray(scales.colors) && scales.colors.length > 0);
  } finally { await h.close(); }
});

test('the extraction UI is served with a CSP and nothing outside its folder is reachable', async () => {
  const h = await harness();
  try {
    const page = await h.app.inject({method: 'GET', url: '/app/'});
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'] as string, /default-src 'self'/);
    assert.match(page.body, /See your design system clearly/);
    assert.equal((await h.app.inject({method: 'GET', url: '/app/review.js'})).statusCode, 200);
    for (const url of ['/app/../src/app.ts', '/app/..%2Fpackage.json', '/app/secret.txt', '/app/%2e%2e/%2e%2e/package.json'])
      assert.equal((await h.app.inject({method: 'GET', url})).statusCode, 404, url);
    assert.equal((await h.app.inject({method: 'GET', url: '/'})).headers.location, '/app/');
  } finally { await h.close(); }
});

test('GapScan: recommend a reference, run the scan, adjust assumptions server-side and approve a mapping', async () => {
  const h = await harness();
  try {
    const css = `:root { --brand: #0B5FD6 }
.btn { padding: 8px 16px; border-radius: 4px } .btn-primary { background: #0B5FD6; color: #fff } .btn-ghost { background: none } .btn-sm { padding: 4px 8px } .btn-lg { padding: 12px 24px }
.btn:hover { opacity: .9 } .btn:disabled { opacity: .5 }
.text-field { border: 1px solid #ccc } .text-field:focus-visible { outline: 2px solid #0B5FD6 } .text-field:disabled { opacity: .5 }
.carousel { display: flex } .carousel-item { flex: 1 } .carousel-item-next {}`;
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: css});
    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
    await h.infra.queue.idle();
    const edsId = (await h.json('GET', `/v1/jobs/${jobId}`)).body.resultId;

    const library = (await h.json('GET', '/v1/library')).body;
    assert.ok(library.some((r: {id: string}) => r.id === 'polaris-13.9.5'));
    const ranked = (await h.json('GET', `/v1/extractions/${edsId}/recommendations`)).body;
    assert.equal(ranked.length, library.length);
    assert.ok(ranked.every((r: {fit: number}, i: number) => i === 0 || ranked[i - 1].fit >= r.fit), 'ranked by fit');

    assert.equal((await h.json('POST', '/v1/gapscans', {edsId, referenceId: 'nope'})).status, 400);
    const started = await h.json('POST', '/v1/gapscans', {edsId, referenceId: 'polaris-13.9.5', assumptions: {rate: 100}});
    assert.equal(started.status, 202);
    await h.infra.queue.idle();
    const gapscanJob = (await h.json('GET', `/v1/jobs/${started.body.jobId}`)).body;
    assert.equal(gapscanJob.status, 'completed', JSON.stringify(gapscanJob.error));
    const reportId = gapscanJob.resultId;
    assert.deepEqual((await h.json('GET', `/v1/extractions/${edsId}/gapscans`)).body.map((r: {id: string; referenceId: string}) => [r.id, r.referenceId]), [[reportId, 'polaris-13.9.5']], 'reports are listed on their extraction');
    assert.equal((await h.json('GET', '/v1/extractions/nope/gapscans')).status, 404);

    const executive = (await h.json('GET', `/v1/gapscans/${reportId}`)).body;
    GapScanReport.parse(executive);
    assert.ok(executive.items.every((i: {tech?: unknown}) => i.tech === undefined), 'technical detail is opt-in');
    const button = executive.items.find((i: {name: string}) => /btn/i.test(i.name));
    assert.ok(button, 'the button was compared');
    assert.notEqual(button.match.targetId, null);
    assert.equal(executive.assumptions.rate, 100);
    const withTech = (await h.json('GET', `/v1/gapscans/${reportId}?include=tech`)).body;
    assert.ok(withTech.items.some((i: {tech?: unknown}) => i.tech));

    const before = executive.totals;
    const changed = (await h.json('PUT', `/v1/gapscans/${reportId}/assumptions`, {apps: 3})).body;
    assert.equal(changed.assumptions.apps, 3);
    assert.ok(changed.totals.low === 0 || changed.totals.low > before.low, 'more applications, more hours');
    assert.equal((await h.json('GET', `/v1/gapscans/${reportId}`)).body.totals.low, changed.totals.low, 'saved, not just returned');

    const unresolved = executive.items.find((i: {decision: string}) => i.decision === 'replace' || i.decision === 'check_first');
    if (unresolved) {
      const approved = (await h.json('PUT', `/v1/gapscans/${reportId}/matches/${encodeURIComponent(unresolved.match.sourceId)}`, {targetId: null, by: 'pm@example.com', reason: 'Build a custom carousel'})).body;
      assert.equal(approved.item.match.status, 'confirmed');
      assert.equal(approved.item.match.approvedBy, 'pm@example.com');
    }
    assert.equal((await h.json('PUT', `/v1/gapscans/${reportId}/matches/unknown`, {targetId: null, by: 'x', reason: 'y'})).status, 404);
  } finally { await h.close(); }
});

test('token exports download in every format, and object sections can be approved', async () => {
  const h = await harness();
  try {
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
    await h.infra.queue.idle();
    const edsId = (await h.json('GET', `/v1/jobs/${jobId}`)).body.resultId;
    for (const [format, pattern] of [['dtcg', /"brand"/], ['css', /:root \{/], ['tailwind4', /@theme \{/], ['scss', /\$brand: /]] as const) {
      const response = await h.app.inject({method: 'GET', url: `/v1/extractions/${edsId}/export?format=${format}`});
      assert.equal(response.statusCode, 200, format);
      assert.match(response.headers['content-disposition'] as string, /attachment; filename=/);
      assert.match(response.body, pattern, format);
    }
    assert.equal((await h.app.inject({method: 'GET', url: `/v1/extractions/${edsId}/export?format=xml`})).statusCode, 400);

    const objects = (await h.json('GET', `/v1/extractions/${edsId}/objects`)).body;
    assert.equal(objects.length, 6);
    const before = objects.find((o: {kind: string}) => o.kind === 'accessibility').completeness;
    const approved = (await h.json('PUT', `/v1/extractions/${edsId}/objects/accessibility/sections/target/approval`, {by: 'pm@example.com'})).body;
    assert.equal(approved.sections.find((s: {id: string}) => s.id === 'target').approval.by, 'pm@example.com');
    assert.ok(approved.completeness > before);
    assert.equal((await h.json('GET', `/v1/extractions/${edsId}/objects`)).body.find((o: {kind: string}) => o.kind === 'accessibility').completeness, approved.completeness, 'saved');
    assert.equal((await h.json('PUT', `/v1/extractions/${edsId}/objects/nope/sections/target/approval`, {by: 'x'})).status, 404);
  } finally { await h.close(); }
});

test('brand assets render through the job system with their checks', {timeout: 90_000}, async t => {
  const hasBrowser = await import('playwright').then(p => p.chromium.launch().then(b => b.close()).then(() => true)).catch(() => false);
  if (!hasBrowser) { t.skip('Chromium for Playwright is not installed'); return; }
  const h = await harness();
  try {
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
    await h.infra.queue.idle();
    const edsId = (await h.json('GET', `/v1/jobs/${jobId}`)).body.resultId;
    assert.ok((await h.json('GET', '/v1/templates')).body.some((t: {id: string}) => t.id === 'business-card'));
    assert.equal((await h.json('POST', `/v1/extractions/${edsId}/assets`, {template: 'poster'})).status, 400);
    const started = await h.json('POST', `/v1/extractions/${edsId}/assets`, {template: 'business-card', brandName: 'Acme', data: {name: 'Jordan Lee', role: 'Product Lead'}});
    assert.equal(started.status, 202);
    await h.infra.queue.idle();
    assert.equal((await h.json('GET', `/v1/jobs/${started.body.jobId}`)).body.status, 'completed');
    const manifest = (await h.json('GET', `/v1/assets/${started.body.jobId}`)).body;
    assert.equal(manifest.file, 'business-card.pdf');
    assert.ok(manifest.checks.some((c: {rule: string}) => c.rule === 'name-contrast'));
    const file = await h.app.inject({method: 'GET', url: `/v1/assets/${started.body.jobId}/file?download=1`});
    assert.equal(file.headers['content-type'], 'application/pdf');
    assert.match(file.headers['content-disposition'] as string, /attachment/);
    assert.equal(file.rawPayload.subarray(0, 5).toString(), '%PDF-');
  } finally { await h.close(); }
});

test('generated email HTML is served sandboxed', async () => {
  const h = await harness();
  try {
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
    await h.infra.queue.idle();
    const edsId = (await h.json('GET', `/v1/jobs/${jobId}`)).body.resultId;
    const started = await h.json('POST', `/v1/extractions/${edsId}/assets`, {template: 'email', data: {title: '<img src=x onerror=alert(1)>'}});
    await h.infra.queue.idle();
    const file = await h.app.inject({method: 'GET', url: `/v1/assets/${started.body.jobId}/file`});
    assert.match(file.headers['content-security-policy'] as string, /^sandbox; default-src 'none'/);
    assert.doesNotMatch(file.body, /<img src=x/);
  } finally { await h.close(); }
});

test('Figma Variables sync previews without writing and applies only the confirmed plan', async () => {
  const calls: {method: string; url: string; body?: unknown}[] = [];
  let variables = {meta: {variables: {}, variableCollections: {}}};
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({method, url: String(url), body});
    if (method === 'GET') return new Response(JSON.stringify(variables), {status: 200});
    return new Response(JSON.stringify({status: 200, meta: {tempIdToRealId: {}}}), {status: 200});
  }) as typeof fetch;
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-api-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const app = buildApp({infra, figma: {token: 'test-token', fetch: fakeFetch}});
  const json = async (method: string, url: string, payload?: object) => { const r = await app.inject({method: method as 'GET', url, ...(payload ? {payload} : {})}); return {status: r.statusCode, body: JSON.parse(r.body)}; };
  try {
    const project = (await json('POST', '/v1/projects', {name: 'Acme'})).body;
    await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const {jobId} = (await json('POST', `/v1/projects/${project.id}/extractions`)).body;
    await infra.queue.idle();
    const edsId = (await json('GET', `/v1/jobs/${jobId}`)).body.resultId;
    const fileUrl = 'https://www.figma.com/design/AbCdEf1234567890/Acme';
    const plan = (await json('POST', `/v1/extractions/${edsId}/figma-sync/plan`, {fileUrl})).body;
    assert.ok(plan.create.length > 0);
    assert.equal(plan.payload, undefined, 'the raw payload is not exposed');
    assert.ok(calls.every(c => c.method === 'GET'), 'previewing never writes');
    assert.equal((await json('POST', `/v1/extractions/${edsId}/figma-sync/apply`, {fileUrl, hash: plan.hash})).status, 400, 'explicit confirmation required');
    assert.equal((await json('POST', `/v1/extractions/${edsId}/figma-sync/apply`, {fileUrl, hash: '0'.repeat(16), confirm: true})).status, 409, 'a stale plan is refused');
    const applied = (await json('POST', `/v1/extractions/${edsId}/figma-sync/apply`, {fileUrl, hash: plan.hash, confirm: true})).body;
    assert.equal(applied.applied, true);
    const write = calls.find(c => c.method === 'POST')!;
    assert.equal(write.url, 'https://api.figma.com/v1/files/AbCdEf1234567890/variables');
    assert.ok((write.body as {variables: unknown[]}).variables.length === plan.create.filter((c: {mode: string}) => c.mode === 'Light').length);
    variables = {meta: {variables: {}, variableCollections: {}}};
    const noToken = buildApp({infra, figma: {}});
    assert.equal((await noToken.inject({method: 'POST', url: `/v1/extractions/${edsId}/figma-sync/plan`, payload: {fileUrl}})).statusCode, 400);
  } finally { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('projects: listed newest activity first with what is in them, and renamed', async () => {
  const h = await harness();
  try {
    const other = (await h.json('POST', '/v1/projects', {name: 'Beta'})).body;
    await new Promise(resolve => setTimeout(resolve, 5));   // timestamps are to the millisecond
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
    const listed = (await h.json('GET', '/v1/projects')).body;
    assert.deepEqual(listed.map((p: {name: string}) => p.name), ['Acme', 'Beta'], 'adding a source is activity');
    assert.equal(listed[0].sources, 1);
    assert.equal(listed[0].extractions, 0);
    assert.equal(listed[0].latestExtraction, null);
    const renamed = await h.json('PATCH', `/v1/projects/${other.id}`, {name: '  Brand refresh  '});
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Brand refresh');
    assert.equal((await h.json('GET', `/v1/projects/${other.id}`)).body.name, 'Brand refresh');
    assert.equal((await h.json('PATCH', `/v1/projects/${other.id}`, {name: ' '})).status, 400);
    assert.equal((await h.json('PATCH', '/v1/projects/nope', {name: 'x'})).status, 404);
  } finally { await h.close(); }
});

test('typefaces set without a size still count, and what is missing is listed so people can add it', async () => {
  const h = await harness();
  try {
    await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'added.css', content: ':root { --color-brand: #7C3AED; }\nbody { font-family: Inter, sans-serif; }\nh1, h2, h3 { font-family: "Playfair Display", serif; }\n.btn { padding: 8px 16px; background: var(--color-brand); }'});
    const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
    await h.infra.queue.idle();
    const edsId = (await h.json('GET', `/v1/jobs/${jobId}`)).body.resultId;
    const eds = (await h.json('GET', `/v1/extractions/${edsId}?include=full`)).body;
    const family = (role: string) => eds.tokens.find((t: {path: string}) => t.path === `font.family.${role}`)?.value;
    assert.equal(family('body'), 'Inter');
    assert.equal(family('heading'), 'Playfair Display');
    const missing = (await h.json('GET', `/v1/extractions/${edsId}/missing`)).body;
    assert.ok(!missing.components.includes('Button'), 'a .btn counts as a Button');
    assert.ok(missing.components.includes('Checkbox'));
    assert.ok(!missing.foundations.includes('Typefaces') && !missing.foundations.includes('Colours'));
    assert.equal((await h.json('GET', '/v1/extractions/nope/missing')).status, 404);
  } finally { await h.close(); }
});

test('website readers: GapScan’s browser always; Scrapling refused with a reason when it isn’t installed', async () => {
  const h = await harness();
  try {
    const readers = (await h.json('GET', '/v1/readers')).body;
    assert.deepEqual(readers.map((r: {id: string}) => r.id), ['default', 'scrapling']);
    assert.equal(readers[0].available, true);
    if (!readers[1].available) {
      assert.ok(readers[1].reason, 'says why it is off');
      const refused = await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'url', uri: 'https://example.com/', reader: 'scrapling'});
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /Use GapScan’s own reader/);
    }
    const plain = (await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'url', uri: 'https://example.com/'})).body;
    assert.equal(plain.reader, undefined, 'the default reader is not written down');
  } finally { await h.close(); }
});

test('typefaces given through CSS variables are looked up, and unresolvable ones are left out', async () => {
  const read = async (css: string) => {
    const h = await harness();
    try {
      await h.json('POST', `/v1/projects/${h.project.id}/sources`, {kind: 'code', name: 'vars.css', content: css});
      const {jobId} = (await h.json('POST', `/v1/projects/${h.project.id}/extractions`)).body;
      await h.infra.queue.idle();
      const eds = (await h.json('GET', `/v1/extractions/${(await h.json('GET', `/v1/jobs/${jobId}`)).body.resultId}?include=full`)).body;
      return (role: string) => eds.tokens.find((t: {path: string}) => t.path === `font.family.${role}`)?.value;
    } finally { await h.close(); }
  };
  const family = await read(':root { --brand-font: "Mona Sans", sans-serif; --heading: var(--brand-font); }\nh1, h2 { font-family: var(--heading); }\nbody { font-family: var(--missing, Georgia, serif); }');
  assert.equal(family('heading'), 'Mona Sans', 'followed through two variables');
  assert.equal(family('body'), 'Georgia', 'the fallback when the variable is not declared');
  const unresolved = await read('body { font-family: var(--nowhere); }');
  assert.equal(unresolved('body'), undefined, 'never shown as var(...)');
});

test('components named differently still count as found (Radio button, Dropdown, Notification, Expander)', async () => {
  const {missingItems} = await import('../src/missing.ts');
  const component = (canonical: string) => ({id: canonical, canonical, rawNames: [canonical], category: 'Misc', tier: 'primary', variants: [], sizes: [], statesObserved: [], statesMissing: [], a11y: {focusVisible: null}, instances: 1, evidence: [], confidence: 0.8});
  const eds = {tokens: [], components: ['Radio button', 'Dropdown', 'Notification', 'Expander', 'Toggle Switch', 'Check-box element'].map(component)} as unknown as Parameters<typeof missingItems>[0];
  const missing = missingItems(eds).components;
  for (const name of ['Radio', 'Select', 'Alert', 'Accordion', 'Switch', 'Checkbox']) assert.ok(!missing.includes(name), `${name} counts as found`);
  assert.ok(missing.includes('Modal'), 'nothing like a modal was given');
});
