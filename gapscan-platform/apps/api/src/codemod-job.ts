// The `codemod` job: build rules from a GapScan report and dry-run them on the project's
// application code. The result is a diff to review; nothing is written to anyone's code.
import {randomUUID} from 'node:crypto';
import {buildPlan, dryRun, shouldVisit} from '@gapscan/codemod';
import type {CodemodPlan, DryRun, SourceFile} from '@gapscan/codemod';
import {codemodBinding, loadReference} from '@gapscan/library';
import type {GapScanReport} from '@gapscan/schema';
import type {BlobStore, GapScanRecord, JobHandler, Store} from '@gapscan/infra';
import {loadExtraction, loadGapScan} from './gapscan-job.ts';
import {createApplicationReader, loadUsageReport} from './usage-job.ts';

export type CodemodRun = {id: string; gapscanId: string; createdAt: string; hash: string; rules: CodemodPlan['rules']; notes: string[]} & DryRun;
const latestKey = (gapscanId: string) => `codemods/${gapscanId}/latest.json`;

export async function codemodPlan(store: Store, blobs: BlobStore, report: GapScanReport, record: GapScanRecord): Promise<CodemodPlan> {
  const [source, reference, usage] = await Promise.all([loadExtraction(store, blobs, record.extractionId), loadReference(report.reference.id), loadUsageReport(blobs, record.projectId)]);
  if (!source) throw new Error('The extraction behind this report could not be found.');
  if (!reference) throw new Error(`Reference system ${report.reference.id} is not in the library.`);
  return buildPlan({report, source, reference, usage, binding: codemodBinding(reference.id)});
}

export async function loadCodemodRun(blobs: BlobStore, gapscanId: string): Promise<CodemodRun | null> {
  const blob = await blobs.get(latestKey(gapscanId));
  return blob ? JSON.parse(blob.toString('utf8')) as CodemodRun : null;
}

type Options = {store: Store; blobs: BlobStore; allowUrl?: (url: URL) => Promise<boolean>; fetch?: typeof fetch};
export function createCodemodHandler({store, blobs, allowUrl, fetch}: Options): JobHandler {
  const read = createApplicationReader({blobs, accept: shouldVisit, ...(allowUrl ? {allowUrl} : {}), ...(fetch ? {fetch} : {})});
  return async ({job, signal, progress, warn}) => {
    const {gapscanId} = job.payload as {gapscanId: string};
    const loaded = await loadGapScan(store, blobs, gapscanId);
    if (!loaded) throw new Error('The GapScan report could not be found.');
    await progress('plan', 0, 3, 'Building rules from the report…');
    const plan = await codemodPlan(store, blobs, loaded.report, loaded.record);
    if (!plan.rules.components.length) await warn('No confirmed matches can be rewritten automatically; see the notes for what changes by hand.');
    const sources = (await store.listSources(job.projectId)).filter(s => s.role === 'application');
    const files: SourceFile[] = [];
    for (const [i, source] of sources.entries()) {
      signal.throwIfAborted();
      await progress('collect', i + 1, 3, `Reading ${source.label ?? source.uri}…`);
      try { files.push(...await read(source, signal)); }
      catch (error) { if (signal.aborted) throw error; await warn(`${source.label ?? source.uri}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!files.length) throw new Error('None of the application sources could be read.');
    const run: CodemodRun = {id: randomUUID(), gapscanId, createdAt: new Date().toISOString(), hash: plan.hash, rules: plan.rules, notes: plan.notes, ...dryRun(files, plan.rules)};
    signal.throwIfAborted();
    await blobs.put(`codemods/${gapscanId}/${run.id}.json`, JSON.stringify(run));
    await blobs.put(latestKey(gapscanId), JSON.stringify(run));
    await progress('dry-run', 3, 3, `${run.totals.changes} edits in ${run.totals.filesChanged} files; ${run.totals.manual} call sites to change by hand.`);
    return {resultId: run.id};
  };
}
