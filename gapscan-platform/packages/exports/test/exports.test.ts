import test from 'node:test';
import assert from 'node:assert/strict';
import {exportTokens} from '@gapscan/exports';
import type {ExtractedDesignSystem, Token} from '@gapscan/schema';

const token = (path: string, value: string, extra: Partial<Token> = {}): Token => ({id: path, tier: 'global', path, type: 'color', value, status: 'resolved', evidence: ['ev1'], confidence: 0.9, usageCount: 1, ...extra});
const eds: ExtractedDesignSystem = {
  id: 'e1', projectId: 'p', version: 3, fingerprint: 'abcdef1234567890', createdAt: new Date().toISOString(), sources: [], evidence: [], components: [], specimens: [], quirks: [],
  coverage: {perAsset: [], viewports: [], themes: []}, brandSignals: {voiceSnippets: [], logoAssets: []},
  tokens: [
    token('--brand-primary', '#0B5FD6', {modes: {Light: '#0B5FD6', Dark: '#4D8CFF'}}),
    token('--link', 'var(--brand-primary)', {aliasOf: '--brand-primary', tier: 'semantic'}),
    token('color.primary', '#0b5fd6', {tier: 'semantic', confidence: 0.45}),
    token('space.1', '8px', {type: 'dimension', confidence: 0.6}),
    token('radius.md', '4px', {type: 'radius'}),
    token('font.family.body', 'Inter', {type: 'fontFamily'}),
    token('font.size.body', '16px', {type: 'dimension'}),
    token('--gutter', 'calc(var(--x) * 2)', {type: 'dimension', status: 'unresolved'}),
    token('color.palette.1', '#123456', {confidence: 0.3}),
  ],
};

test('DTCG export nests paths, keeps aliases as references, carries provenance and skips unresolved values', () => {
  const json = JSON.parse(exportTokens(eds, 'dtcg'));
  assert.equal(json.brand.primary.$value, '#0b5fd6');
  assert.equal(json.brand.primary.$type, 'color');
  assert.deepEqual(json.brand.primary.$extensions['com.gapscan'].modes, {Light: '#0B5FD6', Dark: '#4D8CFF'});
  assert.equal(json.link.$value, '{brand.primary}');
  assert.equal(json.color.primary.$extensions['com.gapscan'].confidence, 'inferred');
  assert.equal(json.space['1'].$value, '8px');
  assert.equal(json.gutter, undefined, 'unresolved tokens are not exported as if they were known');
  assert.equal(json.color.palette, undefined, 'inferred palette clusters are opt-in');
  assert.ok(JSON.parse(exportTokens(eds, 'dtcg', {includeInferredPalette: true})).color.palette);
});

test('CSS export has a root block, aliases as var() and a block per extra theme mode', () => {
  const css = exportTokens(eds, 'css');
  assert.match(css, /:root \{[\s\S]*--brand-primary: #0b5fd6;/);
  assert.match(css, /--link: var\(--brand-primary\);/);
  assert.match(css, /--color-primary: #0b5fd6; \/\* inferred \*\//);
  assert.match(css, /\[data-theme="dark"\] \{\n {2}--brand-primary: #4D8CFF;/);
  assert.doesNotMatch(css, /gutter/);
});

test('Tailwind v4 export maps tokens into theme namespaces', () => {
  const theme = exportTokens(eds, 'tailwind4');
  assert.match(theme, /@import "tailwindcss";/);
  assert.match(theme, /--color-primary: #0b5fd6;/);
  assert.match(theme, /--spacing-1: 8px;/);
  assert.match(theme, /--radius-md: 4px;/);
  assert.match(theme, /--font-body: Inter;/);
  assert.match(theme, /--text-body: 16px;/);
});

test('SCSS export uses variables and variable references', () => {
  const scss = exportTokens(eds, 'scss');
  assert.match(scss, /\$brand-primary: #0b5fd6;/);
  assert.match(scss, /\$link: \$brand-primary;/);
});
