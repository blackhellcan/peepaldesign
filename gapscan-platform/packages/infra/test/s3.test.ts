import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createS3BlobStore, signV4} from '@gapscan/infra';

const credentials = {accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'};
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// The worked examples in AWS's "Signature Calculations for the Authorization Header" documentation.
test('signatures match AWS’s published SigV4 examples', () => {
  const get = signV4({method: 'GET', path: '/test.txt', region: 'us-east-1', credentials, amzDate: '20130524T000000Z', payloadHash: EMPTY,
    headers: {host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z'}});
  assert.match(get, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const body = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
  const put = signV4({method: 'PUT', path: '/test%24file.text', region: 'us-east-1', credentials, amzDate: '20130524T000000Z', payloadHash: body,
    headers: {date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': body, 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY'}});
  assert.equal(put, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

// A minimal S3-compatible server: it re-signs each request with the shared secret and
// refuses any whose signature, payload hash or path differs.
async function fakeS3() {
  const objects = new Map<string, Buffer>(), seen: {method: string; path: string; host: string}[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks), url = new URL(req.url!, 'http://x');
    seen.push({method: req.method!, path: url.pathname, host: req.headers.host!});
    const auth = String(req.headers.authorization ?? ''), signed = auth.match(/SignedHeaders=([^,]+)/)?.[1]?.split(';') ?? [];
    const headers = Object.fromEntries(signed.map(h => [h, String(req.headers[h])]));
    const payloadHash = String(req.headers['x-amz-content-sha256']);
    const expected = signV4({method: req.method!, path: url.pathname, headers, payloadHash, region: 'auto', credentials, amzDate: String(req.headers['x-amz-date'])});
    const {createHash} = await import('node:crypto');
    if (auth !== expected || createHash('sha256').update(body).digest('hex') !== payloadHash) { res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); return; }
    const key = decodeURIComponent(url.pathname);
    if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200).end(); }
    else if (req.method === 'GET') { const o = objects.get(key); if (o) res.writeHead(200).end(o); else res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); }
    else if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, objects, seen, close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}

test('objects round-trip through an S3-compatible endpoint, signed and prefixed', async () => {
  const s3 = await fakeS3();
  try {
    const blobs = createS3BlobStore({bucket: 'gapscan-data', region: 'auto', endpoint: s3.endpoint, pathStyle: true, prefix: 'prod/', credentials});
    await blobs.put('extractions/v1_a-b.json', '{"ok":true}');
    assert.equal((await blobs.get('extractions/v1_a-b.json'))?.toString(), '{"ok":true}');
    assert.equal(s3.seen[0]!.path, '/gapscan-data/prod/extractions/v1_a-b.json');
    assert.ok(s3.objects.has('/gapscan-data/prod/extractions/v1_a-b.json'));
    await blobs.put('bin/x.png', new Uint8Array([0, 255, 1]));
    assert.deepEqual([...(await blobs.get('bin/x.png'))!], [0, 255, 1]);
    assert.equal(await blobs.get('missing.json'), null);
    await blobs.delete('bin/x.png');
    assert.equal(await blobs.get('bin/x.png'), null);
    await assert.rejects(blobs.put('../escape', 'x'), /Unsafe blob key/);
  } finally { await s3.close(); }
});

test('a rejected request fails with the S3 error code only, never the credentials', async () => {
  const s3 = await fakeS3();
  try {
    const wrong = createS3BlobStore({bucket: 'gapscan-data', region: 'auto', endpoint: s3.endpoint, pathStyle: true, credentials: {...credentials, secretAccessKey: 'NOT-THE-SECRET'}});
    await assert.rejects(wrong.put('a.json', '{}'), (error: Error) => {
      assert.equal(error.message, 'Blob storage write failed (403 SignatureDoesNotMatch).');
      assert.doesNotMatch(error.message, /NOT-THE-SECRET|AKIA/);
      return true;
    });
    await assert.rejects(wrong.get('a.json'), /read failed \(403/, 'a permission problem is not mistaken for a missing object');
  } finally { await s3.close(); }
});

test('virtual-hosted addressing puts the bucket in the host name', async () => {
  const requests: string[] = [];
  const blobs = createS3BlobStore({bucket: 'my-bucket', region: 'eu-west-1', credentials, fetch: (async (url: URL) => { requests.push(String(url)); return new Response(null, {status: 404}); }) as typeof fetch});
  assert.equal(await blobs.get('k/v.json'), null);
  assert.deepEqual(requests, ['https://my-bucket.s3.eu-west-1.amazonaws.com/k/v.json']);
  assert.throws(() => createS3BlobStore({bucket: 'Bad_Bucket', region: 'x', credentials}), /bucket name/);
});
