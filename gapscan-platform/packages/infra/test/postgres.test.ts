import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createPgliteClient, createPostgresEventBus, createPostgresQueue, createPostgresStore, migrate, recordEvent} from '@gapscan/infra';
import type {SqlClient} from '@gapscan/infra';
import type {JobEvent} from '@gapscan/schema';

// Two "instances" share one database, as two processes would: each has its own store,
// bus and queue objects; only the database connects them.
async function database() {
  const sql = createPgliteClient(new PGlite());
  await migrate(sql);
  return sql;
}
async function instance(sql: SqlClient, concurrency: number, options: {staleMs?: number} = {}) {
  const store = createPostgresStore(sql), bus = createPostgresEventBus(sql, store, {pollMs: 50});
  const queue = createPostgresQueue(store, sql, bus, {concurrency, pollMs: 20, heartbeatMs: 30, ...options});
  await bus.start(); await queue.start();
  return {store, bus, queue, async close() { await queue.close(); await bus.close(); }};
}

test('migrations apply once and are safe to run again', async () => {
  const sql = await database();
  assert.equal(await migrate(sql), 2);
  assert.equal(await migrate(sql), 2);
  assert.deepEqual((await sql.query('SELECT version FROM gapscan_migrations')).map(r => r.version), [1, 2]);
  await sql.close();
});

test('an API-only instance enqueues; a worker instance runs each job exactly once', async () => {
  const sql = await database();
  const api = await instance(sql, 0), workerA = await instance(sql, 2), workerB = await instance(sql, 2);
  const runs = new Map<string, number>();
  for (const [name, w] of [['a', workerA], ['b', workerB]] as const) w.queue.register('extract', async ({job, progress}) => {
    runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
    await progress('work', 1, 1, `ran on ${name}`);
    return {resultId: `r-${job.id}`};
  });
  const project = await api.store.createProject('Acme');
  const jobs = [];
  for (let i = 0; i < 12; i++) { const job = await api.store.createJob({type: 'extract', projectId: project.id, payload: {i}}); await api.queue.enqueue(job); jobs.push(job); }
  await api.queue.idle();
  for (const job of jobs) {
    assert.equal(runs.get(job.id), 1, 'claimed by exactly one worker');
    assert.equal((await api.store.getJob(job.id))?.status, 'completed');
  }
  await api.close(); await workerA.close(); await workerB.close(); await sql.close();
});

test('events recorded by a worker reach a subscriber on another instance, in order and gap-free', async () => {
  const sql = await database();
  const api = await instance(sql, 0), worker = await instance(sql, 1);
  worker.queue.register('extract', async ({progress}) => { for (let i = 1; i <= 5; i++) await progress('s', i, 5, `step ${i}`); return {resultId: 'done'}; });
  const project = await api.store.createProject('Acme'), job = await api.store.createJob({type: 'extract', projectId: project.id, payload: {}});
  const seen: JobEvent[] = [];
  const finished = new Promise<void>(resolve => api.bus.subscribe(job.id, event => { seen.push(event); if (event.body.type === 'complete') resolve(); }));
  await api.queue.enqueue(job);
  await finished;
  assert.deepEqual(seen.map(e => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(seen.map(e => e.body.type), ['progress', 'progress', 'progress', 'progress', 'progress', 'complete']);
  await api.close(); await worker.close(); await sql.close();
});

test('a cancel sent to any instance stops the job where it runs', async () => {
  const sql = await database();
  const api = await instance(sql, 0), worker = await instance(sql, 1);
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  worker.queue.register('extract', ({signal}) => new Promise((_, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), {once: true}); }));
  const project = await api.store.createProject('Acme'), job = await api.store.createJob({type: 'extract', projectId: project.id, payload: {}});
  await api.queue.enqueue(job);
  await running;
  assert.equal(await api.queue.cancel(job.id), true);
  assert.equal(await api.queue.cancel(job.id), false, 'a second cancel is a no-op');
  await api.queue.idle();
  assert.equal((await api.store.getJob(job.id))?.status, 'cancelled');
  await api.close(); await worker.close(); await sql.close();
});

test('a job whose worker stopped sending heartbeats is failed as retryable by another instance', async () => {
  const sql = await database();
  const store = createPostgresStore(sql), project = await store.createProject('Acme');
  const job = await store.createJob({type: 'extract', projectId: project.id, payload: {}});
  // A worker claimed it and then died: running, with a heartbeat from long ago.
  await sql.query("UPDATE jobs SET status = 'running', worker = 'gone', heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [job.id]);
  const survivor = await instance(sql, 1, {staleMs: 1000});
  const recovered = await store.getJob(job.id);
  assert.equal(recovered?.status, 'failed');
  assert.equal(recovered?.error?.code, 'interrupted');
  assert.equal(recovered?.error?.retryable, true);
  assert.deepEqual((await store.listEvents(job.id)).map(e => e.body.type), ['failed']);
  await survivor.close(); await sql.close();
});

test('shutting a worker down mid-job leaves it retryable, not cancelled', async () => {
  const sql = await database();
  const worker = await instance(sql, 1);
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  worker.queue.register('extract', ({signal}) => new Promise((_, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), {once: true}); }));
  const project = await worker.store.createProject('Acme'), job = await worker.store.createJob({type: 'extract', projectId: project.id, payload: {}});
  await worker.queue.enqueue(job);
  await running;
  await worker.close();
  const stopped = await worker.store.getJob(job.id);
  assert.equal(stopped?.status, 'failed');
  assert.deepEqual([stopped?.error?.code, stopped?.error?.retryable], ['interrupted', true]);
  await sql.close();
});

test('per-job sequence numbers stay gap-free under concurrent writers', async () => {
  const sql = await database();
  const a = createPostgresStore(sql), b = createPostgresStore(sql), bus = {publish() {}, subscribe: () => () => {}};
  const project = await a.createProject('Acme'), job = await a.createJob({type: 'extract', projectId: project.id, payload: {}});
  await Promise.all(Array.from({length: 20}, (_, i) => recordEvent(i % 2 ? a : b, bus, job.id, {type: 'warning', message: String(i)})));
  assert.deepEqual((await a.listEvents(job.id)).map(e => e.seq), Array.from({length: 20}, (_, i) => i + 1));
  await sql.close();
});
