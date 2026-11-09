import test from 'node:test';
import assert from 'node:assert/strict';
import {diffComponents, matchComponent, runGapScan, sameOption, scoreCandidate, tokenCategories} from '@gapscan/gapscan';
import {GapScanReport} from '@gapscan/schema';
import type {ComponentObservation, ExtractedDesignSystem, ReferenceDS, Token} from '@gapscan/schema';

const now = new Date().toISOString();
function component(id: string, canonical: string, category: string, options: {variants?: string[]; sizes?: string[]; states?: string[]; props?: string[]; focus?: boolean | null; confidence?: number} = {}): ComponentObservation {
  return {
    id, canonical, rawNames: [canonical], category, tier: 'primary', variants: (options.variants ?? []).map(name => ({name, tokenRefs: {}})), sizes: options.sizes ?? [],
    statesObserved: options.states ?? [], statesMissing: [], ...(options.props ? {props: options.props.map(name => ({name, type: 'string'}))} : {}),
    a11y: {focusVisible: options.focus ?? null}, instances: 12, evidence: [], confidence: options.confidence ?? 0.8,
  };
}
const token = (path: string, value: string, type: Token['type'] = 'color', confidence = 0.9): Token => ({id: path, tier: 'semantic', path, type, value, status: 'resolved', evidence: [], confidence, usageCount: 1});
function system(components: ComponentObservation[], tokens: Token[] = []): ExtractedDesignSystem {
  return {id: 'eds', projectId: 'p', version: 1, fingerprint: 'f', createdAt: now, sources: [], evidence: [], tokens, components, specimens: [], quirks: [], coverage: {perAsset: [], viewports: [], themes: []}, brandSignals: {voiceSnippets: [], logoAssets: []}};
}
const reference = (components: ComponentObservation[], tokens: Token[] = []): ReferenceDS => ({...system(components, tokens), id: 'ref', library: 'Polaris', libraryVersion: '13.9.0', pinnedAt: now});

const polarisButton = component('t-btn', 'Button', 'Actions', {variants: ['primary', 'plain', 'critical'], sizes: ['slim', 'medium', 'large'], states: ['hover', 'focus-visible', 'disabled', 'loading'], props: ['variant', 'tone', 'loading']});
const polarisField = component('t-tf', 'Text field', 'Forms and input', {states: ['focus-visible', 'disabled', 'error']});
const polarisBadge = component('t-badge', 'Badge', 'Feedback and status', {variants: ['success', 'warning']});

test('options are compared by meaning, not spelling', () => {
  assert.equal(sameOption('Variant=Primary', 'primary'), 'same');
  assert.equal(sameOption('ghost', 'plain'), 'renamed');
  assert.equal(sameOption('danger', 'critical'), 'renamed');
  assert.equal(sameOption('sm', 'slim'), 'renamed');
  assert.equal(sameOption('primary', 'critical'), null);
});

test('a well-evidenced button match is confirmed; a name-only match is not', () => {
  const ours = component('s-btn', 'Btn', 'Actions', {variants: ['primary', 'ghost', 'danger'], sizes: ['sm', 'md', 'lg'], states: ['hover', 'disabled']});
  const match = matchComponent(ours, [polarisButton, polarisField, polarisBadge]);
  assert.equal(match.targetId, 't-btn');
  assert.equal(match.status, 'confirmed');
  assert.ok(match.score >= 75);
  const nameOnly = scoreCandidate(component('x', 'Badge', 'Miscellaneous'), polarisBadge);
  assert.ok(nameOnly.score < 50, `name alone scored ${nameOnly.score}`);
});

test('ambiguous candidates stay unresolved instead of guessing', () => {
  const twin = {...polarisButton, id: 't-btn-2', canonical: 'Button'};
  const match = matchComponent(component('s', 'Button', 'Actions', {variants: ['primary']}), [polarisButton, twin]);
  assert.equal(match.status, 'unresolved');
  assert.equal(match.targetId, null);
  assert.match(match.reasons[0]!, /Several possible matches/);
});

