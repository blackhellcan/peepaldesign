import test from 'node:test';
import assert from 'node:assert/strict';
import {codeAdapter, pptxAdapter} from '@gapscan/adapters';
import type {AdapterResult} from '@gapscan/adapters';
import {assembleSystem, systemFingerprint} from '@gapscan/extraction';
import type {AssetResult} from '@gapscan/extraction';
import {ExtractedDesignSystem} from '@gapscan/schema';
import type {SourceAsset} from '@gapscan/schema';
import {pptx} from '../../adapters/test/fixtures.ts';

const signal = new AbortController().signal;
const asset = (id: string, kind: SourceAsset['kind'], label: string): SourceAsset => ({id, projectId: 'p', kind, uri: `inline:${label}`, label, sha256: 'a'.repeat(64), bytes: 1, budget: {maxPages: 1, maxBytes: 1}, role: 'system', createdAt: new Date().toISOString()});

const SITE_CSS = `
:root { --brand: #0B5FD6; --surface: #FFFFFF; --link: var(--brand); --gutter: calc(var(--x) * 2) }
body { color: #1A1A1A; background: #FFFFFF; font-family: "Inter", sans-serif; font-size: 16px }
h1 { font-size: 39px } h2 { font-size: 31.25px } h3 { font-size: 25px } h4 { font-size: 20px } small { font-size: 12.8px }
.btn-primary { background-color: #0B5FD6; color: #FFFFFF; padding: 8px 16px; border-radius: 4px }
.btn-primary:hover { background-color: #0A55C0 }
.link { color: #1565D8 }
.card { padding: 24px; margin: 13px; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.1) }
.badge-muted { color: #9A9A9A; background-color: #FFFFFF; padding: 4px 8px }
.alert-error { color: #D92D20; border: 1px solid #D92D20; padding: 16px; gap: 8px }
.stack { gap: 32px; margin: 16px 0 }`;

async function inputs(): Promise<AssetResult[]> {
  const code = await codeAdapter({assetId: 'css', name: 'site.css', uri: 'inline:site.css', bytes: Buffer.from(SITE_CSS)}, {signal});
  const deck = await pptxAdapter({assetId: 'deck', name: 'brand.pptx', uri: 'inline:brand.pptx', bytes: pptx()}, {signal});
  const figma: AdapterResult = {fetched: 3, failed: [], budgetHit: false, themes: ['Light', 'Dark'], observations: [
    {type: 'component', channel: 'figma_styles', name: 'Button', states: ['default', 'hover', 'disabled'], variants: ['Variant=Primary', 'size=Small', 'size=Large'], locator: 'node 2:1'},
    {type: 'token', channel: 'figma_variables', path: '--brand', value: '#0B5FD6', tokenType: 'color', locator: 'variable V:1', raw: 'Light=#0B5FD6; Dark=#4D8CFF'},
  ]};
  return [
    {asset: asset('css', 'code', 'site.css'), result: code},
    {asset: asset('deck', 'pptx', 'brand.pptx'), result: deck},
    {asset: asset('fig', 'figma', 'Acme UI'), result: figma},
    {asset: asset('site', 'url', 'acme.com'), result: null, error: 'Rendering timed out.'},
  ];
}

test('the assembled system validates against the schema and keeps every token traceable', async () => {
  const system = assembleSystem(await inputs());
  const eds = ExtractedDesignSystem.parse({id: 'e', projectId: 'p', version: 1, fingerprint: systemFingerprint(system), createdAt: new Date().toISOString(), sources: [], ...system});
  const evidenceIds = new Set(eds.evidence.map(e => e.id));
  assert.ok(eds.tokens.every(t => t.evidence.every(id => evidenceIds.has(id))), 'token evidence ids resolve');
  assert.ok(eds.quirks.every(q => q.evidence.every(id => evidenceIds.has(id))), 'finding evidence ids resolve');
  assert.deepEqual(eds.coverage.themes, ['Light', 'Dark']);
});

test('declared tokens merge across sources with modes, aliases and unresolved values', async () => {
  const {tokens} = assembleSystem(await inputs());
  const brand = tokens.find(t => t.path === '--brand')!;
  assert.equal(brand.value, '#0B5FD6');
  assert.equal(brand.evidence.length, 2, 'CSS and Figma both declare it');
  assert.deepEqual(brand.modes, {Light: '#0B5FD6', Dark: '#4D8CFF'});
  assert.equal(tokens.find(t => t.path === '--link')?.aliasOf, '--brand');
  assert.equal(tokens.find(t => t.path === '--gutter')?.status, 'unresolved');
});

