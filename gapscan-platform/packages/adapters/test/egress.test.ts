import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {connect, createServer as createTcpServer} from 'node:net';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EGRESS_CHROMIUM_ARGS, startEgressProxy} from '@gapscan/adapters';

const portOf = (server: {address(): unknown}) => (server.address() as AddressInfo).port;
// Sends one raw request to the proxy and returns the status line (and keeps the socket for tunnelling).
async function rawConnect(proxyUrl: string, line: string, auth: string | null) {
  const socket = connect(Number(new URL(proxyUrl).port), '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`${line}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
  const status = await new Promise<string>(resolve => socket.once('data', chunk => resolve(chunk.toString().split('\r\n')[0]!)));
  return {status, socket};
}

test('the proxy tunnels only authorised CONNECTs to vetted names on allowed ports', async () => {
  const echo = createTcpServer(socket => socket.pipe(socket));
  await new Promise<void>(r => echo.listen(0, '127.0.0.1', r));
  const port = portOf(echo);
  // The resolver stands in for the public-address check; 127.0.0.1 plays a vetted public address here.
  const proxy = await startEgressProxy({resolve: async host => host === 'site.test' ? '127.0.0.1' : null, ports: [port]});
  const auth = `Basic ${Buffer.from(`${proxy.launchProxy.username}:${proxy.launchProxy.password}`).toString('base64')}`;
  try {
    const ok = await rawConnect(proxy.launchProxy.server, `CONNECT site.test:${port} HTTP/1.1`, auth);
    assert.equal(ok.status, 'HTTP/1.1 200 Connection Established');
    ok.socket.write('ping');
    assert.equal(await new Promise<string>(r => ok.socket.once('data', d => r(d.toString()))), 'ping', 'bytes flow through the tunnel');
    ok.socket.destroy();

    assert.equal((await rawConnect(proxy.launchProxy.server, `CONNECT site.test:${port} HTTP/1.1`, null)).status, 'HTTP/1.1 407 Proxy Authentication Required', 'other local processes cannot use it');
    assert.equal((await rawConnect(proxy.launchProxy.server, `CONNECT site.test:${port} HTTP/1.1`, 'Basic d3Jvbmc6d3Jvbmc=')).status, 'HTTP/1.1 407 Proxy Authentication Required');
    assert.equal((await rawConnect(proxy.launchProxy.server, `CONNECT internal.test:${port} HTTP/1.1`, auth)).status, 'HTTP/1.1 403 Forbidden', 'the resolver refused it');
    assert.equal((await rawConnect(proxy.launchProxy.server, `CONNECT 127.0.0.1:${port} HTTP/1.1`, auth)).status, 'HTTP/1.1 403 Forbidden', 'IP literals never pass');
    assert.equal((await rawConnect(proxy.launchProxy.server, 'CONNECT site.test:22 HTTP/1.1', auth)).status, 'HTTP/1.1 403 Forbidden', 'other ports never pass');
    assert.equal((await rawConnect(proxy.launchProxy.server, `GET http://site.test:${port}/ HTTP/1.1\r\nHost: site.test`, auth)).status, 'HTTP/1.1 403 Forbidden', 'no plain-HTTP proxying');
    assert.ok(proxy.refused.includes('internal.test'));
  } finally { await proxy.close(); echo.close(); }
});

// Real Chromium through the proxy. `site.test` exists in no DNS: the page loads only because
// the proxy resolved it, which shows the browser no longer resolves names itself.
test('Chromium reaches sites only through the proxy, and never loopback services directly', {timeout: 60_000}, async t => {
  let playwright: typeof import('playwright');
  try { playwright = await import('playwright'); } catch { t.skip('Playwright is not installed'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'egress-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=site.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], {stdio: 'ignore'});
  const site = createHttpsServer({key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem'))}, (_req, res) => res.end('<h1>hello from site.test</h1>'));
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  let internalHits = 0;
  const internal = createHttpServer((_req, res) => { internalHits++; res.end('secret'); });
  await new Promise<void>(r => internal.listen(0, '127.0.0.1', r));
  const proxy = await startEgressProxy({resolve: async host => host === 'site.test' ? '127.0.0.1' : null, ports: [portOf(site)]});
  let browser;
  try { browser = await playwright.chromium.launch({args: EGRESS_CHROMIUM_ARGS, proxy: proxy.launchProxy}); }
  catch { t.skip('Chromium is not installed'); await proxy.close(); site.close(); internal.close(); return; }
  try {
    const page = await (await browser.newContext({ignoreHTTPSErrors: true})).newPage();
    await page.goto(`https://site.test:${portOf(site)}/`);
    assert.equal(await page.textContent('h1'), 'hello from site.test');
    // Plain HTTP goes to the proxy too (loopback is not exempt), which answers 403 itself.
    for (const host of ['127.0.0.1', 'localhost']) {
      const response = await page.goto(`http://${host}:${portOf(internal)}/`).catch(() => null);
      assert.ok(!response || response.status() === 403, `${host}: ${response?.status()}`);
      assert.doesNotMatch(await page.content(), /secret/);
    }
    await assert.rejects(page.goto(`https://internal.test:${portOf(site)}/`), /ERR_TUNNEL_CONNECTION_FAILED/);
    assert.equal(internalHits, 0, 'the local service never saw a request');
  } finally { await browser.close(); await proxy.close(); site.close(); internal.close(); }
});
