// Ported from the prototype's engine/collect.mjs publicUrl: only public HTTPS
// hosts reach the fetchers, so a source URL cannot be used to probe the network
// GapScan runs on. Redirect targets must be re-checked with the same function.
const PRIVATE_HOST = /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|224\.|255\.)/;

export class UnsafeUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeUrlError'; }
}

export function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new UnsafeUrlError('Enter a valid public HTTPS URL.'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !host.includes('.')
    || PRIVATE_HOST.test(host) || /^(?:\d+\.){3}\d+$/.test(host) || host.includes(':') || /\.(?:local|internal|localhost)$/.test(host))
    throw new UnsafeUrlError('Use a public HTTPS website or repository URL; private addresses are unsupported.');
  url.hash = '';
  return url;
}

// Host names are only half the check: a public name can resolve to a private
// address. Every address a host resolves to must be public, or the request is
// refused (fail closed on DNS errors). Results are cached per host for one job.
const V4_PRIVATE: [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24],
  [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];
function v4Private(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  return V4_PRIVATE.some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
}
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return v4Private(ip);
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]!);
  if (ip === '::' || ip === '::1') return true;
  return /^(fc|fd|fe[89ab]|ff)/.test(ip) || ip.startsWith('64:ff9b:') || ip.startsWith('2001:db8:') || !ip.includes(':');
}

export type Lookup = (hostname: string) => Promise<{address: string}[]>;
export function createUrlGuard(lookup: Lookup): (url: URL) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return async url => {
    try { publicUrl(url.href); } catch { return false; }
    const host = url.hostname.toLowerCase();
    if (!cache.has(host)) cache.set(host, lookup(host).then(addresses => addresses.length > 0 && addresses.every(a => !isPrivateAddress(a.address)), () => false));
    return cache.get(host)!;
  };
}

// For the browser's egress proxy: the address to connect to for a host, or null. The first
// vetted answer is pinned for the whole job, so a host can't re-resolve somewhere private
// between the check and the connection. Every address must be public, as in the guard.
export function createPinnedResolver(lookup: Lookup): (hostname: string) => Promise<string | null> {
  const pinned = new Map<string, Promise<string | null>>();
  return hostname => {
    const host = hostname.toLowerCase();
    if (!pinned.has(host)) pinned.set(host, (async () => {
      try { publicUrl(`https://${host}/`); } catch { return null; }
      const addresses = await lookup(host).catch(() => []);
      return addresses.length && addresses.every(a => !isPrivateAddress(a.address)) ? addresses[0]!.address : null;
    })());
    return pinned.get(host)!;
  };
}
