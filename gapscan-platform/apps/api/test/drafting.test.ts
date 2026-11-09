import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configFromEnv, createInfra} from '@gapscan/infra';
import type {Infra} from '@gapscan/infra';
import type Anthropic from '@anthropic-ai/sdk';
import type {DraftingClient} from '@gapscan/drafting';
import {ArchitecturalObject} from '@gapscan/schema';
import {buildApp} from '../src/app.ts';
import {createExtractHandler} from '../src/extract-job.ts';

const CSS = `:root { --brand: #0B5FD6 }
.btn { padding: 8px 16px; border-radius: 4px } .btn-primary { background: #0B5FD6; color: #fff } .btn:hover { opacity: .9 }
.carousel { display: flex } .carousel-item { flex: 1 }`;

// Answers like Claude would, choosing the reply by what was asked; no network.
function stubClaude() {
  const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const client: DraftingClient = {beta: {messages: {create: async params => {
    requests.push(params);
    const content = String(params.messages[0]!.content), match = content.includes('<candidates>');
    const ids = [...content.matchAll(/<section id="([^"]+)"/g)].map(m => m[1]!);
    const answer = ids.length ? {sections: ids.map((id, i) => ({id, content: `Written: ${id}.`, missing: i === 0 ? ['Minimum target size for icon buttons'] : [], citedFacts: ['F1']}))}
      : match ? {candidate: 'C1', confidence: 'medium', rationale: 'Closest in purpose.', citedFacts: ['F1']}
      : {content: 'Draft: the product meets **WCAG 2.2 AA**, checked before each release.', citedFacts: ['F2'], openQuestions: ['AA or AAA?']};
    return {id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, container: null, context_management: null, usage: {} as never,
      content: [{type: 'text', text: JSON.stringify(answer), citations: null}]} as unknown as Anthropic.Beta.Messages.BetaMessage;
  }}}};
  return {client, requests};
}

async function harness(withAi: boolean) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-draft-'));
  const infra: Infra = await createInfra({...configFromEnv({}), dataDir});
  const claude = stubClaude();
  const app = buildApp({infra, handlers: {extract: createExtractHandler({store: infra.store, blobs: infra.blobs, stageDelayMs: 0})}, heartbeatMs: 50,
    ...(withAi ? {ai: {model: 'claude-opus-5-5', effort: 'medium' as const, client: claude.client}} : {})});
  const json = async <T = any>(method: string, url: string, payload?: unknown) => {
    const response = await app.inject({method: method as 'GET', url, ...(payload === undefined ? {} : {payload: payload as object})});
    return {status: response.statusCode, body: (response.body ? JSON.parse(response.body) : null) as T};
  };
  const project = (await json('POST', '/v1/projects', {name: 'Acme'})).body as {id: string};
  await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'code', name: 'acme.css', content: CSS});
  const {jobId} = (await json('POST', `/v1/projects/${project.id}/extractions`)).body;
  await infra.queue.idle();
  const edsId = (await json('GET', `/v1/jobs/${jobId}`)).body.resultId as string;
  const close = async () => { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); };
  return {infra, json, edsId, requests: claude.requests, close};
}

test('drafting is off by default: no buttons to show and no jobs accepted', async () => {
  const h = await harness(false);
  try {
    assert.deepEqual((await h.json('GET', '/v1/ai')).body, {enabled: false});
    assert.equal((await h.json('POST', `/v1/extractions/${h.edsId}/objects/accessibility/sections/target/draft`)).status, 503);
  } finally { await h.close(); }
});

test('a drafted section replaces the template, waits for approval, and can be discarded', async () => {
  const h = await harness(true);
  try {
    assert.deepEqual((await h.json('GET', '/v1/ai')).body, {enabled: true, provider: 'Anthropic', model: 'claude-opus-5-5'});
    const path = `/v1/extractions/${h.edsId}/objects/accessibility/sections/target/draft`;
    const before = (await h.json('GET', `/v1/extractions/${h.edsId}/objects`)).body.find((o: {kind: string}) => o.kind === 'accessibility');
    // Facts read from the sources are not redrafted; unknown sections are 404.
    assert.equal((await h.json('POST', `/v1/extractions/${h.edsId}/objects/tooling/sections/detected/draft`)).status, 400);
    assert.equal((await h.json('POST', `/v1/extractions/${h.edsId}/objects/accessibility/sections/nope/draft`)).status, 404);

    const started = await h.json('POST', path);
    assert.equal(started.status, 202);
    await h.infra.queue.idle();
    const job = (await h.json('GET', `/v1/jobs/${started.body.jobId}`)).body;
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(job.type, 'generate');

    const drafted = ArchitecturalObject.parse((await h.json('GET', `/v1/extractions/${h.edsId}/objects`)).body.find((o: {kind: string}) => o.kind === 'accessibility'));
    const section = drafted.sections.find(s => s.id === 'target')!;
    assert.match(section.content, /WCAG 2\.2 AA/);
    assert.equal(section.provenance, 'drafted');
    assert.deepEqual(section.draftedBy?.openQuestions, ['AA or AAA?']);
    assert.match(section.draftedBy?.original ?? '', /WCAG 2\.1 level AA/, 'GapScan\'s own text is kept for comparison');
    assert.equal(drafted.completeness, before.completeness, 'an unapproved draft counts for nothing');

    const approved = (await h.json('PUT', `/v1/extractions/${h.edsId}/objects/accessibility/sections/target/approval`, {by: 'pm@example.com'})).body;
    const approvedSection = approved.sections.find((s: {id: string}) => s.id === 'target');
    assert.equal(approvedSection.approval.by, 'pm@example.com', 'the approval covers the draft the reviewer saw');
    assert.ok(approved.completeness > before.completeness);

    const discarded = (await h.json('DELETE', path)).body.sections.find((s: {id: string}) => s.id === 'target');
    assert.equal(discarded.draftedBy, undefined);
    assert.equal(discarded.stale, true, 'the approval was for the draft, not the template');
  } finally { await h.close(); }
});

