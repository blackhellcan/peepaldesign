import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {createPgClient, createPostgresEventBus, createPostgresQueue, createPostgresStore, migrate} from '@gapscan/infra';
import type {JobEvent} from '@gapscan/schema';

// The production driver (`pg`) over the Postgres wire protocol, served by PGlite's socket
// server. That server gives every client the same backend, so notifications only reach
// the connection that sent them; this run therefore also proves the polling fallback.
test('the pg driver runs migrations, the store, a job and its event stream over the wire', {timeout: 30_000}, async () => {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({db, port: 0, host: '127.0.0.1', maxConnections: 4});
  await server.start();
  const port = Number(server.getServerConn().split(':').pop());
  // One pooled connection, so transactions never interleave on the shared backend.
  const sql = await createPgClient(`postgres://postgres@127.0.0.1:${port}/postgres`, {max: 1});
  try {
    assert.equal(await migrate(sql), 2);
    const store = createPostgresStore(sql), bus = createPostgresEventBus(sql, store, {pollMs: 50});
    const queue = createPostgresQueue(store, sql, bus, {concurrency: 1, pollMs: 50, heartbeatMs: 100});
    await bus.start(); await queue.start();
    queue.register('extract', async ({progress}) => { await progress('read', 1, 2, 'Reading'); await progress('read', 2, 2, 'Done'); return {resultId: 'eds-1'}; });
    const project = await store.createProject('Acme');
    assert.equal((await store.getProject(project.id))?.name, 'Acme');
    const job = await store.createJob({type: 'extract', projectId: project.id, payload: {n: 1}});
    const seen: JobEvent[] = [];
    const done = new Promise<void>(resolve => bus.subscribe(job.id, e => { seen.push(e); if (e.body.type === 'complete') resolve(); }));
    await queue.enqueue(job);
    await done;
    assert.deepEqual(seen.map(e => e.body.type), ['progress', 'progress', 'complete']);
    const finished = await store.getJob(job.id);
    assert.deepEqual([finished?.status, finished?.resultId, finished?.payload], ['completed', 'eds-1', {n: 1}], 'JSONB round-trips through the driver');
    await queue.close(); await bus.close();
  } finally { await sql.close(); await server.stop(); await db.close(); }
});
