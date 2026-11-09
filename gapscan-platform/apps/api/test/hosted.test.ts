import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {configFromEnv, createInfra, createPgliteClient} from '@gapscan/infra';
import type {JobEvent} from '@gapscan/schema';
import {buildApp} from '../src/app.ts';

const SYSTEM = `export interface ButtonProps { kind?: 'primary' | 'ghost'; size?: 'sm' | 'lg'; disabled?: boolean }
export function Button(props: ButtonProps) { return null; }`;

// An in-memory stand-in for S3 (request signing is covered in packages/infra/test/s3.test.ts).
function memoryS3() {
  const objects = new Map<string, Uint8Array>();
  const fetchImpl: typeof fetch = (async (url: URL, init: RequestInit) => {
    const key = new URL(url).pathname;
    if (init.method === 'PUT') { objects.set(key, new Uint8Array(init.body as Uint8Array)); return new Response(null, {status: 200}); }
    if (init.method === 'DELETE') { objects.delete(key); return new Response(null, {status: 204}); }
    const found = objects.get(key);
    return found ? new Response(found, {status: 200}) : new Response('<Error><Code>NoSuchKey</Code></Error>', {status: 404});
  }) as typeof fetch;
  return {objects, fetch: fetchImpl};
}

test('hosted mode: an API-only instance and a worker share Postgres and S3, and progress streams across them', {timeout: 60_000}, async () => {
  const sql = createPgliteClient(new PGlite()), s3 = memoryS3();
  const env = {GAPSCAN_STORE: 'postgres', GAPSCAN_DATABASE_URL: 'postgres://unused', GAPSCAN_BLOBS: 's3', GAPSCAN_S3_BUCKET: 'gapscan', GAPSCAN_S3_REGION: 'auto',
    GAPSCAN_S3_ENDPOINT: 'http://s3.test', GAPSCAN_S3_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test'};
  const apiInfra = await createInfra({...configFromEnv({...env, GAPSCAN_CONCURRENCY: '0'})}, {sql, fetch: s3.fetch});
  const workerInfra = await createInfra({...configFromEnv({...env, GAPSCAN_CONCURRENCY: '2'})}, {sql, fetch: s3.fetch});
  const api = buildApp({infra: apiInfra, heartbeatMs: 50}), worker = buildApp({infra: workerInfra});   // the worker registers the job handlers
  await api.listen({port: 0, host: '127.0.0.1'});
  const base = `http://127.0.0.1:${(api.server.address() as {port: number}).port}`;
  const json = async (method: string, url: string, payload?: object) => { const r = await api.inject({method: method as 'GET', url, ...(payload ? {payload} : {})}); return r.body ? JSON.parse(r.body) : null; };
  try {
    assert.deepEqual(await json('GET', '/healthz'), {ok: true});
    const project = await json('POST', '/v1/projects', {name: 'Acme'});
    await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'code', name: 'ui.tsx', content: SYSTEM});
    const {jobId} = await json('POST', `/v1/projects/${project.id}/extractions`);
    // Read the stream from the API instance while the worker instance does the work.
    const response = await fetch(`${base}/v1/jobs/${jobId}/events`), events: JobEvent[] = [];
    let buffer = '';
    for await (const chunk of response.body!) {
      buffer += new TextDecoder().decode(chunk);
      for (const frame of buffer.split('\n\n').slice(0, -1)) { const data = frame.split('\n').find(l => l.startsWith('data: ')); if (data) events.push(JSON.parse(data.slice(6))); }
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
    assert.equal(events.at(-1)?.body.type, 'complete', JSON.stringify(events.at(-1)));
    assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1), 'gap-free across instances');
    const job = await json('GET', `/v1/jobs/${jobId}`);
    assert.equal(job.status, 'completed');
    const eds = await json('GET', `/v1/extractions/${job.resultId}?include=full`);
    assert.ok(eds.components.some((c: {canonical: string}) => c.canonical === 'Button'));
    assert.ok([...s3.objects.keys()].some(k => k.startsWith('/gapscan/extractions/')), 'the extraction lives in object storage');

    const scan = await json('POST', '/v1/gapscans', {edsId: job.resultId, referenceId: 'mui-6.4.7'});
    await apiInfra.queue.idle();
    const report = await json('GET', `/v1/gapscans/${(await json('GET', `/v1/jobs/${scan.jobId}`)).resultId}`);
    assert.ok(report.items.some((i: {name: string}) => i.name === 'Button'));
    assert.deepEqual((await json('GET', `/v1/extractions/${job.resultId}/gapscans`)).map((r: {id: string}) => r.id), [report.id], 'listed from Postgres too');
  } finally {
    await api.close(); await worker.close(); await apiInfra.close(); await workerInfra.close(); await sql.close();
  }
});