test('a match suggestion is stored as advice; only the reviewer approval changes the report', async () => {
  const h = await harness(true);
  try {
    const started = await h.json('POST', '/v1/gapscans', {edsId: h.edsId, referenceId: 'polaris-13.9.5'});
    await h.infra.queue.idle();
    const reportId = (await h.json('GET', `/v1/jobs/${started.body.jobId}`)).body.resultId;
    const report = (await h.json('GET', `/v1/gapscans/${reportId}`)).body;
    const open = report.items.find((i: {match: {status: string; sourceId: string}}) => i.match.status !== 'confirmed' && !i.match.sourceId.startsWith('target:'));
    assert.ok(open, 'something for Claude to look at');
    assert.deepEqual((await h.json('GET', `/v1/gapscans/${reportId}/suggestions`)).body, {});

    const asked = await h.json('POST', `/v1/gapscans/${reportId}/matches/${encodeURIComponent(open.match.sourceId)}/suggestion`);
    assert.equal(asked.status, 202);
    await h.infra.queue.idle();
    const job = (await h.json('GET', `/v1/jobs/${asked.body.jobId}`)).body;
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    const suggestion = (await h.json('GET', `/v1/gapscans/${reportId}/suggestions`)).body[open.match.sourceId];
    assert.equal(suggestion.confidence, 'medium');
    assert.ok(suggestion.targetId, 'a Polaris component id from the candidate list');
    assert.match(String(h.requests.at(-1)!.messages[0]!.content), /Polaris candidates/);

    const unchanged = (await h.json('GET', `/v1/gapscans/${reportId}`)).body.items.find((i: {id: string}) => i.id === open.id);
    assert.equal(unchanged.match.status, open.match.status, 'a suggestion alone changes nothing');
    const approved = (await h.json('PUT', `/v1/gapscans/${reportId}/matches/${encodeURIComponent(open.match.sourceId)}`, {targetId: suggestion.targetId, by: 'pm@example.com', reason: `Claude's suggestion, checked: ${suggestion.rationale}`})).body;
    assert.equal(approved.item.match.status, 'confirmed');
    assert.equal(approved.item.match.targetId, suggestion.targetId);
    assert.equal((await h.json('POST', `/v1/gapscans/${reportId}/matches/${encodeURIComponent(open.match.sourceId)}/suggestion`)).status, 400, 'already confirmed');
  } finally { await h.close(); }
});

test('writing every document: no approval needed, gaps kept and highlighted, completeness counts them', async () => {
  const off = await harness(false);
  try { assert.equal((await off.json('POST', `/v1/extractions/${off.edsId}/documents`)).status, 503); } finally { await off.close(); }
  const h = await harness(true);
  try {
    const before = (await h.json('GET', `/v1/extractions/${h.edsId}/objects`)).body;
    const started = await h.json('POST', `/v1/extractions/${h.edsId}/documents`);
    assert.equal(started.status, 202);
    await h.infra.queue.idle();
    const job = (await h.json('GET', `/v1/jobs/${started.body.jobId}`)).body;
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    const after = (await h.json('GET', `/v1/extractions/${h.edsId}/objects`)).body.map((o: unknown) => ArchitecturalObject.parse(o));
    const accessibility = after.find((o: {kind: string}) => o.kind === 'accessibility')!;
    const target = accessibility.sections.find((s: {id: string}) => s.id === 'target')!;
    assert.equal(target.content, 'Written: target.');
    assert.deepEqual(target.draftedBy?.missing, ['Minimum target size for icon buttons']);
    assert.equal(target.status, 'partial', 'a section with gaps is partly written');
    assert.equal(accessibility.sections.find((s: {id: string}) => s.id === 'contrast')!.provenance, 'extracted', 'facts read from the sources are never rewritten');
    const total = (list: {completeness: number}[]) => list.reduce((n, o) => n + o.completeness, 0);
    assert.ok(total(after) > total(before), 'written documents count without approval');
    assert.ok(after.every((o: {sections: {approval?: unknown}[]}) => o.sections.every(s => !s.approval)), 'nobody had to approve anything');
    // Only the documents asked for.
    const one = await h.json('POST', `/v1/extractions/${h.edsId}/documents`, {kinds: ['brand']});
    await h.infra.queue.idle();
    assert.equal((await h.json('GET', `/v1/jobs/${one.body.jobId}`)).body.status, 'completed');
    assert.equal((await h.json('POST', `/v1/extractions/${h.edsId}/documents`, {kinds: ['nonsense']})).status, 400);
  } finally { await h.close(); }
});
