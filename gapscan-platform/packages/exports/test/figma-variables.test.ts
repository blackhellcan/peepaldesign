import test from 'node:test';
import assert from 'node:assert/strict';
import {planFigmaSync, variableName} from '@gapscan/exports';
import type {ExtractedDesignSystem, Token} from '@gapscan/schema';

const token = (path: string, value: string, extra: Partial<Token> = {}): Token => ({id: path, tier: 'global', path, type: 'color', value, status: 'resolved', evidence: [], confidence: 0.9, usageCount: 1, ...extra});
const eds = (tokens: Token[]): ExtractedDesignSystem => ({id: 'e', projectId: 'p', version: 1, fingerprint: 'f', createdAt: new Date().toISOString(), sources: [], evidence: [], tokens, components: [], specimens: [], quirks: [], coverage: {perAsset: [], viewports: [], themes: []}, brandSignals: {voiceSnippets: [], logoAssets: []}});
const system = eds([
  token('--brand-primary', '#0B5FD6', {modes: {Light: '#0B5FD6', Dark: '#4D8CFF'}}),
  token('--link', 'var(--brand-primary)', {aliasOf: '--brand-primary', tier: 'semantic'}),
  token('space.2', '8px', {type: 'dimension'}), token('font.family.body', 'Inter, sans-serif', {type: 'fontFamily'}),
  token('shadow.1', '0 1px 2px #0002', {type: 'shadow'}), token('--gutter', 'calc(1px)', {type: 'dimension', status: 'unresolved'}),
  token('color.palette.3', '#123456', {confidence: 0.4}),
]);

test('variable names follow Figma groups', () => {
  assert.equal(variableName('--brand-primary'), 'brand/primary');
  assert.equal(variableName('color.primary'), 'color/primary');
});

test('a new file gets a collection, a Dark mode, typed variables, values per mode and aliases', () => {
  const plan = planFigmaSync(system, null);
  assert.equal(plan.collectionExists, false);
  assert.deepEqual(plan.modes, ['Light', 'Dark']);
  assert.deepEqual(plan.create.map(c => `${c.name}:${c.type}:${c.mode}`).sort(), ['brand/primary:COLOR:Dark', 'brand/primary:COLOR:Light', 'font/family/body:STRING:Light', 'link:COLOR:Light', 'space/2:FLOAT:Light']);
  assert.deepEqual(plan.skipped.map(s => s.path), ['shadow.1'], 'unsupported types are listed, unresolved and inferred tokens are left out');
  const values = plan.payload.variableModeValues as {variableId: string; value: unknown}[];
  assert.deepEqual(values.find(v => v.variableId === 'tmp:var:link')?.value, {type: 'VARIABLE_ALIAS', id: 'tmp:var:brand/primary'});
  assert.deepEqual(values.find(v => v.variableId === 'tmp:var:space/2')?.value, 8);
  assert.match(plan.hash, /^[0-9a-f]{16}$/);
});

test('an existing collection gets only real updates; unchanged values and type clashes are reported', () => {
  const existing = {meta: {
    variableCollections: {c1: {id: 'c1', name: 'GapScan tokens', defaultModeId: 'm1', modes: [{modeId: 'm1', name: 'Light'}, {modeId: 'm2', name: 'Dark'}]}},
    variables: {
      v1: {id: 'v1', name: 'brand/primary', resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: {m1: {r: 0.043, g: 0.373, b: 0.839, a: 1}, m2: {r: 0, g: 0, b: 0, a: 1}}},
      v2: {id: 'v2', name: 'space/2', resolvedType: 'STRING', variableCollectionId: 'c1', valuesByMode: {m1: '8px'}},
    },
  }};
  const plan = planFigmaSync(system, existing);
  assert.equal(plan.collectionExists, true);
  assert.deepEqual(plan.update.map(u => `${u.name}:${u.mode}`), ['brand/primary:Dark'], 'the Light value already matches');
  assert.ok(plan.skipped.some(s => s.path === 'space.2' && /already has space\/2 as STRING/.test(s.reason)));
  assert.equal((plan.payload.variableCollections as unknown[]).length, 0, 'no new collection');
  assert.notEqual(plan.hash, planFigmaSync(system, null).hash);
});
