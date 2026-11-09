import {join} from 'node:path';
import type {BlobStore, EventBus, Queue, Store} from './types.ts';
import {createSqliteStore} from './sqlite-store.ts';
import {createFsBlobStore, createInProcessQueue, createLocalEventBus, recordEvent} from './local.ts';

export * from './types.ts';
export {createSqliteStore} from './sqlite-store.ts';
export {createFsBlobStore, createInProcessQueue, createLocalEventBus, recordEvent} from './local.ts';
export {createPgClient, createPgliteClient, createPostgresEventBus, createPostgresQueue, createPostgresStore, migrate} from './postgres.ts';
export type {SqlClient} from './postgres.ts';
export {createS3BlobStore, signV4} from './s3.ts';
export type {S3Config} from './s3.ts';
import {createPgClient, createPostgresEventBus, createPostgresQueue, createPostgresStore, migrate} from './postgres.ts';
import type {SqlClient} from './postgres.ts';
import {createS3BlobStore} from './s3.ts';
import type {S3Config} from './s3.ts';

export type InfraConfig = {
  dataDir: string;
  store: 'sqlite' | 'postgres';
  queue: 'in-process' | 'postgres';
  blobs: 'fs' | 's3';
  concurrency: number;              // jobs this instance runs at once; 0 = API only (Postgres queue)
  databaseUrl?: string;
  s3?: Omit<S3Config, 'fetch' | 'timeoutMs'>;
};
export type Infra = {store: Store; blobs: BlobStore; bus: EventBus; queue: Queue; close(): Promise<void>};

// Settings come from the environment. Error messages name the setting, never its value,
// because the database URL and the S3 keys are secrets.
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): InfraConfig {
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T => {
    if (value === undefined || value === '') return fallback;
    if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}.`);
    return value as T;
  };
  const store = pick(env.GAPSCAN_STORE, ['sqlite', 'postgres'], 'sqlite', 'GAPSCAN_STORE');
  const queue = pick(env.GAPSCAN_QUEUE, ['in-process', 'postgres'], store === 'postgres' ? 'postgres' : 'in-process', 'GAPSCAN_QUEUE');
  const blobs = pick(env.GAPSCAN_BLOBS, ['fs', 's3'], 'fs', 'GAPSCAN_BLOBS');
  const databaseUrl = env.GAPSCAN_DATABASE_URL || env.DATABASE_URL || undefined;
  if (store === 'postgres' && !databaseUrl) throw new Error('GAPSCAN_STORE=postgres needs GAPSCAN_DATABASE_URL (or DATABASE_URL).');
  if (queue === 'postgres' && store !== 'postgres') throw new Error('GAPSCAN_QUEUE=postgres needs GAPSCAN_STORE=postgres: jobs live in the same database.');
  const concurrency = env.GAPSCAN_CONCURRENCY === undefined || env.GAPSCAN_CONCURRENCY === '' ? 2 : Number(env.GAPSCAN_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < (queue === 'postgres' ? 0 : 1)) throw new Error(`GAPSCAN_CONCURRENCY must be a whole number of at least ${queue === 'postgres' ? 0 : 1}.`);
  let s3: InfraConfig['s3'];
  if (blobs === 's3') {
    const missing = ['GAPSCAN_S3_BUCKET', 'GAPSCAN_S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter(name => !env[name]);
    if (missing.length) throw new Error(`GAPSCAN_BLOBS=s3 needs ${missing.join(', ')}.`);
    s3 = {bucket: env.GAPSCAN_S3_BUCKET!, region: env.GAPSCAN_S3_REGION!, prefix: env.GAPSCAN_S3_PREFIX ?? '', pathStyle: env.GAPSCAN_S3_PATH_STYLE === '1',
      ...(env.GAPSCAN_S3_ENDPOINT ? {endpoint: env.GAPSCAN_S3_ENDPOINT} : {}),
      credentials: {accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, ...(env.AWS_SESSION_TOKEN ? {sessionToken: env.AWS_SESSION_TOKEN} : {})}};
  }
  return {dataDir: env.GAPSCAN_DATA_DIR || join(process.cwd(), '.data'), store, queue, blobs, concurrency, ...(databaseUrl ? {databaseUrl} : {}), ...(s3 ? {s3} : {})};
}

// `sql` and `fetch` are for tests (PGlite, a fake S3); production builds them from the config.
export async function createInfra(config: InfraConfig, {sql: injected, fetch: fetchImpl}: {sql?: SqlClient; fetch?: typeof fetch} = {}): Promise<Infra> {
  const blobs = config.blobs === 's3'
    ? createS3BlobStore({...config.s3!, ...(fetchImpl ? {fetch: fetchImpl} : {})})
    : createFsBlobStore(join(config.dataDir, 'blobs'));

  if (config.store === 'postgres') {
    const sql = injected ?? await createPgClient(config.databaseUrl!);
    await migrate(sql);
    const store = createPostgresStore(sql), bus = createPostgresEventBus(sql, store);
    await bus.start();
    // The Postgres queue recovers on its own: jobs whose worker stopped sending heartbeats are failed as retryable.
    let queue: Queue;
    if (config.queue === 'postgres') { const shared = createPostgresQueue(store, sql, bus, {concurrency: config.concurrency}); await shared.start(); queue = shared; }
    else { queue = createInProcessQueue(store, bus, {concurrency: config.concurrency}); await failInterrupted(store, bus); }
    // An injected client belongs to the caller (several instances may share it in tests).
    return {store, blobs, bus, queue, async close() { await queue.close(); await bus.close(); if (!injected) await store.close(); }};
  }

  const store = createSqliteStore(join(config.dataDir, 'gapscan.sqlite'));
  const bus = createLocalEventBus();
  const queue = createInProcessQueue(store, bus, {concurrency: config.concurrency});
  await failInterrupted(store, bus);
  return {store, blobs, bus, queue, async close() { await queue.close(); await store.close(); }};
}

// An in-process queue loses work on restart. Say so on the job rather than
// leaving it "running" forever; the client can resubmit.
async function failInterrupted(store: Store, bus: EventBus) {
  for (const job of await store.listUnfinishedJobs()) {
    const error = {code: 'interrupted', message: 'The server restarted before this job finished. Submit it again.', retryable: true};
    await store.updateJob(job.id, {status: 'failed', error});
    await recordEvent(store, bus, job.id, {type: 'failed', ...error});
  }
}
