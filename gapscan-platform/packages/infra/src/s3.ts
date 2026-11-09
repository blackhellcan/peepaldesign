// S3-compatible blob store (AWS S3, Cloudflare R2, MinIO…) over fetch, signed with
// Signature Version 4. Credentials only ever go into the Authorization header: never
// into URLs, error messages or logs.
import {createHash, createHmac} from 'node:crypto';
import type {BlobStore} from './types.ts';
import {SAFE_KEY} from './local.ts';

export type S3Credentials = {accessKeyId: string; secretAccessKey: string; sessionToken?: string};
export type S3Config = {bucket: string; region: string; credentials: S3Credentials; endpoint?: string; pathStyle?: boolean; prefix?: string; fetch?: typeof fetch; timeoutMs?: number};

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone).
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key: string) => key.split('/').map(encode).join('/');

// Returns the Authorization header for a request whose headers (host and x-amz-date
// included) are all signed. `amzDate` is YYYYMMDD'T'HHMMSS'Z'.
export function signV4({method, path, query = '', headers, payloadHash, region, service = 's3', credentials, amzDate}: {
  method: string; path: string; query?: string; headers: Record<string, string>; payloadHash: string; region: string; service?: string; credentials: S3Credentials; amzDate: string;
}): string {
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const canonical = [method, path, query, ...names.map(n => `${n}:${lower[n]}`), '', names.join(';'), payloadHash].join('\n');
  const day = amzDate.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
}

export function createS3BlobStore({bucket, region, credentials, endpoint, pathStyle = false, prefix = '', fetch: fetchImpl = fetch, timeoutMs = 30_000}: S3Config): BlobStore {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('The S3 bucket name is not valid.');
  const base = new URL(endpoint ?? `https://s3.${region}.amazonaws.com`);
  const urlFor = (key: string) => {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe blob key: ${key}`);
    const objectPath = `/${encodeKey(prefix + key)}`;
    return pathStyle ? new URL(`${base.origin}/${bucket}${objectPath}`) : new URL(`${base.protocol}//${bucket}.${base.host}${objectPath}`);
  };
  const request = async (method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Uint8Array) => {
    const url = urlFor(key), amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const payloadHash = sha256(body ?? '');
    const headers: Record<string, string> = {host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
      ...(credentials.sessionToken ? {'x-amz-security-token': credentials.sessionToken} : {})};
    headers.authorization = signV4({method, path: url.pathname, headers, payloadHash, region, credentials, amzDate});
    const {host: _host, ...sent} = headers;
    return fetchImpl(url, {method, headers: {...sent, ...(body ? {'content-type': 'application/octet-stream'} : {})}, ...(body ? {body} : {}), signal: AbortSignal.timeout(timeoutMs)});
  };
  // S3 errors are XML; only the code is kept, so nothing from the request is echoed back.
  const fail = async (response: Response, action: string): Promise<never> => {
    const code = (await response.text().catch(() => '')).match(/<Code>([^<]{1,64})<\/Code>/)?.[1] ?? response.statusText;
    throw new Error(`Blob storage ${action} failed (${response.status} ${code}).`);
  };
  return {
    async put(key, data) {
      const response = await request('PUT', key, typeof data === 'string' ? Buffer.from(data) : data);
      if (!response.ok) await fail(response, 'write');
      await response.arrayBuffer();
      return key;
    },
    async get(key) {
      const response = await request('GET', key);
      if (response.status === 404) { await response.arrayBuffer(); return null; }
      if (!response.ok) await fail(response, 'read');
      return Buffer.from(await response.arrayBuffer());
    },
    async delete(key) {
      const response = await request('DELETE', key);
      if (!response.ok && response.status !== 404) await fail(response, 'delete');
      await response.arrayBuffer();
    },
  };
}
