import test from 'node:test';
import assert from 'node:assert/strict';
import {approximateCmyk, buildBrandKit, planAsset, renderAsset} from '@gapscan/assets';
import type {ExtractedDesignSystem, Token} from '@gapscan/schema';

const token = (path: string, value: string, type: Token['type'] = 'color'): Token => ({id: path, tier: 'semantic', path, type, value, status: 'resolved', evidence: [], confidence: 0.9, usageCount: 1});
const eds = (tokens: Token[]): ExtractedDesignSystem => ({id: 'e', projectId: 'p', version: 1, fingerprint: 'f', createdAt: new Date().toISOString(), sources: [], evidence: [], tokens, components: [], specimens: [], quirks: [], coverage: {perAsset: [], viewports: [], themes: []}, brandSignals: {voiceSnippets: [], logoAssets: []}});
const kit = buildBrandKit(eds([token('color.primary', '#005eff'), token('color.text', '#1A1A1A'), token('color.surface', '#FFFFFF'), token('font.family.body', 'Inter', 'fontFamily'), token('radius.md', '4px', 'radius')]), 'Blush & Co');

test('approximate CMYK for print, labelled as a starting point for a proof', () => {
  assert.deepEqual(approximateCmyk('#000000'), [0, 0, 0, 100]);
  assert.deepEqual(approximateCmyk('#ffffff'), [0, 0, 0, 0]);
  assert.deepEqual(approximateCmyk('#005eff'), [100, 63, 0, 0]);
  const check = planAsset('letterhead-a4', kit, {email: 'hi@blush.design'}).checks.find(c => c.rule === 'print-colours')!;
  assert.match(check.message, /primary #005eff ≈ C100 M63 Y0 K0.*Ask your printer for a proof/);
});

test('the letterhead fits the paper, escapes the letter and puts contact details in the footer', () => {
  const plan = planAsset('letterhead-letter', kit, {address: '1 Main St, Springfield', email: 'hi@blush.design', body: 'Dear Sam,\n<script>x</script>'});
  assert.deepEqual(plan.page, {width: '8.5in', height: '11in'});
  assert.match(plan.html, /@page \{ size: 8.5in 11in/);
  assert.match(plan.html, /Dear Sam,\n&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(plan.html, /<footer><span>1 Main St, Springfield<\/span><span>hi@blush.design<\/span><\/footer>/);
  assert.equal(planAsset('letterhead-a4', kit, {}).checks.find(c => c.rule === 'contact')?.pass, false, 'an empty footer is flagged');
});

test('the email signature is one table, inline-styled, under the Gmail limit, and only links what is valid', () => {
  const plan = planAsset('email-signature', kit, {name: 'Sam <b>Lee</b>', role: 'Designer', email: 'sam@blush.design', phone: '+1 (555) 010-2030', website: 'https://blush.design'});
  assert.doesNotMatch(plan.html, /<style|<script|<img|class=/, 'no stylesheet, scripts, images or classes');
  assert.match(plan.html, /Sam &lt;b&gt;Lee&lt;\/b&gt;/);
  assert.match(plan.html, /href="mailto:sam@blush.design"/);
  assert.match(plan.html, /href="tel:\+15550102030"/);
  assert.match(plan.html, /href="https:\/\/blush.design"/);
  assert.ok(plan.html.length < 10_000);
  assert.equal(plan.checks.find(c => c.rule === 'size')?.pass, true);
  const bad = planAsset('email-signature', kit, {email: 'javascript:alert(1)', website: 'http://insecure.test'});
  assert.doesNotMatch(bad.html, /javascript:|http:\/\/insecure/);
  assert.equal(bad.checks.find(c => c.rule === 'email')?.pass, false);
  assert.equal(bad.checks.find(c => c.rule === 'website')?.pass, false);
});

test('the print-shop business card adds bleed and eight crop marks on the trim lines', () => {
  const plan = planAsset('business-card-print', kit, {name: 'Sam Lee'});
  assert.deepEqual(plan.page, {width: '103mm', height: '73mm'});
  assert.equal(plan.html.match(/<i style="[^"]*solid #000"><\/i>/g)?.length, 8);
  for (const at of ['left:9mm', 'left:94mm', 'top:9mm', 'top:64mm']) assert.ok(plan.html.includes(at), `a mark at ${at} (6 mm slug + 3 mm bleed)`);
});

const browser = await import('playwright').then(p => p.chromium.launch()).catch(() => null);
test('letterheads and the print card render as PDFs of the right page size', {skip: !browser && 'Chromium for Playwright is not installed', timeout: 60_000}, async () => {
  const page = await browser!.newPage();
  const pt = (mm: number) => mm / 25.4 * 72;
  try {
    for (const [template, w, h] of [['letterhead-a4', pt(210), pt(297)], ['letterhead-letter', 612, 792], ['business-card-print', pt(103), pt(73)]] as const) {
      const pdf = await renderAsset(page, planAsset(template, kit, {email: 'hi@blush.design', body: 'Hello'}));
      const box = Buffer.from(pdf.bytes).toString('latin1').match(/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/);
      assert.ok(box && Math.abs(Number(box[1]) - w) < 2 && Math.abs(Number(box[2]) - h) < 2, `${template}: ${box?.[1]}×${box?.[2]} pt`);
    }
  } finally { await page.close(); await browser!.close(); }
});
