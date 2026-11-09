// Egress proxy for headless Chromium. The browser sends every request here instead of
// resolving names itself; the proxy resolves each host once, through the caller's check,
// and connects to exactly that address. A name that later re-resolves to a private
// address (DNS rebinding) can't reach it, because the browser never connects on its own.
// HTTPS only (CONNECT tunnels; TLS stays end to end and is verified by the browser).
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {connect, isIP} from 'node:net';
import type {Socket} from 'node:net';

export type EgressProxy = {
  // For Playwright's `proxy` launch option. `bypass: '<-loopback>'` stops Chromium's built-in
  // exemption that would otherwise send localhost requests around the proxy.
  launchProxy: {server: string; username: string; password: string; bypass: string};
  refused: string[];
  close(): Promise<void>;
};
// Returns the vetted address to connect to, or null to refuse the host.
export type EgressResolver = (hostname: string) => Promise<string | null>;

export async function startEgressProxy({resolve, ports = [443], connectTimeoutMs = 15_000}: {resolve: EgressResolver; ports?: number[]; connectTimeoutMs?: number}): Promise<EgressProxy> {
  // Only this browser may use the proxy: other processes on the machine don't know the credential.
  const username = 'gapscan', password = randomBytes(18).toString('base64url');
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const authorised = (header: string | undefined) => { const got = Buffer.from(header ?? ''); return got.length === expected.length && timingSafeEqual(got, expected); };
  const refused: string[] = [], sockets = new Set<Socket>();
  const refuse = (socket: Socket, status: string, what: string) => { refused.push(what); socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); };

  const server = createServer((request, response) => {
    // Plain-HTTP proxying is never offered: only public HTTPS sites are read.
    refused.push(request.url ?? '');
    response.writeHead(authorised(request.headers['proxy-authorization']) ? 403 : 407, {'content-type': 'text/plain', 'proxy-authenticate': 'Basic realm="gapscan"'}).end('GapScan only fetches public HTTPS addresses.');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (request, client: Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    if (!authorised(request.headers['proxy-authorization'])) return refuse(client, '407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="gapscan"', request.url ?? '');
    const target = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(request.url ?? '');
    const host = target?.[1]?.toLowerCase(), port = Number(target?.[2]);
    // IP literals and unusual ports never pass: a public site is reached by name on 443.
    if (!host || isIP(host) || !ports.includes(port)) return refuse(client, '403 Forbidden', request.url ?? '');
    void resolve(host).catch(() => null).then(address => {
      if (!address || client.destroyed) return refuse(client, '403 Forbidden', host);
      const upstream = connect({host: address, port, timeout: connectTimeoutMs});
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.once('timeout', () => upstream.destroy(new Error('timeout')));
      upstream.once('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
      client.once('close', () => upstream.destroy());
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const {port} = server.address() as {port: number};
  return {
    launchProxy: {server: `http://127.0.0.1:${port}`, username, password, bypass: '<-loopback>'},
    refused,
    async close() { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); },
  };
}

// Chromium flags that keep traffic on the proxy: no direct UDP for WebRTC, no QUIC.
export const EGRESS_CHROMIUM_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'];
