import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {configFromEnv, createFsBlobStore, createInProcessQueue, createInfra, createLocalEventBus, createPgliteClient, createPostgresEventBus, createPostgresQueue, createPostgresStore, createSqliteStore, migrate} from '@gapscan/infra';
import type {EventBus, Queue, Store} from '@gapscan/infra';
import type {JobEvent} from '@gapscan/schema';

type Backend = {name: string; make(concurrency: number): Promise<{store: Store; bus: EventBus; queue: Queue; close(): Promise<void>}>};
const BACKENDS: Backend[] = [
  {name: 'sqlite', async make(concurrency) {
    const store = createSqliteStore(':memory:'), bus = createLocalEventBus(), queue = createInProcessQueue(store, bus, {concurrency});
    return {store, bus, queue, close: async () => { await queue.close(); await store.close(); }};
  }},
  {name: 'postgres', async make(concurrency) {
    const sql = createPgliteClient(new PGlite());
    await migrate(sql);
    const store = createPostgresStore(sql), bus = createPostgresEventBus(sql, store, {pollMs: 50});
    const queue = createPostgresQueue(store, sql, bus, {concurrency, pollMs: 20, heartbeatMs: 50});
    await bus.start(); await queue.start();
    return {store, bus, queue, close: async () => { await queue.close(); await bus.close(); await store.close(); }};
  }},
];
const contexts: {close(): Promise<void>}[] = [];
test.after(async () => { for (const c of contexts) await c.close(); });
async function setup(backend: Backend, concurrency = 1) {
  const context = await backend.make(concurrency);
  contexts.push(context);
  return {...context, project: await context.store.createProject('Acme')};
}
const types = (events: JobEvent[]) => events.map(e => e.body.type);