test('diffs turn into the rubric drivers with plain-language summaries', () => {
  const ours = component('s-btn', 'Btn', 'Actions', {variants: ['primary', 'ghost', 'gradient'], sizes: ['sm'], states: ['hover'], props: ['kind', 'isBusy'], focus: false});
  const diffs = diffComponents(ours, polarisButton);
  const by = (driver: string) => diffs.filter(d => d.driver === driver).map(d => d.summary);
  assert.deepEqual(by('variant_renamed'), ['Style “ghost” becomes “plain”', 'Size “sm” becomes “slim”']);
  assert.deepEqual(by('variant_missing'), ['Style “gradient” has no equivalent in Button']);
  assert.deepEqual(by('a11y_fix'), [], 'the reference brings keyboard focus with it');
  assert.deepEqual(by('state_missing'), [], 'every state we use exists in the reference');
  assert.deepEqual(diffs.filter(d => d.driver === null).map(d => d.summary), ['Gains a visible keyboard focus style built into Button', 'Gains the disabled state built into Button', 'Gains the loading state built into Button']);
  assert.deepEqual(by('prop_rename'), ['Prop “isBusy” becomes “loading”'], 'library naming differences are renames; `kind` values were already compared as styles');
  assert.equal(by('prop_semantic').length, 0);
  const custom = diffComponents(component('s', 'Btn', 'Actions', {states: ['hover', 'selected']}), polarisButton);
  assert.deepEqual(custom.filter(d => d.driver === 'state_missing').map(d => d.summary), ['Your selected state has no equivalent in Button; it must be built or dropped']);
  const neither = diffComponents(component('s', 'Btn', 'Actions', {focus: false}), component('t', 'Button', 'Actions', {states: ['hover']}));
  assert.deepEqual(neither.filter(d => d.driver === 'a11y_fix').map(d => d.summary), ['Needs a visible keyboard focus style; neither version has one']);
});

test('a full scan decides, estimates and totals with the shared rubric', () => {
  const source = system([
    component('s-btn', 'Btn', 'Actions', {variants: ['primary', 'ghost'], sizes: ['sm', 'md', 'lg'], states: ['hover', 'disabled'], focus: false}),
    component('s-tf', 'Text field', 'Forms and input', {states: ['focus-visible', 'disabled', 'error']}),
    component('s-carousel', 'Carousel', 'Media and identity'),
  ], [token('color.primary', '#0B5FD6'), token('--space-2', '8px', 'dimension'), token('color.palette.1', '#123456', 'color', 0.3)]);
  const report = runGapScan({source, reference: reference([polarisButton, polarisField, polarisBadge], [token('color.primary', '#2C6ECB')]), assumptions: {rate: 100, qaPct: 0}});
  GapScanReport.parse({id: 'r', ...report});
  const decision = Object.fromEntries(report.items.map(i => [i.name, i.decision]));
  assert.deepEqual(decision, {Btn: 'update', 'Text field': 'keep', Carousel: 'replace', Badge: 'optional'});
  const btn = report.items.find(i => i.name === 'Btn')!;
  assert.ok(btn.effort.level && btn.effort.level >= 2, 'renames plus missing states and focus');
  assert.ok(btn.quickWin === false || btn.effort.level! <= 2);
  assert.equal(report.items.find(i => i.name === 'Carousel')?.effort.level, null, 'replacements wait for a reviewer');
  assert.equal(report.items.find(i => i.name === 'Text field')?.effort.level, 1, 'kept components still need verification');
  assert.equal(report.totals.notEstimatedCount, 1);
  assert.deepEqual(report.tokenCategories, [{name: 'Colours', remappedTokens: 1}, {name: 'Spacing and sizing', remappedTokens: 1}]);
  assert.deepEqual(btn.tech?.tokenDiff, [{slot: 'color.primary', before: '#0B5FD6', after: '#2C6ECB', change: 'remap'}]);
  assert.ok(report.totals.available && Math.abs(report.totals.costLow - report.totals.low * 100) < 1, 'cost follows hours at the stated rate');
});

test('a reviewer approval confirms a replacement and lets it be estimated', () => {
  const source = system([component('s-carousel', 'Carousel', 'Media and identity')]);
  const report = runGapScan({source, reference: reference([polarisBadge]), approvals: new Map([['s-carousel', {targetId: null, by: 'pm@example.com'}]])});
  const carousel = report.items.find(i => i.name === 'Carousel')!;
  assert.equal(carousel.match.status, 'confirmed');
  assert.equal(carousel.decision, 'replace');
  assert.equal(carousel.effort.level, 5);
});

