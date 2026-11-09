import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createScraplingAdapter, readHtml, resetScraplingCheck, scraplingAvailable} from '../src/scrapling.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-scrapling.mjs', import.meta.url));
const node = process.execPath;

test('reading HTML: stylesheets, inline styles and same-site links only, never anything run', () => {
  const {stylesheets, styles, links} = readHtml('<link href="/a.css" rel="stylesheet"><link rel="icon" href="/f.ico"><link rel=\'preload stylesheet\' href=\'https://cdn.example/b.css\'><style>.x{color:red}</style><script>alert(1)</script><a href="/docs#top">Docs</a><a href="https://other.example/">Other</a><a href="/file.pdf">PDF</a>', new URL('https://acme.example/page'));
  assert.deepEqual(stylesheets.map(u => u.href), ['https://acme.example/a.css', 'https://cdn.example/b.css']);
  assert.deepEqual(styles, ['.x{color:red}']);
  assert.deepEqual(links.map(u => u.href), ['https://acme.example/docs']);
});

test('the Scrapling reader: pages and stylesheets through the bridge, read as CSS, with failures kept', async () => {
  const progress: string[] = [];
  const adapter = createScraplingAdapter({python: node, script: FAKE, allowUrl: async url => url.protocol === 'https:' && url.hostname.endsWith('.example') && url.hostname !== 'blocked.example', resolve: async () => null, maxPages: 5});
  const result = await adapter({assetId: 'a', name: 'acme.example', uri: 'https://acme.example/', bytes: new Uint8Array()}, {signal: new AbortController().signal, progress: message => { progress.push(message); }});
  assert.equal(result.fetched, 3, 'home, its stylesheet and the about page (the stylesheet is read once)');
  assert.ok(result.observations.some(o => o.type === 'color' && /7c3aed/i.test(o.value)), 'colours from the stylesheet');
  assert.ok(result.observations.some(o => o.type === 'radius'), 'radius from the inline <style>');
  assert.ok(result.observations.some(o => o.type === 'component' && /btn/i.test(o.name)), 'components from CSS classes');
  assert.deepEqual(result.failed.map(f => f.locator), ['https://acme.example/missing', 'https://acme.example/archive'], 'other sites are never followed');
  assert.match(result.failed[1]!.reason, /different stylesheets/);
  assert.ok(!result.observations.some(o => o.type === 'color' && /337ab7/i.test(o.value)), 'an archived design is left out, and its links are not followed');
  assert.deepEqual([result.viewports, result.themes], [[], []], 'nothing rendered');
  assert.ok(progress.some(p => p.startsWith('Scrapling: reading /')));

  await assert.rejects(adapter({assetId: 'a', name: 'x', uri: 'https://blocked.example/', bytes: new Uint8Array()}, {signal: new AbortController().signal}), /Only public https/);
  await assert.rejects(adapter({assetId: 'a', name: 'x', uri: 'https://nothing.example/', bytes: new Uint8Array()}, {signal: new AbortController().signal}), /couldn’t read the site: The site answered 404/);
});

test('availability: on when the bridge answers, off with a reason when Scrapling is missing', async () => {
  resetScraplingCheck();
  assert.deepEqual(await scraplingAvailable(node, FAKE), {available: true});
  resetScraplingCheck();
  process.env.FAKE_SCRAPLING_MISSING = '1';
  try { assert.deepEqual(await scraplingAvailable(node, FAKE), {available: false, reason: 'Scrapling isn’t installed on this server.'}); }
  finally { delete process.env.FAKE_SCRAPLING_MISSING; resetScraplingCheck(); }
  assert.match((await scraplingAvailable('/no/such/python', FAKE)).reason ?? '', /No Python at “\/no\/such\/python”\. Set GAPSCAN_SCRAPLING_PYTHON/);
  resetScraplingCheck();
});
