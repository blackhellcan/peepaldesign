import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBrandKit, onColor, planAsset, renderAsset} from '@gapscan/assets';
import type {ExtractedDesignSystem, Token} from '@gapscan/schema';

const token = (path: string, value: string, type: Token['type'] = 'color'): Token => ({id: path, tier: 'semantic', path, type, value, status: 'resolved', evidence: [], confidence: 0.9, usageCount: 1});
const eds = (tokens: Token[]): ExtractedDesignSystem => ({id: 'e', projectId: 'p', version: 1, fingerprint: 'f', createdAt: new Date().toISOString(), sources: [], evidence: [], tokens, components: [], specimens: [], quirks: [], coverage: {perAsset: [], viewports: [], themes: []}, brandSignals: {voiceSnippets: [], logoAssets: []}});
const acme = eds([token('color.primary', '#0B5FD6'), token('color.text', '#1A1A1A'), token('color.surface', '#FFFFFF'), token('font.family.body', 'Inter', 'fontFamily'), token('font.family.heading', 'Inter Display', 'fontFamily'), token('radius.md', '4px', 'radius')]);

test('the brand kit reads token slots and says which ones fell back to defaults', () => {
  const kit = buildBrandKit(acme, 'Acme');
  assert.deepEqual(kit.colors, {primary: '#0b5fd6', onPrimary: '#FFFFFF', text: '#1a1a1a', surface: '#ffffff', accent: '#0b5fd6'});
  assert.deepEqual(kit.fonts, {heading: 'Inter Display', body: 'Inter'});
  assert.deepEqual(kit.inferred, ['accent colour']);
  assert.ok(buildBrandKit(eds([])).inferred.includes('primary colour'));
  assert.equal(onColor('#FFD400'), '#111111');
});

test('templates escape user text, stay self-contained and report their checks', () => {
  const kit = buildBrandKit(acme, 'Acme');
  const card = planAsset('business-card', kit, {name: '<script>alert(1)</script>Jordan', role: 'Product Lead', email: 'jordan@acme.test'});
  assert.match(card.html, /&lt;script&gt;/);
  assert.doesNotMatch(card.html, /<script>alert/);
  assert.doesNotMatch(card.html, /https?:\/\//, 'no external resources');
  assert.match(card.html, /size: 91mm 61mm/, 'trim plus 3 mm bleed');
  assert.ok(card.checks.find(c => c.rule === 'name-contrast')?.pass);
  const og = planAsset('og-image', kit, {title: 'Design system 2.0', subtitle: 'Now on Polaris'});
  assert.ok(og.checks.find(c => c.rule === 'title-contrast')?.pass);
  assert.throws(() => planAsset('nope', kit, {}), /Unknown template/);
  const pale = planAsset('business-card', buildBrandKit(eds([token('color.primary', '#F5F5F5'), token('color.text', '#C0C0C0'), token('color.surface', '#FFFFFF'), token('font.family.body', 'Inter', 'fontFamily')])), {name: 'X'});
  assert.equal(pale.checks.find(c => c.rule === 'name-contrast')?.pass, false, 'unreadable text is flagged, not shipped silently');
});

const browser = await import('playwright').then(p => p.chromium.launch()).catch(() => null);
test('renders a print PDF and a PNG in an offline page', {skip: !browser && 'Chromium for Playwright is not installed', timeout: 60_000}, async () => {
  const page = await browser!.newPage();
  try {
    const kit = buildBrandKit(acme, 'Acme');
    const pdf = await renderAsset(page, planAsset('business-card', kit, {name: 'Jordan Lee', role: 'Product Lead', email: 'jordan@acme.test'}));
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(Buffer.from(pdf.bytes.subarray(0, 5)).toString(), '%PDF-');
    const mediaBox = Buffer.from(pdf.bytes).toString('latin1').match(/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/);
    assert.ok(mediaBox, 'has a page box');
    assert.ok(Math.abs(Number(mediaBox[1]) - 91 / 25.4 * 72) < 2 && Math.abs(Number(mediaBox[2]) - 61 / 25.4 * 72) < 2, `page is 91×61 mm (got ${mediaBox[1]}×${mediaBox[2]} pt)`);
    const png = await renderAsset(page, planAsset('og-image', kit, {title: 'Hello'}));
    assert.equal(png.contentType, 'image/png');
    assert.equal(Buffer.from(png.bytes).readUInt32BE(16), 1200);
    assert.equal(Buffer.from(png.bytes).readUInt32BE(20), 630);
  } finally { await page.close(); await browser!.close(); }
});

test('the slide deck carries the brand in its theme and reads back through the PPTX adapter', async () => {
  const {pptxAdapter} = await import('@gapscan/adapters');
  const {renderDeck} = await import('@gapscan/assets');
  const kit = buildBrandKit(acme, 'Acme & Co');
  const deck = renderDeck(kit, {title: 'Design system 2.0', subtitle: 'Q4 review', points: 'Faster; Accessible; Consistent'});
  assert.equal(deck.file, 'slide-deck.pptx');
  const read = await pptxAdapter({assetId: 'd', name: 'deck.pptx', uri: 'inline:deck.pptx', bytes: deck.bytes}, {signal: new AbortController().signal});
  assert.equal(read.fetched, 5);
  const colors = read.observations.filter(o => o.type === 'color') as {name?: string; value: string}[];
  assert.equal(colors.find(c => c.name === 'theme.accent1')?.value, '#0B5FD6');
  assert.equal(colors.find(c => c.name === 'theme.dk1')?.value, '#1A1A1A');
  const fonts = read.observations.filter(o => o.type === 'font') as {role?: string; family: string}[];
  assert.deepEqual(fonts.filter(f => f.role).map(f => [f.role, f.family]), [['heading', 'Inter Display'], ['body', 'Inter']]);
  assert.ok(read.observations.some(o => o.type === 'text' && o.text === 'Accessible'));
  const plan = planAsset('slide-deck', kit, {});
  assert.equal(plan.checks.find(c => c.rule === 'fonts')?.pass, false, 'brand fonts must be installed to present');
});

test('the email template is table-based, inline-styled, escaped and only links to https', () => {
  const kit = buildBrandKit(acme, 'Acme');
  const plan = planAsset('email', kit, {title: 'Q4 update', body: 'Line one\n<b>not bold</b>', cta: 'Read it', url: 'https://acme.test/q4'});
  assert.match(plan.html, /<table role="presentation" width="600"/);
  assert.match(plan.html, /background:#0b5fd6/);
  assert.match(plan.html, /Line one<br>&lt;b&gt;not bold&lt;\/b&gt;/);
  assert.match(plan.html, /href="https:\/\/acme.test\/q4"/);
  assert.ok(plan.checks.every(c => c.rule === 'brand-slots' || c.pass));
  const unsafe = planAsset('email', kit, {url: 'javascript:alert(1)'});
  assert.match(unsafe.html, /href="#"/);
  assert.equal(unsafe.checks.find(c => c.rule === 'link')?.pass, false);
});
