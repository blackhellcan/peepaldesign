import test from 'node:test';
import assert from 'node:assert/strict';
import {docxAdapter, openZip, parseXml, pptxAdapter, textOf, writeZip, ZIP_LIMITS} from '@gapscan/adapters';
import type {Observation} from '@gapscan/adapters';
import {docx, pptx} from './fixtures.ts';

const context = {signal: new AbortController().signal};
const input = (bytes: Uint8Array, name: string) => ({assetId: 'a1', name, uri: 'inline:' + name, bytes});
const of = <T extends Observation['type']>(list: Observation[], type: T) => list.filter((o): o is Extract<Observation, {type: T}> => o.type === type);

test('the ZIP reader round-trips content and verifies checksums', () => {
  const zip = openZip(writeZip({'a.txt': 'hello', 'dir/b.txt': 'x'.repeat(1000)}));
  assert.equal(zip.text('a.txt'), 'hello');
  assert.equal(zip.read('dir/b.txt').length, 1000);
  assert.equal(zip.text('missing.txt'), null);
  const stored = writeZip({'a.txt': 'hello'}, {deflate: false});
  stored[stored.indexOf('hello')] = 'j'.charCodeAt(0);
  assert.throws(() => openZip(stored).read('a.txt'), /integrity check/);
});

test('the ZIP reader rejects unsafe archives', () => {
  assert.throws(() => openZip(writeZip({'../evil.txt': 'x'})), /unsafe file path/);
  assert.throws(() => openZip(writeZip({'/etc/passwd': 'x'})), /unsafe file path/);
  assert.throws(() => openZip(Buffer.from('not a zip')), /not a valid ZIP/);
  const bomb = writeZip({'bomb.txt': '0'.repeat(ZIP_LIMITS.maxRatio * 2000)});
  assert.throws(() => openZip(bomb).read('bomb.txt'), /suspicious compression ratio/);
});

test('the XML reader handles namespaces, entities, CDATA and self-closing tags', () => {
  const doc = parseXml('<?xml version="1.0"?><!-- c --><a:root x="1 &amp; 2"><a:b/><c>T&lt;1<![CDATA[<raw>]]></c></a:root>');
  const root = doc.children[0]!;
  assert.equal(root.attrs.x, '1 & 2');
  assert.equal(root.children.length, 2);
  assert.equal(textOf(root.children[1]!), 'T<1<raw>');
});

test('PPTX: theme colours and fonts, slide usage, headings, layouts and logo assets', async () => {
  const result = await pptxAdapter(input(pptx(), 'brand.pptx'), context);
  assert.equal(result.fetched, 2);
  const colors = of(result.observations, 'color');
  assert.equal(colors.find(c => c.name === 'theme.accent1')?.value, '#0052CC');
  assert.equal(colors.find(c => c.name === 'theme.dk1')?.role, 'text');
  assert.equal(colors.find(c => c.name === 'theme.dk1')?.value, '#1A1A1A', 'system colours use their last known value');
  assert.equal(colors.find(c => c.property === 'fill' && c.value === '#0052CC')?.count, 2);
  const fonts = of(result.observations, 'font');
  assert.deepEqual(fonts.filter(f => f.role).map(f => [f.role, f.family]), [['heading', 'Inter Display'], ['body', 'Inter']]);
  assert.ok(fonts.some(f => f.size === '40pt' && f.family === 'Inter Display'));
  const texts = of(result.observations, 'text');
  assert.deepEqual(texts.filter(t => t.kind === 'heading').map(t => t.text), ['Acme brand', 'Our voice']);
  assert.ok(texts.some(t => t.text === 'We keep things simple & direct.'));
  assert.ok(texts.some(t => t.kind === 'rule' && /Title Slide/.test(t.text)));
  assert.deepEqual(of(result.observations, 'asset').map(a => a.kind), ['logo']);
});

test('DOCX: style fonts in points, style colours and guidance prose under the right headings', async () => {
  const result = await docxAdapter(input(docx(), 'guide.docx'), context);
  const fonts = of(result.observations, 'font');
  assert.ok(fonts.some(f => f.role === 'body' && f.family === 'Inter' && f.size === '11pt'));
  assert.ok(fonts.some(f => f.role === 'display' && f.size === '24pt' && f.weight === '700'));
  assert.ok(of(result.observations, 'color').some(c => c.value === '#0052CC' && c.name === 'style.heading 1'));
  const texts = of(result.observations, 'text');
  assert.deepEqual(texts.filter(t => t.kind === 'voice').map(t => t.text), ['We sound like a helpful expert, never a salesperson.']);
  assert.ok(!texts.some(t => /clear space/.test(t.text) && t.kind !== 'heading'), 'logo prose is not voice guidance');
});

test('Office adapters refuse the wrong document type', async () => {
  await assert.rejects(pptxAdapter(input(docx(), 'x.pptx'), context), /not a PowerPoint/);
  await assert.rejects(docxAdapter(input(pptx(), 'x.docx'), context), /not a Word/);
});