test('identical systems give an all-keep report, and scans are deterministic', () => {
  const ref = reference([polarisButton, polarisField]);
  const same = system([polarisButton, polarisField]);
  const a = runGapScan({source: same, reference: ref}), b = runGapScan({source: same, reference: ref});
  assert.deepEqual(a.items.map(i => i.decision), ['keep', 'keep']);
  assert.deepEqual(a, b);
});

test('inferred palette tokens are not counted as declared tokens to remap', () => {
  assert.deepEqual(tokenCategories([token('color.palette.4', '#111', 'color', 0.9), token('color.primary', '#222', 'color', 0.45)]), []);
});

test('projected previews swap only the reference role colours for yours', async () => {
  const {projectSpecimen} = await import('@gapscan/gapscan');
  const css = ':root{--p-brand:#303030;--p-text:#FFFFFF} .Polaris-Button{background:#303030;color:rgb(255,255,255);border:1px solid #303031} .x{color:#123456}';
  const {css: projected, substitutions} = projectSpecimen(css, [{before: '#0B5FD6', after: '#303030', change: 'remap'}, {before: '#1A1A1A', after: '#1A1A1A', change: 'same'}]);
  assert.match(projected, /--p-brand:#0B5FD6/);
  assert.match(projected, /background:#0B5FD6/);
  assert.match(projected, /border:1px solid #0B5FD6/, 'imperceptibly different shades follow the role');
  assert.match(projected, /color:#123456/, 'unrelated colours are untouched');
  assert.deepEqual(substitutions.map(s => s.to), ['#0B5FD6', '#0B5FD6']);
});

test('references read from type declarations never conclude anything about hover or focus styling', () => {
  const ours = component('s', 'Btn', 'Actions', {variants: ['primary'], states: ['hover', 'focus-visible', 'disabled'], focus: false});
  const typesOnly = component('t', 'Button', 'Actions', {variants: ['filled', 'text'], states: ['disabled']});
  const diffs = diffComponents(ours, typesOnly);
  assert.ok(!diffs.some(d => /hover|focus/.test(d.summary)), diffs.map(d => d.summary).join(' | '));
  assert.ok(diffs.some(d => d.summary === 'Style “primary” becomes “filled”'));
  assert.equal(sameOption('checked', 'selected'), 'renamed');
});

test('style and size props are priced once, and a default size maps to a single-size target', () => {
  const ours = {...component('s', 'Button', 'Actions', {variants: ['contained', 'text'], sizes: ['small', 'medium'], props: ['variant', 'size', 'startIcon']})};
  const target = component('t', 'Button', 'Actions', {variants: ['filled', 'text'], props: ['disabled', 'trailingIcon']});
  const diffs = diffComponents(ours, target);
  assert.deepEqual(diffs.filter(d => d.driver !== null).map(d => d.summary), [
    'Style “contained” becomes “filled”', 'Size “small” has no equivalent in Button', 'Prop “startIcon” has no direct equivalent; usage needs rework',
  ]);
});

test('native attributes a typed reference inherits without declaring are not reported missing', () => {
  const mine = component('s-tf', 'Text field', 'Forms and input', {states: ['disabled', 'error'], props: ['label', 'error', 'disabled', 'placeholder', 'onChange']});
  const typed = component('t-in', 'Input', 'Forms and input', {props: ['appearance', 'size', 'contentBefore']});   // Fluent's Input: disabled comes from <input>
  const summaries = diffComponents(mine, typed).map(d => d.summary);
  assert.ok(!summaries.some(s => /disabled|placeholder|onChange/.test(s)), summaries.join('\n'));
  assert.ok(summaries.some(s => /error state has no equivalent/.test(s)), 'a styled state the reference lacks is still reported');
  const css = component('t-css', 'Text field', 'Forms and input', {states: ['focus-visible']});
  assert.ok(diffComponents(mine, css).some(d => /disabled state has no equivalent/.test(d.summary)), 'a stylesheet without :disabled rules is still evidence');
});
