// The `render` job: brand kit → template → headless Chromium → stored output and checks.
import {EGRESS_CHROMIUM_ARGS, startEgressProxy} from '@gapscan/adapters';
import {buildBrandKit, planAsset, renderAsset, renderDeck} from '@gapscan/assets';
import {buildDesignSystem, renderDesignSystemBook} from '@gapscan/exports';
import {buildObjects} from '@gapscan/objects';
import {readApprovals, readDrafts} from './draft-job.ts';
import type {BlobStore, JobHandler, Store} from '@gapscan/infra';
import {loadExtraction} from './gapscan-job.ts';

export const assetKey = (jobId: string, file: string) => `assets/${jobId}/${file}`;

export function createRenderHandler({store, blobs}: {store: Store; blobs: BlobStore}): JobHandler {
  return async ({job, signal, progress}) => {
    const {edsId, template, data, brandName} = job.payload as {edsId: string; template: string; data: Record<string, string>; brandName?: string};
    const eds = await loadExtraction(store, blobs, edsId);
    if (!eds) throw new Error('The extraction could not be found.');
    if (template === BOOK) return renderBook(job.id, eds, brandName || 'Design system', signal, progress);
    const kit = buildBrandKit(eds, brandName || 'Your brand'), plan = planAsset(template, kit, data);
    await progress('render', 0, 1, `Rendering ${plan.template.label}…`);
    const save = async (output: {file: string; contentType: string; bytes: Uint8Array}) => {
      await blobs.put(assetKey(job.id, output.file), output.bytes);
      await blobs.put(assetKey(job.id, 'manifest.json'), JSON.stringify({template: plan.template, file: output.file, contentType: output.contentType, checks: plan.checks, edsId}));
      await progress('render', 1, 1, `${plan.checks.filter(c => !c.pass).length ? 'Rendered with warnings' : 'Rendered; all checks passed'}.`);
      return {resultId: job.id};
    };
    if (plan.template.output === 'pptx') return save(renderDeck(kit, data));
    if (plan.template.output === 'html') return save({file: `${plan.template.id}.html`, contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(plan.html)});
    return withOfflineBrowser(signal, async page => save(await renderAsset(page, plan)));
  };

  // The design-system book: the laid-out system, then every approved documentation section, as an A4 PDF.
  async function renderBook(jobId: string, eds: NonNullable<Awaited<ReturnType<typeof loadExtraction>>>, name: string, signal: AbortSignal, progress: Parameters<JobHandler>[0]['progress']) {
    await progress('render', 0, 1, 'Laying out your design system…');
    const scales = await blobs.get(`extractions/${eds.id}.scales.json`);
    const doc = buildDesignSystem(eds, scales ? JSON.parse(scales.toString('utf8')) : {}, name);
    const objects = buildObjects(eds, await readApprovals(blobs, eds.id), await readDrafts(blobs, eds.id));
    // Written documents: what's read from the sources, approved sections, and AI-written sections with their gaps.
    const documents = objects.map(o => ({title: o.title, sections: o.sections.filter(s => s.approval || s.draftedBy || s.provenance === 'extracted')
      .map(s => ({title: s.title, content: s.content, ...(s.draftedBy?.missing?.length ? {missing: s.draftedBy.missing} : {})}))}));
    const html = renderDesignSystemBook(doc, documents);
    const file = `${name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'design-system'}-design-system.pdf`;
    const bytes = await withOfflineBrowser(signal, async page => {
      await page.setContent(html, {waitUntil: 'load'});
      return page.pdf({format: 'A4', printBackground: true, margin: {top: '16mm', bottom: '16mm', left: '14mm', right: '14mm'}});
    });
    await blobs.put(assetKey(jobId, file), bytes);
    const approved = documents.reduce((n, d) => n + d.sections.length, 0), gaps = documents.reduce((n, d) => n + d.sections.reduce((m, s) => m + (s.missing?.length ?? 0), 0), 0);
    await blobs.put(assetKey(jobId, 'manifest.json'), JSON.stringify({template: {id: BOOK, label: 'Design system book', output: 'pdf'}, file, contentType: 'application/pdf', checks: [
      {id: 'documents', pass: approved > 0, message: approved ? `${approved} documentation section${approved === 1 ? '' : 's'} included${gaps ? `, with ${gaps} missing item${gaps === 1 ? '' : 's'} highlighted` : ''}.` : 'No documentation written yet, so the book has the design system only.'}], edsId: eds.id}));
    await progress('render', 1, 1, 'Your PDF is ready.');
    return {resultId: jobId};
  }
}

export const BOOK = 'design-system-book';
// A browser that can't reach anything: every request goes to a proxy that refuses it.
async function withOfflineBrowser<T>(signal: AbortSignal, use: (page: import('playwright').Page) => Promise<T>): Promise<T> {
  let playwright: typeof import('playwright');
  try { playwright = await import('playwright'); } catch { throw new Error('Rendering needs Playwright on the server (npx playwright install chromium).'); }
  const proxy = await startEgressProxy({resolve: async () => null});
  const browser = await playwright.chromium.launch({args: EGRESS_CHROMIUM_ARGS, proxy: proxy.launchProxy}).catch(async error => { await proxy.close(); throw error; });
  const stop = () => { void browser.close(); };
  signal.addEventListener('abort', stop, {once: true});
  try { return await use(await browser.newPage()); }
  finally {
    signal.removeEventListener('abort', stop);
    await browser.close().catch(() => undefined);
    await proxy.close();
  }
}
