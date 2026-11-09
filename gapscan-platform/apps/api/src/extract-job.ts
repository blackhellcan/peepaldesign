// The `extract` job: every source in a project → its adapter → one versioned
// ExtractedDesignSystem (architecture Part 1). Sources that cannot be read are
// recorded as coverage gaps; the job fails only when nothing at all was readable.
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {codeAdapter, createFigmaAdapter, docxAdapter, openZip, pdfAdapter, pptxAdapter, imageAdapter} from '@gapscan/adapters';
import type {Adapter, AdapterResult} from '@gapscan/adapters';
import {assembleSystem, systemFingerprint} from '@gapscan/extraction';
import type {AssetResult, ExternalComponent} from '@gapscan/extraction';
import {ExtractedDesignSystem} from '@gapscan/schema';
import type {SourceAsset, SourceKind} from '@gapscan/schema';
import type {BlobStore, JobHandler, Store} from '@gapscan/infra';
import {extractCode} from './legacy-bridge.ts';
import type {CodeDocument} from './legacy-bridge.ts';

export const CODE_FILE = /\.(?:css|scss|sass|less|json|html?|jsx?|tsx?|mjs|vue|svelte|md|mdx|txt)$/i;
const NOT_SUPPORTED: Partial<Record<SourceKind, string>> = {
  url: 'Rendered website extraction is not configured on this server. Paste or upload the site\'s CSS/HTML instead.',
};

export type ExtractOptions = {store: Store; blobs: BlobStore; stageDelayMs?: number; figmaToken?: string; urlAdapter?: Adapter; scraplingAdapter?: Adapter};

