import test from 'node:test';
import assert from 'node:assert/strict';
import {pdfAdapter} from '@gapscan/adapters';
import type {Observation} from '@gapscan/adapters';
import {brandPdf} from './pdf-fixture.ts';

const context = {signal: new AbortController().signal};
const input = (bytes: Uint8Array) => ({assetId: 'a1', name: 'guide.pdf', uri: 'inline:guide.pdf', bytes});
const of = <T extends Observation['type']>(list: Observation[], type: T) => list.filter((o): o is Extract<Observation, {type: T}> => o.type === type);

test('reads labelled colour specs, vector swatches, type sizes, fonts and guidance prose', async () => {
  const pdf = brandPdf([
    {fill: [0, 82, 204], lines: [[28, 'Colour'], [11, 'Primary Blue'], [11, 'HEX #0052CC'], [11, 'CMYK 100 60 0 0'], [11, 'Pantone 2728 C'], [11, 'Signal Red'], [11, 'RGB 222 53 11']]},
    {lines: [[28, 'Voice and tone'], [11, 'We are clear, warm and direct in everything we write.'], [11, 'We avoid jargon unless our readers use it themselves.']]},
  ]);
  const result = await pdfAdapter(input(pdf), context);
  assert.equal(result.fetched, 2);
  const colors = of(result.observations, 'color');
  const blue = colors.find(c => c.value === '#0052CC' && c.name);
  assert.equal(blue?.name, 'Primary Blue');
  assert.match(blue?.raw ?? '', /CMYK 100 60 0 0; Pantone 2728 C/);
  assert.equal(colors.find(c => c.name === 'Signal Red')?.value, '#DE350B');
  assert.ok(colors.some(c => c.property === 'fill' && c.value === '#0052CC'), 'vector swatch fill is read');
  assert.ok(of(result.observations, 'font').some(f => f.size === '28pt'));
  assert.ok(of(result.observations, 'font').some(f => f.family === 'Helvetica'), 'embedded font name without weight suffix');
  const voice = of(result.observations, 'text').filter(t => t.kind === 'voice').map(t => t.text);
  assert.deepEqual(voice, ['We are clear, warm and direct in everything we write.', 'We avoid jargon unless our readers use it themselves.']);
});

test('CMYK-only print guides yield approximate screen colours, labelled as such', async () => {
  const result = await pdfAdapter(input(brandPdf([{lines: [[28, 'Palette'], [11, 'Ocean'], [11, 'C100 M60 Y0 K0']]}])), context);
  const ocean = of(result.observations, 'color').find(c => c.name === 'Ocean');
  assert.equal(ocean?.value, '#0066FF');
  assert.match(ocean?.raw ?? '', /approximate/);
});

test('non-PDF input is refused with a readable message', async () => {
  await assert.rejects(pdfAdapter(input(Buffer.from('hello')), context), /not a PDF/);
});
