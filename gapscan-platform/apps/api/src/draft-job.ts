// The `generate` job: ask Claude for a draft section or a match suggestion, then
// store it beside the generated content. Neither counts until a person approves it:
// drafts through the section approval, suggestions through the existing match approval.
import {matchComponent} from '@gapscan/gapscan';
import {loadReference} from '@gapscan/library';
import {buildObjects, isDraftable, OBJECT_TITLES} from '@gapscan/objects';
import type {StoredApproval, StoredDraft} from '@gapscan/objects';
import {draftDocument, draftSection, suggestMatch} from '@gapscan/drafting';
import type {AiSettings, DraftingClient, MatchCandidate, MatchSuggestion} from '@gapscan/drafting';
import type {ObjectKind} from '@gapscan/schema';
import type {BlobStore, JobHandler, Store} from '@gapscan/infra';
import {loadExtraction, loadGapScan} from './gapscan-job.ts';

export type Ai = AiSettings & {client: DraftingClient};
export type StoredSuggestion = MatchSuggestion & {at: string};
export type DraftPayload = {task: 'section'; edsId: string; kind: ObjectKind; sectionId: string} | {task: 'match'; gapscanId: string; sourceId: string}
  | {task: 'documents'; edsId: string; kinds?: ObjectKind[]};

const readJson = async <T>(blobs: BlobStore, key: string): Promise<T | null> => { const blob = await blobs.get(key); return blob ? JSON.parse(blob.toString('utf8')) as T : null; };
export const approvalsKey = (edsId: string) => `objects/${edsId}.approvals.json`;
export const draftsKey = (edsId: string) => `objects/${edsId}.drafts.json`;
export const suggestionsKey = (gapscanId: string) => `gapscans/${gapscanId}.suggestions.json`;
export const readApprovals = async (blobs: BlobStore, edsId: string) => await readJson<Record<string, StoredApproval>>(blobs, approvalsKey(edsId)) ?? {};
export const readDrafts = async (blobs: BlobStore, edsId: string) => await readJson<Record<string, StoredDraft>>(blobs, draftsKey(edsId)) ?? {};
export const readSuggestions = async (blobs: BlobStore, gapscanId: string) => await readJson<Record<string, StoredSuggestion>>(blobs, suggestionsKey(gapscanId)) ?? {};

// Everything in the reference, GapScan's own scored candidates first: an unresolved item
// often has no scored candidate at all, and that is where a judgement on purpose helps most.
export function candidatesFor(source: Parameters<typeof matchComponent>[0], targets: Parameters<typeof matchComponent>[1], limit = 60): MatchCandidate[] {
  const scored = matchComponent(source, targets).candidates;
  const rest = targets.filter(t => !scored.some(c => c.target.id === t.id)).sort((a, b) => Number(b.category === source.category) - Number(a.category === source.category));
  return [...scored.map(c => ({target: c.target, score: c.score, reasons: c.reasons})), ...rest.map(target => ({target, score: 0, reasons: []}))].slice(0, limit)
    .map(({target, score, reasons}) => ({id: target.id, canonical: target.canonical, category: target.category, variants: target.variants.map(v => v.name), sizes: target.sizes, states: target.statesObserved, score, reasons}));
}

export function createDraftHandler({store, blobs, ai}: {store: Store; blobs: BlobStore; ai: Ai}): JobHandler {
  return async ({job, signal, progress}) => {
    const payload = job.payload as DraftPayload;
    // Every document, written whole from the extraction; each is saved as soon as it's done.
    if (payload.task === 'documents') {
      const eds = await loadExtraction(store, blobs, payload.edsId);
      if (!eds) throw new Error('The extraction could not be found.');
      const objects = buildObjects(eds).filter(o => !payload.kinds || payload.kinds.includes(o.kind));
      for (const [index, object] of objects.entries()) {
        signal.throwIfAborted();
        await progress('write', index, objects.length, `Writing ${object.title} (${index + 1} of ${objects.length})…`);
        const sections = object.sections.filter(isDraftable);
        if (!sections.length) continue;
        const written = await draftDocument(ai.client, ai, {eds, objectTitle: object.title, sections}, signal);
        const drafts = await readDrafts(blobs, eds.id), at = new Date().toISOString();
        for (const s of written.sections) drafts[`${object.kind}:${s.id}`] = {content: s.content, evidence: s.evidence, model: written.model, at, openQuestions: [], missing: s.missing};
        await blobs.put(draftsKey(eds.id), JSON.stringify(drafts));
      }
      await progress('write', objects.length, objects.length, 'Your documents are ready.');
      return {resultId: eds.id};
    }
    if (payload.task === 'section') {
      const eds = await loadExtraction(store, blobs, payload.edsId);
      if (!eds) throw new Error('The extraction could not be found.');
      const section = buildObjects(eds).find(o => o.kind === payload.kind)?.sections.find(s => s.id === payload.sectionId);
      if (!section) throw new Error('That section no longer exists.');
      await progress('draft', 0, 1, `Asking Claude to draft “${section.title}”…`);
      const componentId = section.id.startsWith('component-') ? section.id.slice('component-'.length) : undefined;
      const draft = await draftSection(ai.client, ai, {eds, objectTitle: OBJECT_TITLES[payload.kind], section, ...(componentId ? {componentId} : {})}, signal);
      const drafts = await readDrafts(blobs, eds.id);
      drafts[`${payload.kind}:${payload.sectionId}`] = {content: draft.content, evidence: draft.evidence, model: draft.model, at: new Date().toISOString(), openQuestions: draft.openQuestions};
      await blobs.put(draftsKey(eds.id), JSON.stringify(drafts));
      await progress('draft', 1, 1, 'Draft ready for review.');
      return {resultId: `${payload.kind}:${payload.sectionId}`};
    }
    const loaded = await loadGapScan(store, blobs, payload.gapscanId);
    if (!loaded) throw new Error('The report could not be found.');
    const [eds, reference] = await Promise.all([loadExtraction(store, blobs, loaded.record.extractionId), loadReference(loaded.report.reference.id)]);
    const source = eds?.components.find(c => c.id === payload.sourceId);
    if (!eds || !reference || !source) throw new Error('The component or the reference system could not be found.');
    await progress('suggest', 0, 1, `Asking Claude which ${reference.library} component matches ${source.canonical}…`);
    const suggestion = await suggestMatch(ai.client, ai, {eds, sourceId: source.id, referenceName: reference.library, candidates: candidatesFor(source, reference.components)}, signal);
    const suggestions = await readSuggestions(blobs, loaded.report.id);
    suggestions[payload.sourceId] = {...suggestion, at: new Date().toISOString()};
    await blobs.put(suggestionsKey(loaded.report.id), JSON.stringify(suggestions));
    await progress('suggest', 1, 1, 'Suggestion ready for review.');
    return {resultId: payload.sourceId};
  };
}