// Unzips code archives into documents for both the native foundations adapter and the component bridge.
function codeDocuments(source: SourceAsset, bytes: Buffer): CodeDocument[] {
  if (source.kind !== 'zip') return [{assetId: source.id, name: source.label ?? source.id, content: bytes.toString('utf8')}];
  const zip = openZip(bytes);
  return zip.entries
    .filter(e => CODE_FILE.test(e.name) && !e.encrypted && !e.symlink && !/(?:^|\/)(?:node_modules|\.git|dist|build|coverage|__MACOSX)\//.test(e.name) && !/\.min\.(?:css|js)$|\.map$|package-lock\.json$/.test(e.name))
    .slice(0, 400)
    .map(e => ({assetId: source.id, name: e.name, content: zip.read(e.name).toString('utf8')}));
}

export function createExtractHandler({store, blobs, stageDelayMs = 0, figmaToken = process.env.GAPSCAN_FIGMA_TOKEN, urlAdapter, scraplingAdapter}: ExtractOptions): JobHandler {
  const adapters: Partial<Record<SourceKind, Adapter>> = {pptx: pptxAdapter, docx: docxAdapter, pdf: pdfAdapter, image: imageAdapter, figma: createFigmaAdapter(figmaToken), ...(urlAdapter ? {url: urlAdapter} : {})};
  return async ({job, signal, progress, warn}) => {
    // Stages yield (and can be slowed in tests) so cancellation is honoured between them.
    const checkpoint = async () => { if (stageDelayMs) await sleep(stageDelayMs, undefined, {signal}); signal.throwIfAborted(); };
    // Application code is read by the usage job, never as part of the design system.
    const sources = (await store.listSources(job.projectId)).filter(s => s.role !== 'application'), results: AssetResult[] = [], documents: CodeDocument[] = [];
    await progress('collect', 0, sources.length, `Reading ${sources.length} source${sources.length === 1 ? '' : 's'}…`);
    await checkpoint();

    for (const [index, source] of sources.entries()) {
      const label = source.label ?? source.uri;
      try {
        const bytes = source.blobKey ? await blobs.get(source.blobKey) : Buffer.alloc(0);
        if (source.blobKey && !bytes) throw new Error('Stored content is missing.');
        const context = {signal, refresh: job.payload.refresh === true, progress: (message: string) => progress('collect', index, sources.length, `${label}: ${message}`)};
        let result: AdapterResult;
        if (source.kind === 'code' || source.kind === 'markdown' || source.kind === 'zip') {
          const docs = codeDocuments(source, bytes!);
          if (!docs.length) throw new Error('The archive has no style, token or component source files.');
          documents.push(...docs);
          const parts = await Promise.all(docs.map(doc => codeAdapter({assetId: source.id, name: doc.name, uri: source.uri, bytes: Buffer.from(doc.content)}, context)));
          result = {observations: parts.flatMap(p => p.observations), fetched: docs.length, failed: parts.flatMap(p => p.failed), budgetHit: parts.some(p => p.budgetHit)};
        } else {
          const adapter = source.kind === 'url' && source.reader === 'scrapling' ? scraplingAdapter : adapters[source.kind];
          if (!adapter) throw new Error(NOT_SUPPORTED[source.kind] ?? `${source.kind} sources are not supported yet.`);
          result = await adapter({assetId: source.id, name: label, uri: source.uri, bytes: bytes ?? Buffer.alloc(0)}, context);
        }
        results.push({asset: source, result});
        await progress('collect', index + 1, sources.length, `Read ${label} (${result.observations.length} observations${result.reused ? `; ${result.reused} saved page${result.reused === 1 ? '' : 's'} reused` : ''})`);
      } catch (error) {
        if (signal.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        results.push({asset: source, result: null, error: reason});
        await warn(`${label}: ${reason}`);
        await progress('collect', index + 1, sources.length, `Skipped ${label}`);
      }
      await checkpoint();
    }
    if (!results.some(r => r.result && (r.result.observations.length || r.result.fetched)))
      throw new Error('None of the sources could be read, so there is nothing to extract.');

    // Component inventories from code still come from the prototype extractor (Phase 2 bridge).
    let external: ExternalComponent[] = [];
    // JS/TS components come from the native TypeScript reader; the prototype bridge now only reads markup.
    const markup = documents.filter(doc => !/\.(?:[cm]?[jt]sx?)$/i.test(doc.name));
    if (markup.length) {
      await progress('parse', 0, 1, 'Finding components in markup…');
      const bridge = await extractCode(markup);
      // The native class grouping already folds modifiers (`.btn-sm`, `.card--elevated`) into their base
      // component, and chained `.is-error` classes are states; the bridge's per-class copies are dropped.
      const bases = new Set(results.flatMap(r => r.result?.observations ?? []).filter(o => o.type === 'component').map(o => (o as {name: string}).name.toLowerCase()));
      const isModifierCopy = (name: string) => /^(is|has)-/.test(name) || [...bases].some(base => name.toLowerCase() !== base && (name.toLowerCase().startsWith(base + '-') || name.toLowerCase().startsWith(base + '_')));
      external = bridge.components.filter(component => !component.rawNames.every(isModifierCopy)).map(component => ({
        component, evidence: bridge.evidence.filter(e => component.evidence.includes(e.id)),
        ...(bridge.specimens.find(s => s.id === `sp:${component.id}`) ? {specimen: bridge.specimens.find(s => s.id === `sp:${component.id}`)!} : {}),
      }));
      await checkpoint();
    }

    await progress('normalize', 0, 1, 'Normalizing tokens and building scales…');
    const system = assembleSystem(results, external);
    await progress('audit', 1, 1, `${system.tokens.length} tokens, ${system.components.length} components, ${system.quirks.length} findings.`);
    await checkpoint();

    const version = (await store.latestExtractionVersion(job.projectId)) + 1, id = randomUUID(), createdAt = new Date().toISOString();
    const {scales, ...body} = system;
    const eds = ExtractedDesignSystem.parse({id, projectId: job.projectId, version, fingerprint: systemFingerprint(system), createdAt, sources, ...body});
    signal.throwIfAborted();
    const blobKey = await blobs.put(`extractions/${id}.json`, JSON.stringify(eds));
    await blobs.put(`extractions/${id}.scales.json`, JSON.stringify(scales));
    await store.saveExtraction({id, projectId: job.projectId, version, fingerprint: eds.fingerprint, blobKey, createdAt, summary: {
      tokens: eds.tokens.length, components: eds.components.length, quirks: eds.quirks.length,
      unresolvedTokens: eds.tokens.filter(t => t.status === 'unresolved').length,
      sourcesRead: results.filter(r => r.result).length, sourcesSkipped: results.filter(r => !r.result).length,
      spacingBase: scales.spacing.baseUnit, typeRatio: scales.type?.ratio ?? null, themes: eds.coverage.themes,
    }});
    return {resultId: id};
  };
}
