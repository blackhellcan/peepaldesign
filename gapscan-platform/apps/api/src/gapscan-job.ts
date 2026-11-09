// The `gapscan` job and its helpers: compare a stored extraction with a pinned
// reference, applying any reviewer approvals made on the same evidence.
import {randomUUID} from 'node:crypto';
import {runGapScan} from '@gapscan/gapscan';
import {loadReference} from '@gapscan/library';
import {ExtractedDesignSystem, GapScanReport} from '@gapscan/schema';
import {loadUsageReport} from './usage-job.ts';
import type {Assumptions, GapScanReport as Report} from '@gapscan/schema';
import type {BlobStore, JobHandler, Store} from '@gapscan/infra';

export const approvalKey = (edsFingerprint: string, referenceId: string, sourceId: string) => `${edsFingerprint}:${referenceId}:${sourceId}`;

export async function loadExtraction(store: Store, blobs: BlobStore, id: string) {
  const record = await store.getExtraction(id);
  const blob = record && await blobs.get(record.blobKey);
  return blob ? ExtractedDesignSystem.parse(JSON.parse(blob.toString('utf8'))) : null;
}

export async function computeReport(store: Store, blobs: BlobStore, edsId: string, referenceId: string, assumptions: Partial<Assumptions> = {}): Promise<Omit<Report, 'id'>> {
  const [source, reference] = await Promise.all([loadExtraction(store, blobs, edsId), loadReference(referenceId)]);
  if (!source) throw new Error('The extraction could not be found. Run the extraction again.');
  if (!reference) throw new Error(`Reference system ${referenceId} is not in the library.`);
  const approvals = new Map((await store.listApprovals(source.fingerprint, referenceId)).map(a => [a.sourceId, {targetId: a.targetId, by: a.by}]));
  const usage = await loadUsageReport(blobs, source.projectId);
  return runGapScan({source, reference, assumptions, approvals, usage});
}

export async function loadGapScan(store: Store, blobs: BlobStore, id: string) {
  const record = await store.getGapScan(id), blob = record && await blobs.get(record.blobKey);
  return record && blob ? {record, report: GapScanReport.parse(JSON.parse(blob.toString('utf8')))} : null;
}

export function summarize(report: Omit<Report, 'id'>) {
  const decisions: Record<string, number> = {};
  for (const item of report.items) decisions[item.decision] = (decisions[item.decision] ?? 0) + 1;
  return {decisions, totals: report.totals, reference: report.reference};
}

export async function saveReport(store: Store, blobs: BlobStore, report: Report, projectId: string, extractionId: string, createdAt = new Date().toISOString()) {
  const blobKey = await blobs.put(`gapscans/${report.id}.json`, JSON.stringify(GapScanReport.parse(report)));
  await store.saveGapScan({id: report.id, projectId, extractionId, referenceId: report.reference.id, blobKey, summary: summarize(report), createdAt, updatedAt: new Date().toISOString()});
}

export function createGapScanHandler({store, blobs}: {store: Store; blobs: BlobStore}): JobHandler {
  return async ({job, signal, progress}) => {
    const {edsId, referenceId, assumptions} = job.payload as {edsId: string; referenceId: string; assumptions?: Partial<Assumptions>};
    await progress('match', 0, 2, 'Matching your components to the reference…');
    const report = {id: randomUUID(), ...await computeReport(store, blobs, edsId, referenceId, assumptions ?? {})};
    signal.throwIfAborted();
    await progress('estimate', 1, 2, `${report.items.length} items compared; estimating effort…`);
    await saveReport(store, blobs, report, job.projectId, edsId);
    await progress('estimate', 2, 2, 'Report ready.');
    return {resultId: report.id};
  };
}
