import test from 'node:test';
import assert from 'node:assert/strict';
import {Assumptions, ExtractedDesignSystem, JobEvent, QuirkRecord, SourceAsset, TERMINAL_JOB_STATUSES} from '@gapscan/schema';

const now = new Date().toISOString();
const sha = 'a'.repeat(64);

test('an extracted design system round-trips with provenance intact', () => {
  const source = SourceAsset.parse({id: 's1', projectId: 'p1', kind: 'code', uri: 'inline:button.css', sha256: sha, bytes: 10, budget: {maxPages: 1, maxBytes: 1_500_000}, createdAt: now});
  const eds = ExtractedDesignSystem.parse({
    id: 'e1', projectId: 'p1', version: 1, fingerprint: 'f', createdAt: now, sources: [source],
    evidence: [{id: 'ev1', assetId: 's1', trust: 'declared', locator: 'button.css:1', raw: '--brand: #0B5FD6'}],
    tokens: [{id: 't1', tier: 'global', path: 'brand', type: 'color', value: '#0B5FD6', status: 'resolved', evidence: ['ev1'], confidence: 0.9, usageCount: 1}],
    components: [], specimens: [], quirks: [], coverage: {perAsset: [], viewports: [], themes: []},
    brandSignals: {voiceSnippets: [], logoAssets: []},
  });
  assert.equal(eds.tokens[0]?.evidence[0], 'ev1');
});

test('quirks only use the cataloged kinds', () => {
  assert.throws(() => QuirkRecord.parse({id: 'q', kind: 'made_up', severity: 'info', subjectIds: [], summary: '', evidence: []}));
});

test('job events are a closed union and terminal events carry no payload', () => {
  assert.equal(JobEvent.parse({seq: 1, jobId: 'j', at: now, body: {type: 'complete', resultId: 'r'}}).body.type, 'complete');
  assert.throws(() => JobEvent.parse({seq: 1, jobId: 'j', at: now, body: {type: 'done'}}));
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), ['cancelled', 'completed', 'failed']);
});

test('assumptions default to the documented planning values', () => {
  assert.deepEqual(Assumptions.parse({}), {rate: 75, apps: 1, engineers: 2, qaPct: 20, excluded: [], edited: {}});
});