test('blob keys cannot escape the blob root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gapscan-blobs-'));
  try {
    const blobs = createFsBlobStore(dir);
    await blobs.put('sources/a.css', '.btn{}');
    assert.equal((await blobs.get('sources/a.css'))?.toString(), '.btn{}');
    assert.equal(await blobs.get('sources/missing.css'), null);
    await assert.rejects(blobs.put('../escape.txt', 'x'), /Unsafe blob key/);
    await assert.rejects(blobs.put('/etc/passwd', 'x'), /Unsafe blob key/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

for (const backend of BACKENDS) {
  test(`${backend.name}: accounts: one user per email, single-use login tokens, expiring sessions, project roles`, async () => {
    const {store, project} = await setup(backend);
    const ana = await store.ensureUser('  Ana@Example.com ');
    assert.equal(ana.email, 'ana@example.com');
    assert.equal((await store.ensureUser('ana@example.com')).id, ana.id);
    const later = '2999-01-01T00:00:00.000Z', earlier = '2000-01-01T00:00:00.000Z', at = new Date().toISOString();
    await store.saveLoginToken({hash: 'h1', email: ana.email, expiresAt: later, createdAt: at});
    await store.saveLoginToken({hash: 'h2', email: ana.email, expiresAt: earlier, createdAt: at});
    assert.equal(await store.countLoginTokens(ana.email, earlier), 2);
    assert.equal(await store.consumeLoginToken('h1', at), ana.email);
    assert.equal(await store.consumeLoginToken('h1', at), null, 'single use');
    assert.equal(await store.consumeLoginToken('h2', at), null, 'expired');
    await store.saveSession({hash: 's1', userId: ana.id, expiresAt: later, createdAt: at});
    await store.saveSession({hash: 's2', userId: ana.id, expiresAt: earlier, createdAt: at});
    assert.equal((await store.getSession('s1', at))?.userId, ana.id);
    assert.equal(await store.getSession('s2', at), null);
    await store.deleteSession('s1');
    assert.equal(await store.getSession('s1', at), null);
    const ben = await store.ensureUser('ben@example.com');
    await store.setMember(project.id, ana.id, 'owner');
    await store.setMember(project.id, ben.id, 'editor');
    assert.equal(await store.roleOf(project.id, ben.id), 'editor');
    assert.deepEqual((await store.listMembers(project.id)).map(m => [m.email, m.role]), [['ana@example.com', 'owner'], ['ben@example.com', 'editor']]);
    assert.deepEqual((await store.listProjectsFor(ben.id)).map(p => p.id), [project.id]);
    await store.removeMember(project.id, ben.id);
    assert.equal(await store.roleOf(project.id, ben.id), null);
    assert.deepEqual(await store.listProjectsFor(ben.id), []);
  });

  test(`${backend.name}: job events get gap-free per-job sequence numbers and replay after a cursor`, async () => {
    const {store, project} = await setup(backend);
    const job = await store.createJob({type: 'extract', projectId: project.id, payload: {}});
    for (let i = 0; i < 3; i++) await store.appendEvent(job.id, {type: 'progress', stage: 's', done: i, total: 3, message: ''});
    assert.deepEqual((await store.listEvents(job.id)).map(e => e.seq), [1, 2, 3]);
    assert.deepEqual((await store.listEvents(job.id, 2)).map(e => e.seq), [3]);
  });

  test(`${backend.name}: a job runs to completion and records progress then a terminal event`, async () => {
    const {store, queue, project} = await setup(backend);
    queue.register('extract', async ({progress}) => { await progress('parse', 1, 1, 'Parsed'); return {resultId: 'eds-1'}; });
    const job = await store.createJob({type: 'extract', projectId: project.id, payload: {}});
    await queue.enqueue(job);
    await queue.idle();
    assert.equal((await store.getJob(job.id))?.status, 'completed');
    assert.equal((await store.getJob(job.id))?.resultId, 'eds-1');
    assert.deepEqual(types(await store.listEvents(job.id)), ['progress', 'complete']);
  });

  test(`${backend.name}: handler errors become a failed job with a readable message`, async () => {
    const {store, queue, project} = await setup(backend);
    queue.register('extract', async () => { throw new Error('PDF is encrypted'); });
    const job = await store.createJob({type: 'extract', projectId: project.id, payload: {}});
    await queue.enqueue(job);
    await queue.idle();
    const failed = await store.getJob(job.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error?.message, 'PDF is encrypted');
  });

  test(`${backend.name}: cancelling stops a running job and removes a queued one`, async () => {
    const {store, queue, project} = await setup(backend, 1);
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    queue.register('extract', ({signal}) => new Promise((_, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    }));
    const first = await store.createJob({type: 'extract', projectId: project.id, payload: {}});
    const second = await store.createJob({type: 'extract', projectId: project.id, payload: {}});
    await queue.enqueue(first);
    await queue.enqueue(second);
    await running;
    assert.equal(await queue.cancel(second.id), true, 'queued job cancels');
    assert.equal(await queue.cancel(first.id), true, 'running job cancels');
    await queue.idle();
    assert.equal((await store.getJob(first.id))?.status, 'cancelled');
    assert.equal((await store.getJob(second.id))?.status, 'cancelled');
    assert.deepEqual(types(await store.listEvents(first.id)), ['cancelled']);
    assert.equal(await queue.cancel(first.id), false, 'a finished job cannot be cancelled again');
  });
}

test('jobs interrupted by a restart are failed as retryable instead of left running', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-infra-'));
  try {
    const first = await createInfra({...configFromEnv({}), dataDir});
    const project = await first.store.createProject('Acme');
    const job = await first.store.createJob({type: 'extract', projectId: project.id, payload: {}});
    await first.store.updateJob(job.id, {status: 'running'});
    await first.store.close();
    const second = await createInfra({...configFromEnv({}), dataDir});
    const recovered = await second.store.getJob(job.id);
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.error?.retryable, true);
    await second.close();
  } finally { await rm(dataDir, {recursive: true, force: true}); }
});

test('hosted settings are validated without echoing secrets', () => {
  assert.throws(() => configFromEnv({GAPSCAN_STORE: 'mysql'}), /GAPSCAN_STORE/);
  assert.throws(() => configFromEnv({GAPSCAN_STORE: 'postgres'}), /needs GAPSCAN_DATABASE_URL/);
  assert.throws(() => configFromEnv({GAPSCAN_QUEUE: 'postgres'}), /needs GAPSCAN_STORE=postgres/);
  assert.throws(() => configFromEnv({GAPSCAN_CONCURRENCY: '0'}), /at least 1/);
  assert.equal(configFromEnv({GAPSCAN_STORE: 'postgres', DATABASE_URL: 'postgres://u:p@db/x', GAPSCAN_CONCURRENCY: '0'}).queue, 'postgres', 'API-only instances are allowed on Postgres');
  try { configFromEnv({GAPSCAN_BLOBS: 's3', GAPSCAN_S3_BUCKET: 'b', AWS_SECRET_ACCESS_KEY: 'TOPSECRET'}); assert.fail(); }
  catch (error) { assert.match((error as Error).message, /needs GAPSCAN_S3_REGION, AWS_ACCESS_KEY_ID/); assert.doesNotMatch((error as Error).message, /TOPSECRET/); }
});
