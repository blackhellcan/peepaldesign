import test from 'node:test';
import assert from 'node:assert/strict';
import {buildObjects, contentHash, suggestPassingColor} from '@gapscan/objects';
import {contrastRatio} from '@gapscan/normalize';
import {ArchitecturalObject} from '@gapscan/schema';
import type {ComponentObservation, ExtractedDesignSystem, Token} from '@gapscan/schema';

const token = (path: string, value: string, type: Token['type'] = 'color', confidence = 0.9): Token => ({id: path, tier: 'semantic', path, type, value, status: 'resolved', evidence: ['ev:' + path], confidence, usageCount: 1});
const component = (canonical: string, category: string, missing: string[] = []): ComponentObservation => ({id: canonical, canonical, rawNames: [canonical], category, tier: 'primary', variants: [{name: 'primary', tokenRefs: {}}], sizes: ['sm'], statesObserved: ['hover'], statesMissing: missing, a11y: {focusVisible: missing.length ? false : true}, instances: 3, evidence: ['ev:c'], confidence: 0.8});
const eds: ExtractedDesignSystem = {
  id: 'e1', projectId: 'p', version: 1, fingerprint: 'f', createdAt: new Date().toISOString(), evidence: [], specimens: [], coverage: {perAsset: [], viewports: [], themes: []},
  sources: [{id: 's', projectId: 'p', kind: 'code', uri: 'inline:a.css', sha256: 'a'.repeat(64), bytes: 1, budget: {maxPages: 1, maxBytes: 1}, role: 'system', createdAt: new Date().toISOString()}],
  tokens: [token('color.text', '#1A1A1A'), token('color.surface', '#FFFFFF'), token('color.primary', '#4A90E2'), token('color.danger', '#FF6B6B'), token('--brand', '#0B5FD6'),
    token('space.1', '4px', 'dimension'), token('space.2', '8px', 'dimension'), token('space.3', '16px', 'dimension'), token('font.family.body', 'Inter', 'fontFamily'), token('radius.md', '4px', 'radius')],
  components: [component('Button', 'Actions', ['focus-visible']), component('Text field', 'Forms and input'), component('Card', 'Data display')],
  quirks: [{id: 'q1', kind: 'contrast_fail', severity: 'major', subjectIds: ['.muted'], summary: '.muted text has 2.6:1 contrast against its background; WCAG AA needs 4.5:1 for body text.', evidence: ['ev:q']}],
  brandSignals: {voiceSnippets: ['We sound like a helpful expert, never a salesperson.'], logoAssets: ['acme-logo.png']},
};

test('suggested contrast fixes actually pass and keep the hue', () => {
  const fix = suggestPassingColor('#4A90E2', '#FFFFFF')!;
  assert.ok((contrastRatio(fix, '#FFFFFF') ?? 0) >= 4.5, fix);
  assert.equal(suggestPassingColor('var(--x)', '#fff'), null);
});

test('every object validates and drafts never count toward completeness', () => {
  const objects = buildObjects(eds);
  assert.deepEqual(objects.map(o => o.kind), ['accessibility', 'guidelines', 'principles', 'tooling', 'content', 'brand']);
  for (const object of objects) ArchitecturalObject.parse(object);
  const a11y = objects.find(o => o.kind === 'accessibility')!;
  assert.ok(a11y.completeness < 0.5, 'mostly drafts');
  const contrast = a11y.sections.find(s => s.id === 'contrast')!;
  assert.equal(contrast.provenance, 'extracted');
  assert.match(contrast.content, /White text on primary \| `#FFFFFF` on `#4A90E2` \| 3\.\d+:1 \| AA large text only \| Background `#/);
  assert.match(contrast.content, /Error text on surface .* Fails \| Text `#/);
  assert.match(contrast.content, /\.muted text has 2\.6:1/);
  assert.match(a11y.sections.find(s => s.id === 'focus')!.content, /Missing today on: Button\./);
  assert.match(a11y.sections.find(s => s.id === 'keyboard')!.content, /Enter and Space activate/);
});

test('sections are labelled by where they came from', () => {
  const objects = Object.fromEntries(buildObjects(eds).map(o => [o.kind, o]));
  assert.equal(objects.brand!.sections.find(s => s.id === 'mission')!.provenance, 'drafted');
  assert.match(objects.brand!.sections.find(s => s.id === 'mission')!.content, /does not invent strategy/);
  assert.equal(objects.content!.sections.find(s => s.id === 'voice')!.provenance, 'extracted');
  assert.ok(objects.principles!.sections.every(s => s.provenance === 'inferred'));
  assert.match(objects.principles!.sections[0]!.content, /Consistent rhythm|4px, 8px, 16px/);
  assert.match(objects.tooling!.sections.find(s => s.id === 'tokens')!.content, /"\$value": "#0b5fd6"/);
  assert.equal(objects.guidelines!.sections.filter(s => s.id.startsWith('component-')).length, 3);
});

test('approval makes a section count; changed content makes the approval stale', () => {
  const draft = buildObjects(eds).find(o => o.kind === 'accessibility')!.sections.find(s => s.id === 'target')!;
  const approved = buildObjects(eds, {'accessibility:target': {by: 'pm@example.com', at: new Date().toISOString(), hash: contentHash(draft.content)}}).find(o => o.kind === 'accessibility')!;
  assert.equal(approved.sections.find(s => s.id === 'target')!.approval?.by, 'pm@example.com');
  assert.ok(approved.completeness > buildObjects(eds).find(o => o.kind === 'accessibility')!.completeness);
  const stale = buildObjects(eds, {'accessibility:target': {by: 'x', at: new Date().toISOString(), hash: 'different'}}).find(o => o.kind === 'accessibility')!.sections.find(s => s.id === 'target')!;
  assert.equal(stale.stale, true);
  assert.equal(stale.approval, undefined);
});