test('scales and roles are inferred from usage and labelled with low confidence', async () => {
  const {scales, tokens} = assembleSystem(await inputs());
  assert.equal(scales.spacing.baseUnit, 8);
  assert.equal(scales.type?.ratio, 1.25);
  assert.deepEqual(scales.radius.map(r => r.name), ['sm', 'md']);
  const primary = tokens.find(t => t.path === 'color.primary')!;
  assert.equal(primary.value, '#0b5fd6');
  assert.ok(primary.confidence < 0.5, 'inferred roles stay in the Inferred band');
  assert.equal(tokens.find(t => t.path === 'font.family.heading')?.value, 'Inter Display', 'declared deck font wins for headings');
});

test('every Part 1 finding kind that applies is raised in plain language', async () => {
  const {quirks} = assembleSystem(await inputs());
  const kinds = new Set(quirks.map(q => q.kind));
  for (const kind of ['declared_observed_drift', 'near_duplicate_token', 'hardcoded_value', 'off_scale', 'contrast_fail', 'unresolved_value', 'coverage_gap', 'missing_state'] as const)
    assert.ok(kinds.has(kind), `expected a ${kind} finding`);
  assert.ok(quirks.some(q => q.kind === 'declared_observed_drift' && /#0052CC.*#0B5FD6/.test(q.summary)), 'deck accent differs from the site primary');
  assert.ok(quirks.some(q => q.kind === 'contrast_fail' && q.summary.startsWith('.badge-muted')));
  assert.ok(quirks.some(q => q.kind === 'off_scale' && /13px/.test(q.summary)));
  assert.ok(quirks.some(q => q.kind === 'missing_state' && /Button/.test(q.summary)), 'Figma button has no focus state');
  assert.ok(quirks.every(q => !/undefined|\[object/.test(q.summary)));
});

test('components merge across sources and brand prose is kept for Part 3', async () => {
  const system = assembleSystem(await inputs());
  const button = system.components.find(c => c.canonical === 'Button')!;
  assert.deepEqual(button.sizes, ['Small', 'Large']);
  assert.deepEqual(button.statesMissing, ['focus-visible']);
  assert.ok(system.brandSignals.logoAssets.some(name => /logo/.test(name)));
});

test('the same inputs always give the same fingerprint', async () => {
  assert.equal(systemFingerprint(assembleSystem(await inputs())), systemFingerprint(assembleSystem(await inputs())));
});

test('expressions resolve when every reference exists; missing and circular references do not', () => {
  const asset0 = asset('c', 'code', 'v.css');
  const tokens = (pairs: [string, string][]) => assembleSystem([{asset: asset0, result: {fetched: 1, failed: [], budgetHit: false, observations: pairs.map(([path, value]) => ({type: 'token' as const, channel: 'code_tokens' as const, path, value, locator: 'v.css'}))}}]).tokens;
  const status = Object.fromEntries(tokens([
    ['--rgb', '13, 110, 253'], ['--radius', '6px'], ['--bg', 'rgba(var(--rgb), .5)'], ['--inner', 'calc(var(--radius) - 1px)'],
    ['--fallback', 'var(--nope, 4px)'], ['--missing', 'var(--nope)'], ['--a', 'var(--b)'], ['--b', 'var(--a)'], ['--env', 'env(safe-area-inset-top)'],
  ]).map(t => [t.path, t.status]));
  assert.deepEqual(status, {'--rgb': 'resolved', '--radius': 'resolved', '--bg': 'resolved', '--inner': 'resolved', '--fallback': 'resolved', '--missing': 'unresolved', '--a': 'unresolved', '--b': 'unresolved', '--env': 'unresolved'});
});

test('rendered computed colours never count as hard-coding, and many near-duplicates become one finding', () => {
  const site = asset('s', 'url', 'site');
  const colors = Array.from({length: 12}, (_, i) => `#${(11 + i * 3).toString(16).padStart(2, '0')}${(95 + i * 3).toString(16)}D6`);
  const system = assembleSystem([{asset: site, result: {fetched: 1, failed: [], budgetHit: false, observations: [
    {type: 'token', channel: 'observed_css', path: '--brand', value: '#0B5FD6', locator: 'https://x :root'},
    ...colors.map((value, i) => ({type: 'color' as const, channel: 'observed_css' as const, rendered: true, value, property: 'background-color', selector: `div.c${i}`, locator: 'https://x @1440px'})),
  ]}}]);
  assert.ok(!system.quirks.some(q => q.kind === 'hardcoded_value'));
  const near = system.quirks.filter(q => q.kind === 'near_duplicate_token');
  assert.equal(near.length, 1);
  assert.match(near[0]!.summary, /pairs of colours are nearly identical/);
});
