// Renders a local fixture site in headless Chromium. Skipped when Playwright's
// browser is not installed so the rest of the suite still runs anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createUrlAdapter} from '@gapscan/adapters';
import type {Observation} from '@gapscan/adapters';

const CSS = `:root { --brand: #0B5FD6; --space-2: 8px }
body { margin: 0; font: 16px/24px Arial, sans-serif; color: #1A1A1A; background: #FFFFFF }
h1 { font-size: 32px } .btn { background: var(--brand); color: #fff; padding: 8px 16px; border-radius: 4px; border: 0 }
.btn:hover { background: #0A55C0 } .btn:disabled { opacity: .5 }
.card { padding: 24px; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.1); margin-bottom: 16px }
input { padding: 8px; border: 1px solid #C4C4C4 }
@media (prefers-color-scheme: dark) { body { background: #121212; color: #EEEEEE } }`;
const page = (title: string, link: string) => `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/site.css"></head>
<body><h1>${title}</h1><div class="card"><p>Card text</p><button class="btn btn-primary">Save</button><input placeholder="Email"></div>
<a href="${link}">Next</a><img src="https://192.168.1.1/tracker.gif"></body></html>`;

async function site() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/site.css') { res.writeHead(200, {'content-type': 'text/css'}); res.end(CSS); return; }
    if (req.url === '/' || req.url === '/about') { res.writeHead(200, {'content-type': 'text/html'}); res.end(page(req.url === '/' ? 'Home' : 'About', req.url === '/' ? '/about' : '/')); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise(resolve => server.close(resolve))};
}

const hasBrowser = await import('playwright').then(p => p.chromium.launch().then(b => b.close()).then(() => true)).catch(() => false);
const of = <T extends Observation['type']>(list: Observation[], type: T) => list.filter((o): o is Extract<Observation, {type: T}> => o.type === type);

test('renders pages and reads computed styles, variables, components, dark mode and links', {skip: !hasBrowser && 'Chromium for Playwright is not installed', timeout: 90_000}, async () => {
  const fixture = await site();
  try {
    // Tests allow the local fixture origin; production passes the public-URL policy here.
    const adapter = createUrlAdapter({maxPages: 3, viewports: [1280, 375], allowUrl: url => url.origin === fixture.origin});
    const result = await adapter({assetId: 'u', name: 'site', uri: fixture.origin + '/', bytes: new Uint8Array()}, {signal: new AbortController().signal});
    assert.equal(result.fetched, 2, 'followed the same-origin link once');
    assert.deepEqual(result.viewports, [375, 1280]);
    assert.deepEqual(result.themes, ['light', 'dark']);
    const colors = of(result.observations, 'color');
    assert.ok(colors.some(c => c.property === 'background-color' && c.value === 'rgb(11, 95, 214)' && c.selector?.startsWith('button.btn')), 'computed button background');
    assert.ok(colors.some(c => c.value === 'rgb(18, 18, 18)' && /dark/.test(c.locator)), 'dark-mode background');
    assert.ok(of(result.observations, 'token').some(t => t.path === '--brand' && t.value === '#0B5FD6'));
    assert.ok(of(result.observations, 'font').some(f => f.size === '32px'));
    assert.ok(of(result.observations, 'radius').some(r => r.value === '4px'));
    const button = of(result.observations, 'component').find(c => c.name === 'Button')!;
    assert.deepEqual(button.states, ['hover', 'focus-visible', 'disabled'], 'hover is forced and measured; focus shows the browser ring; disabled comes from its stylesheet rule');
    const primary = button.variantStyles!.find(v => v.name === 'primary')!;
    assert.equal(primary.states?.hover?.background, 'rgb(10, 85, 192)', 'the hover look is the measured :hover background');
    assert.match(primary.screenshot ?? '', /^data:image\/png;base64,/, 'the variant is screenshotted at rest');
    assert.ok(of(result.observations, 'component').some(c => c.name === 'Text field'));
    assert.ok(!fixture.requests.includes('/tracker.gif'), 'private-network requests are blocked by the policy');
  } finally { await fixture.close(); }
});

test('refuses disallowed start URLs before launching anything', async () => {
  const adapter = createUrlAdapter({allowUrl: () => false});
  await assert.rejects(adapter({assetId: 'u', name: 'x', uri: 'https://example.com', bytes: new Uint8Array()}, {signal: new AbortController().signal}), /public HTTPS/);
});

test('the crawl stays in the start page section and version', async () => {
  const {sameSection, sharedPrefix} = await import('@gapscan/adapters');
  const start = new URL('https://getbootstrap.com/docs/5.3/components/buttons/');
  assert.equal(sameSection(start, new URL('https://getbootstrap.com/docs/5.3/forms/overview/')), true);
  assert.equal(sameSection(start, new URL('https://getbootstrap.com/docs/5.2/components/buttons/')), false);
  assert.equal(sameSection(start, new URL('https://blog.getbootstrap.com/')), false);
  assert.ok(sharedPrefix(start, new URL('https://getbootstrap.com/docs/5.3/components/badge/')) > sharedPrefix(start, new URL('https://getbootstrap.com/docs/5.3/')));
});
