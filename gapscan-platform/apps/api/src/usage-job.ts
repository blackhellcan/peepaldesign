// The `usage` job: read the project's application sources (pasted code, ZIPs,
// public GitHub repositories) and count where each extracted component is used.
import {randomUUID} from 'node:crypto';
import {openZip, ZIP_LIMITS} from '@gapscan/adapters';
import {UsageReport} from '@gapscan/schema';
import type {SourceAsset, UsageReport as Report} from '@gapscan/schema';
import type {BlobStore, JobHandler, Store} from '@gapscan/infra';
import {isScannable, scanUsage} from '@gapscan/usage';
import type {SourceFile} from '@gapscan/usage';
import {loadExtraction} from './gapscan-job.ts';

export const latestUsageKey = (projectId: string) => `usage/${projectId}/latest.json`;

// https://github.com/owner/repo, …/tree/branch. Only public repositories, fetched as a ZIP.
export function githubRepo(uri: string): {owner: string; repo: string; branch?: string} | null {
  const m = uri.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+))?\/?$/);
  return m ? {owner: m[1]!, repo: m[2]!, ...(m[3] ? {branch: m[3]} : {})} : null;
}

export async function loadUsageReport(blobs: BlobStore, projectId: string): Promise<Report | null> {
  const blob = await blobs.get(latestUsageKey(projectId));
  return blob ? UsageReport.parse(JSON.parse(blob.toString('utf8'))) : null;
}

type FetchOptions = {allowUrl?: (url: URL) => Promise<boolean>; fetch?: typeof fetch};
// Reads one application source into files: a public GitHub repository (as its ZIP), an uploaded ZIP, or pasted code.
// `accept` picks the paths worth reading; nothing in them is executed.
export function createApplicationReader({blobs, allowUrl = async () => true, fetch: fetchImpl = fetch, accept = isScannable}: FetchOptions & {blobs: BlobStore; accept?: (path: string) => boolean}) {
  const download = async (url: string, limit: number, signal: AbortSignal): Promise<Uint8Array> => {
    if (!(await allowUrl(new URL(url)))) throw new Error(`${new URL(url).hostname} is not a public address.`);
    const response = await fetchImpl(url, {signal, redirect: 'manual', headers: {'user-agent': 'GapScan/1.0'}});
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) return download(new URL(response.headers.get('location')!, url).href, limit, signal);
    if (!response.ok) throw new Error(`GitHub returned ${response.status}. Only public repositories can be read.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('The repository archive is larger than 50 MB.');
    return bytes;
  };
  return async (source: SourceAsset, signal: AbortSignal): Promise<SourceFile[]> => {
    const repo = source.kind === 'url' ? githubRepo(source.uri) : null;
    let zip: Uint8Array | null = null, prefix = '';
    if (repo) {
      const meta = repo.branch ? null : JSON.parse(new TextDecoder().decode(await download(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, 1_000_000, signal))) as {default_branch?: string};
      const branch = repo.branch ?? meta?.default_branch ?? 'main';
      zip = await download(`https://codeload.github.com/${repo.owner}/${repo.repo}/zip/refs/heads/${branch}`, ZIP_LIMITS.archiveBytes, signal);
    } else if (source.kind === 'url') throw new Error('Application code must be pasted, uploaded, or a public github.com repository link.');
    const stored = source.blobKey ? await blobs.get(source.blobKey) : null;
    if (!zip && source.kind === 'zip') zip = stored;
    if (zip) {
      const archive = openZip(zip);
      // GitHub archives wrap everything in one top-level folder (repo-branch/).
      const roots = new Set(archive.entries.map(e => e.name.split('/')[0]));
      if (roots.size === 1) prefix = `${[...roots][0]}/`;
      return archive.entries.filter(e => !e.name.endsWith('/') && !e.encrypted && !e.symlink && e.size <= 1_000_000 && accept(e.name.slice(prefix.length)))
        .slice(0, 6000).map(e => ({path: e.name.slice(prefix.length), content: archive.read(e.name).toString('utf8')}));
    }
    return stored ? [{path: source.label ?? source.id, content: stored.toString('utf8')}] : [];
  };
}

type Options = FetchOptions & {store: Store; blobs: BlobStore};
export function createUsageHandler({store, blobs, allowUrl, fetch}: Options): JobHandler {
  const filesFrom = createApplicationReader({blobs, ...(allowUrl ? {allowUrl} : {}), ...(fetch ? {fetch} : {})});

  return async ({job, signal, progress, warn}) => {
    const {edsId} = job.payload as {edsId: string};
    const eds = await loadExtraction(store, blobs, edsId);
    if (!eds) throw new Error('The extraction could not be found.');
    const sources = (await store.listSources(job.projectId)).filter(s => s.role === 'application');
    if (!sources.length) throw new Error('Add your application code (a ZIP, pasted files or a public GitHub link) as an application source first.');
    const files: SourceFile[] = [];
    for (const [i, source] of sources.entries()) {
      signal.throwIfAborted();
      await progress('collect', i, sources.length, `Reading ${source.label ?? source.uri}…`);
      try { files.push(...await filesFrom(source, signal)); }
      catch (error) { if (signal.aborted) throw error; await warn(`${source.label ?? source.uri}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!files.length) throw new Error('None of the application sources could be read.');
    await progress('scan', 0, 1, `Scanning ${files.length} files for ${eds.components.length} components…`);
    const scan = scanUsage(files, eds.components);
    const report = UsageReport.parse({id: randomUUID(), projectId: job.projectId, createdAt: new Date().toISOString(), sources: sources.map(s => s.id), ...scan});
    signal.throwIfAborted();
    await blobs.put(`usage/${job.projectId}/${report.id}.json`, JSON.stringify(report));
    await blobs.put(latestUsageKey(job.projectId), JSON.stringify(report));
    const used = report.components.filter(c => c.usages).length;
    await progress('scan', 1, 1, `${used} of ${report.components.length} components are used, across ${report.filesScanned} files and ${report.screens} screens.`);
    return {resultId: report.id};
  };
}
