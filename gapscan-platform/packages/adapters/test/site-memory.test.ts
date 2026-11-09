// Saved websites: pages read once are reused; an unfinished crawl continues where it stopped.
// The fixture server counts page requests, so "not read again" means the server never saw it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createSiteMemory, createUrlAdapter, siteKey, SITE_MEMORY_VERSION} from '@gapscan/adapters';
import type {KeyValueStore} from '@gapscan/adapters';

const PAGES: Record<string, string> = {'/': 'Home', '/docs/a': 'A', '/docs/b': 'B'};
const html = (title: string) => `<!doctype html><html><head><title>${title}</title><style>.btn{background:#0b5fd6;color:#fff;padding:8px 16px;border-radius:4px;border:0}
.btn:hover{background:#0a55c0}</style></head><body><h1>${title}</h1><button class="btn">Go</button>${Object.keys(PAGES).map(p => `<a href="${p}">${PAGES[p]}</a>`).join('')}</body></html>`;

async function site() {
  const pageRequests: string[] = [];
  const server = createServer((req, res) => {
    const title = PAGES[req.url ?? ''];
    if (!title) { res.writeHead(404); res.end(); return; }
    pageRequests.push(req.url!);
    res.writeHead(200, {'content-type': 'text/html'}); res.end(html(title));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pageRequests, close: () => new Promise(resolve => server.close(resolve))};
}
const memoryStore = (): KeyValueStore & {data: Map<string, Uint8Array>} => {
  const data = new Map<string, Uint8Array>();
  return {data, async get(key) { return data.get(key) ?? null; }, async put(key, value) { data.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); }};
};
const hasBrowser = await import('playwright').then(p => p.chromium.launch().then(b => b.close()).then(() => true)).catch(() => false);
const skip = !hasBrowser && 'Chromium for Playwright is not installed';

test('site keys ignore case, fragments and trailing slashes', () => {
  assert.equal(siteKey('https://Blush.Design/#top'), siteKey('https://blush.design'));
  assert.notEqual(siteKey('https://blush.design/'), siteKey('https://blush.design/docs'));
});

test('pages read once are reused, and a budget-limited crawl continues from the next page', {skip, timeout: 120_000}, async () => {
  const fixture = await site(), store = memoryStore(), memory = createSiteMemory(store);
  const adapter = createUrlAdapter({maxPages: 1, viewports: [1280], allowUrl: url => url.origin === fixture.origin, memory});
  const read = (refresh = false) => adapter({assetId: 'u', name: 'site', uri: fixture.origin + '/', bytes: new Uint8Array()}, {signal: new AbortController().signal, refresh});
  try {
    const first = await read();
    assert.deepEqual([first.fetched, first.budgetHit, first.reused], [1, true, undefined]);
    assert.deepEqual(fixture.pageRequests, ['/']);
    assert.deepEqual(await memory.info(fixture.origin + '/'), {...(await memory.info(fixture.origin + '/'))!, pages: 1, queued: 2, failed: 0});

    const second = await read();
    assert.deepEqual([second.fetched, second.reused, second.budgetHit], [2, 1, true], 'reused the home page and read one more');
    assert.deepEqual(fixture.pageRequests, ['/', '/docs/a'], 'the home page was not requested again');

    const third = await read();
    assert.deepEqual(fixture.pageRequests, ['/', '/docs/a', '/docs/b']);
    const fourth = await read();
    assert.deepEqual([fourth.fetched, fourth.reused, fourth.budgetHit], [3, 3, false]);
    assert.equal(fixture.pageRequests.length, 3, 'a fully saved site is not visited at all');
    assert.ok(third.observations.some(o => o.type === 'component' && o.name === 'Button'), 'components still come out of saved pages');
    assert.equal(JSON.stringify(fourth.observations.filter(o => o.type === 'component')), JSON.stringify(third.observations.filter(o => o.type === 'component')), 'saved pages give the same result');

    const fresh = await read(true);
    assert.equal(fresh.reused, undefined);
    assert.deepEqual(fixture.pageRequests.slice(3), ['/'], 'a fresh read starts over');
  } finally { await fixture.close(); }
});

test('a stopped read keeps what it finished and continues with the page it was on', {skip, timeout: 120_000}, async () => {
  const fixture = await site(), memory = createSiteMemory(memoryStore()), controller = new AbortController();
  const adapter = createUrlAdapter({maxPages: 5, viewports: [1280], allowUrl: url => url.origin === fixture.origin, memory});
  try {
    // Stop right after the first page is saved.
    await assert.rejects(adapter({assetId: 'u', name: 'site', uri: fixture.origin + '/', bytes: new Uint8Array()},
      {signal: controller.signal, progress: message => { if (/^rendered/.test(message)) controller.abort(); }}));
    const info = await memory.info(fixture.origin + '/');
    assert.deepEqual([info?.pages, info?.queued], [1, 2]);
    const resumed = await adapter({assetId: 'u', name: 'site', uri: fixture.origin + '/', bytes: new Uint8Array()}, {signal: new AbortController().signal});
    assert.deepEqual([resumed.fetched, resumed.reused, resumed.budgetHit], [3, 1, false]);
    assert.deepEqual(fixture.pageRequests.filter(p => p === '/'), ['/'], 'the finished page was not read twice');
  } finally { await fixture.close(); }
});

test('saved sites expire, and records from another reader version are not mixed in', async () => {
  const store = memoryStore();
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const memory = createSiteMemory(store, {maxAgeDays: 30, now: () => clock});
  await memory.saveState('https://example.com/', {version: '', start: '', startedAt: new Date(clock).toISOString(), updatedAt: '', done: [], seen: [], queue: ['https://example.com/a'], failed: []});
  assert.ok(await memory.load('https://example.com/'));
  clock += 31 * 86_400_000;
  assert.equal(await memory.load('https://example.com/'), null, 'older than 30 days: read again');
  assert.equal((await memory.info('https://example.com/'))?.stale, true);
  clock -= 31 * 86_400_000;
  const [key] = [...store.data.keys()];
  store.data.set(key!, new TextEncoder().encode(JSON.stringify({...JSON.parse(new TextDecoder().decode(store.data.get(key!)!)), version: 'site-0'})));
  assert.equal(await memory.load('https://example.com/'), null, `only ${SITE_MEMORY_VERSION} records are reused`);
});

test('once a site has the most pages kept for it, imports reuse them without reading more', {skip, timeout: 120_000}, async () => {
  const fixture = await site(), memory = createSiteMemory(memoryStore());
  const adapter = createUrlAdapter({maxPages: 5, maxSitePages: 2, viewports: [1280], allowUrl: url => url.origin === fixture.origin, memory});
  const read = () => adapter({assetId: 'u', name: 'site', uri: fixture.origin + '/', bytes: new Uint8Array()}, {signal: new AbortController().signal});
  try {
    const first = await read();
    assert.deepEqual([first.fetched, first.budgetHit], [2, true]);
    const messages: string[] = [];
    const second = await adapter({assetId: 'u', name: 'site', uri: fixture.origin + '/', bytes: new Uint8Array()}, {signal: new AbortController().signal, progress: m => { messages.push(m); }});
    assert.deepEqual([second.fetched, second.reused], [2, 2]);
    assert.equal(fixture.pageRequests.length, 2, 'nothing read the second time');
    assert.match(messages[0]!, /most kept for one site/);
  } finally { await fixture.close(); }
});
