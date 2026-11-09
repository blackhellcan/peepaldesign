// Hosted adapters on Postgres: the Store, a job queue (SKIP LOCKED claims, LISTEN/NOTIFY
// wake-ups, heartbeats so a crashed worker's jobs are failed as retryable) and an event bus
// that works across API instances. One database is the only service they need.
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Job as JobSchema, JobEvent as JobEventSchema, Project as ProjectSchema, SourceAsset as SourceAssetSchema} from '@gapscan/schema';
import type {Job, JobEvent, JobType} from '@gapscan/schema';
import type {EventBus, GapScanRecord, JobHandler, Queue, Role, Store} from './types.ts';
import {recordEvent} from './local.ts';

export type SqlRow = Record<string, unknown>;
type Query = <T extends SqlRow = SqlRow>(text: string, params?: unknown[]) => Promise<T[]>;
// The little the adapters need from a driver; `pg` in production, PGlite in tests.
export interface SqlClient {
  query: Query;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: {query: Query}) => Promise<T>): Promise<T>;
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

// A `pg` pool. LISTEN needs one dedicated connection, reopened if it drops; delivery
// does not depend on it (the bus and the queue also poll), it only makes it prompt.
export async function createPgClient(connectionString: string, {max = 10} = {}): Promise<SqlClient> {
  const {default: pg} = await import('pg');
  const pool = new pg.Pool({connectionString, max});
  pool.on('error', () => {});   // idle-client errors surface on the next query instead of crashing the process
  const channels = new Map<string, Set<(payload: string) => void>>();
  // Outside the pool, so a held LISTEN connection can never starve queries of a pool slot.
  let listener: import('pg').Client | null = null, closed = false;
  const connectListener = async (): Promise<void> => {
    if (closed || listener) return;
    const client = new pg.Client({connectionString});
    try {
      await client.connect();
      listener = client;
      client.on('notification', message => { for (const fn of channels.get(message.channel) ?? []) fn(message.payload ?? ''); });
      client.on('error', () => { listener = null; void client.end().catch(() => {}); setTimeout(() => void connectListener(), 1000).unref(); });
      for (const channel of channels.keys()) await client.query(`LISTEN ${channel}`);
    } catch { listener = null; void client.end().catch(() => {}); setTimeout(() => void connectListener(), 1000).unref(); }
  };
  const query: Query = async (text, params = []) => (await pool.query(text, params)).rows;
  return {
    query,
    async exec(sql) { await pool.query(sql); },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({query: async (text, params = []) => (await client.query(text, params)).rows});
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async listen(channel, onPayload) {
      if (!/^[a-z_]+$/.test(channel)) throw new Error('Invalid channel name.');
      const fresh = !channels.has(channel);
      channels.set(channel, (channels.get(channel) ?? new Set()).add(onPayload));
      if (!listener) await connectListener(); else if (fresh) await listener.query(`LISTEN ${channel}`);
      return async () => { channels.get(channel)?.delete(onPayload); };
    },
    async close() { closed = true; await listener?.end().catch(() => {}); listener = null; await pool.end(); },
  };
}

// PGlite: the same PostgreSQL in WebAssembly, in-process. For tests and single-machine trials.
type PgliteLike = {
  query<T>(text: string, params?: unknown[]): Promise<{rows: T[]}>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: {query<R>(text: string, params?: unknown[]): Promise<{rows: R[]}>}) => Promise<T>): Promise<T>;
  listen(channel: string, fn: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
};
export function createPgliteClient(db: PgliteLike): SqlClient {
  return {
    query: async <T extends SqlRow>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows,
    async exec(sql) { await db.exec(sql); },
    transaction: fn => db.transaction(tx => fn({query: async <T extends SqlRow>(text: string, params: unknown[] = []) => (await tx.query<T>(text, params)).rows})),
    listen: (channel, fn) => db.listen(channel, fn),
    close: () => db.close(),
  };
}

// Numbered migrations, applied once each under an advisory lock so instances starting
// together don't race. Dates stay ISO text, exactly as the schemas define them.
const MIGRATIONS = [`
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data JSONB NOT NULL, created_at TEXT NOT NULL, ord BIGSERIAL);
CREATE INDEX sources_project ON sources(project_id, created_at, ord);
CREATE TABLE jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, data JSONB NOT NULL, ord BIGSERIAL,
  worker TEXT, heartbeat_at TIMESTAMPTZ, cancel_requested BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX jobs_queued ON jobs(ord) WHERE status = 'queued';
CREATE INDEX jobs_running ON jobs(heartbeat_at) WHERE status = 'running';
CREATE TABLE job_events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, body JSONB NOT NULL, PRIMARY KEY (job_id, seq));
CREATE TABLE extractions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  blob_key TEXT NOT NULL, summary JSONB NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, version));
CREATE TABLE gapscans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, extraction_id TEXT NOT NULL, reference_id TEXT NOT NULL, blob_key TEXT NOT NULL,
  summary JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE match_approvals (key TEXT PRIMARY KEY, eds_fingerprint TEXT NOT NULL, reference_id TEXT NOT NULL, source_id TEXT NOT NULL,
  target_id TEXT, approved_by TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX approvals_scope ON match_approvals(eds_fingerprint, reference_id);
`, `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE login_tokens (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX login_tokens_email ON login_tokens(email, created_at);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE project_members (project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
  added_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
CREATE INDEX members_user ON project_members(user_id);
`];
const LOCK_ID = 727_001;

export async function migrate(sql: SqlClient): Promise<number> {
  return sql.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await tx.query('CREATE TABLE IF NOT EXISTS gapscan_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const [row] = await tx.query<{v: number}>('SELECT COALESCE(MAX(version), 0)::int AS v FROM gapscan_migrations');
    for (let v = row!.v; v < MIGRATIONS.length; v++) {
      for (const statement of MIGRATIONS[v]!.split(';').map(s => s.trim()).filter(Boolean)) await tx.query(statement);
      await tx.query('INSERT INTO gapscan_migrations (version) VALUES ($1)', [v + 1]);
    }
    return MIGRATIONS.length;
  });
}

export const EVENTS_CHANNEL = 'gapscan_events', JOBS_CHANNEL = 'gapscan_jobs', CANCEL_CHANNEL = 'gapscan_cancel';
const str = (row: SqlRow, column: string) => String(row[column] ?? '');
const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as unknown : value;
const gapScanRow = (row: SqlRow): GapScanRecord => ({id: str(row, 'id'), projectId: str(row, 'project_id'), extractionId: str(row, 'extraction_id'), referenceId: str(row, 'reference_id'), blobKey: str(row, 'blob_key'),
  summary: json(row.summary) as Record<string, unknown>, createdAt: str(row, 'created_at'), updatedAt: str(row, 'updated_at')});

export function createPostgresStore(sql: SqlClient): Store {
  const now = () => new Date().toISOString();
  const toJob = (row: SqlRow | undefined) => row ? JobSchema.parse(json(row.data)) : null;
  const toExtraction = (row: SqlRow) => ({id: str(row, 'id'), projectId: str(row, 'project_id'), version: Number(row.version), fingerprint: str(row, 'fingerprint'),
    blobKey: str(row, 'blob_key'), summary: json(row.summary) as Record<string, unknown>, createdAt: str(row, 'created_at')});
  const toEvent = (row: SqlRow): JobEvent => JobEventSchema.parse({jobId: str(row, 'job_id'), seq: Number(row.seq), at: str(row, 'at'), body: json(row.body)});
  return {
    async createProject(name) {
      const project = ProjectSchema.parse({id: randomUUID(), name, createdAt: now()});
      await sql.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $2, $3)', [project.id, project.name, project.createdAt]);
      return project;
    },
    async getProject(id) {
      const [row] = await sql.query('SELECT id, name, created_at FROM projects WHERE id = $1', [id]);
      return row ? ProjectSchema.parse({id: str(row, 'id'), name: str(row, 'name'), createdAt: str(row, 'created_at')}) : null;
    },
    async renameProject(id, name) {
      const [row] = await sql.query('UPDATE projects SET name = $1 WHERE id = $2 RETURNING id, name, created_at', [name, id]);
      return row ? ProjectSchema.parse({id: str(row, 'id'), name: str(row, 'name'), createdAt: str(row, 'created_at')}) : null;
    },
    async listProjects() {
      return (await sql.query('SELECT id, name, created_at FROM projects ORDER BY created_at DESC'))
        .map(row => ProjectSchema.parse({id: str(row, 'id'), name: str(row, 'name'), createdAt: str(row, 'created_at')}));
    },
    async addSource(source) {
      const parsed = SourceAssetSchema.parse(source);
      await sql.query('INSERT INTO sources (id, project_id, data, created_at) VALUES ($1, $2, $3, $4)', [parsed.id, parsed.projectId, JSON.stringify(parsed), parsed.createdAt]);
    },
    async listSources(projectId) {
      return (await sql.query('SELECT data FROM sources WHERE project_id = $1 ORDER BY created_at, ord', [projectId])).map(row => SourceAssetSchema.parse(json(row.data)));
    },
    async createJob({type, projectId, subjectId, payload}) {
      const at = now();
      const job = JobSchema.parse({id: randomUUID(), type, projectId, ...(subjectId ? {subjectId} : {}), status: 'queued', payload, createdAt: at, updatedAt: at});
      await sql.query('INSERT INTO jobs (id, project_id, type, status, data) VALUES ($1, $2, $3, $4, $5)', [job.id, job.projectId, job.type, job.status, JSON.stringify(job)]);
      return job;
    },
    async getJob(id) { return toJob((await sql.query('SELECT data FROM jobs WHERE id = $1', [id]))[0]); },
    async updateJob(id, patch) {
      return sql.transaction(async tx => {
        const current = toJob((await tx.query('SELECT data FROM jobs WHERE id = $1 FOR UPDATE', [id]))[0]);
        if (!current) throw new Error(`Job ${id} not found.`);
        const next = JobSchema.parse({...current, ...patch, updatedAt: now()});
        await tx.query('UPDATE jobs SET status = $2, data = $3 WHERE id = $1', [id, next.status, JSON.stringify(next)]);
        return next;
      });
    },
    async listUnfinishedJobs() {
      return (await sql.query("SELECT data FROM jobs WHERE status IN ('queued', 'running') ORDER BY ord")).map(row => toJob(row)!);
    },
    async listRecentJobs(limit) {
      return (await sql.query('SELECT data FROM jobs ORDER BY ord DESC LIMIT $1', [limit])).map(row => toJob(row)!);
    },
    async appendEvent(jobId, body) {
      // The job row lock serialises writers, so per-job sequence numbers stay gap-free across
      // instances. The notification is sent on commit, never for an event that rolled back.
      return sql.transaction(async tx => {
        await tx.query('SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
        const [last] = await tx.query<{seq: number}>('SELECT COALESCE(MAX(seq), 0)::int AS seq FROM job_events WHERE job_id = $1', [jobId]);
        const event = JobEventSchema.parse({jobId, seq: last!.seq + 1, at: now(), body});
        await tx.query('INSERT INTO job_events (job_id, seq, at, body) VALUES ($1, $2, $3, $4)', [jobId, event.seq, event.at, JSON.stringify(body)]);
        await tx.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, `${jobId}:${event.seq}`]);
        return event;
      });
    },
    async listEvents(jobId, afterSeq = 0) {
      return (await sql.query('SELECT job_id, seq, at, body FROM job_events WHERE job_id = $1 AND seq > $2 ORDER BY seq', [jobId, afterSeq])).map(toEvent);
    },
    async saveExtraction(r) {
      await sql.query('INSERT INTO extractions (id, project_id, version, fingerprint, blob_key, summary, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [r.id, r.projectId, r.version, r.fingerprint, r.blobKey, JSON.stringify(r.summary), r.createdAt]);
    },
    async getExtraction(id) {
      const [row] = await sql.query('SELECT * FROM extractions WHERE id = $1', [id]);
      return row ? toExtraction(row) : null;
    },
    async listExtractions(projectId) {
      return (await sql.query('SELECT * FROM extractions WHERE project_id = $1 ORDER BY version DESC', [projectId])).map(toExtraction);
    },
    async latestExtractionVersion(projectId) {
      return Number((await sql.query('SELECT COALESCE(MAX(version), 0)::int AS version FROM extractions WHERE project_id = $1', [projectId]))[0]!.version);
    },
    async saveGapScan(r) {
      await sql.query(`INSERT INTO gapscans (id, project_id, extraction_id, reference_id, blob_key, summary, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET blob_key = EXCLUDED.blob_key, summary = EXCLUDED.summary, updated_at = EXCLUDED.updated_at`,
        [r.id, r.projectId, r.extractionId, r.referenceId, r.blobKey, JSON.stringify(r.summary), r.createdAt, r.updatedAt]);
    },
    async getGapScan(id) {
      const [row] = await sql.query('SELECT * FROM gapscans WHERE id = $1', [id]);
      return row ? gapScanRow(row) : null;
    },
    async listGapScans(extractionId) {
      return (await sql.query('SELECT * FROM gapscans WHERE extraction_id = $1 ORDER BY created_at DESC', [extractionId])).map(gapScanRow);
    },
    async saveApproval(a) {
      await sql.query(`INSERT INTO match_approvals (key, eds_fingerprint, reference_id, source_id, target_id, approved_by, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (key) DO UPDATE SET target_id = EXCLUDED.target_id, approved_by = EXCLUDED.approved_by, reason = EXCLUDED.reason, at = EXCLUDED.at`,
        [a.key, a.edsFingerprint, a.referenceId, a.sourceId, a.targetId, a.by, a.reason, a.at]);
    },
    async listApprovals(edsFingerprint, referenceId) {
      return (await sql.query('SELECT * FROM match_approvals WHERE eds_fingerprint = $1 AND reference_id = $2 ORDER BY at', [edsFingerprint, referenceId])).map(row => ({
        key: str(row, 'key'), edsFingerprint: str(row, 'eds_fingerprint'), referenceId: str(row, 'reference_id'), sourceId: str(row, 'source_id'),
        targetId: row.target_id === null ? null : str(row, 'target_id'), by: str(row, 'approved_by'), reason: str(row, 'reason'), at: str(row, 'at')}));
    },
    async ensureUser(email) {
      const normalized = email.trim().toLowerCase();
      await sql.query('INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING', [randomUUID(), normalized, now()]);
      const [row] = await sql.query('SELECT * FROM users WHERE email = $1', [normalized]);
      return {id: str(row!, 'id'), email: str(row!, 'email'), createdAt: str(row!, 'created_at')};
    },
    async findUserByEmail(email) {
      const [row] = await sql.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
      return row ? {id: str(row, 'id'), email: str(row, 'email'), createdAt: str(row, 'created_at')} : null;
    },
    async getUser(id) {
      const [row] = await sql.query('SELECT * FROM users WHERE id = $1', [id]);
      return row ? {id: str(row, 'id'), email: str(row, 'email'), createdAt: str(row, 'created_at')} : null;
    },
    async saveLoginToken(t) { await sql.query('INSERT INTO login_tokens (hash, email, expires_at, created_at) VALUES ($1, $2, $3, $4)', [t.hash, t.email, t.expiresAt, t.createdAt]); },
    async consumeLoginToken(hash, at) {
      const [row] = await sql.query('DELETE FROM login_tokens WHERE hash = $1 RETURNING email, expires_at', [hash]);
      return row && str(row, 'expires_at') > at ? str(row, 'email') : null;
    },
    async countLoginTokens(email, since) {
      return Number((await sql.query('SELECT COUNT(*)::int AS n FROM login_tokens WHERE email = $1 AND created_at > $2', [email, since]))[0]!.n);
    },
    async saveSession(x) { await sql.query('INSERT INTO sessions (hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)', [x.hash, x.userId, x.expiresAt, x.createdAt]); },
    async getSession(hash, at) {
      const [row] = await sql.query('SELECT user_id, expires_at FROM sessions WHERE hash = $1 AND expires_at > $2', [hash, at]);
      return row ? {userId: str(row, 'user_id'), expiresAt: str(row, 'expires_at')} : null;
    },
    async deleteSession(hash) { await sql.query('DELETE FROM sessions WHERE hash = $1', [hash]); },
    async setMember(projectId, userId, role) {
      await sql.query('INSERT INTO project_members (project_id, user_id, role, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role', [projectId, userId, role, now()]);
    },
    async removeMember(projectId, userId) { await sql.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]); },
    async listMembers(projectId) {
      return (await sql.query('SELECT m.user_id, u.email, m.role, m.added_at FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY m.added_at, u.email', [projectId]))
        .map(row => ({userId: str(row, 'user_id'), email: str(row, 'email'), role: str(row, 'role') as Role, addedAt: str(row, 'added_at')}));
    },
    async roleOf(projectId, userId) {
      const [row] = await sql.query('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
      return row ? str(row, 'role') as Role : null;
    },
    async listProjectsFor(userId) {
      return (await sql.query('SELECT p.id, p.name, p.created_at FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = $1 ORDER BY p.created_at DESC', [userId]))
        .map(row => ProjectSchema.parse({id: str(row, 'id'), name: str(row, 'name'), createdAt: str(row, 'created_at')}));
    },
    async close() { await sql.close(); },
  };
}

// Events cross instances by notification: a subscriber reads what it hasn't seen from the
// store, so delivery is gap-free and in order even if a notification is missed (the poll
// catches up). `publish` does nothing: the store already notified on commit.
export function createPostgresEventBus(sql: SqlClient, store: Store, {pollMs = 2000} = {}): EventBus & {start(): Promise<void>; close(): Promise<void>} {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const cursors = new Map<string, {seq: number; chain: Promise<void>}>();
  let unlisten: (() => Promise<void>) | null = null, timer: NodeJS.Timeout | undefined;
  const pull = (jobId: string) => {
    const state = cursors.get(jobId);
    if (!state) return;
    state.chain = state.chain.then(async () => {
      for (const event of await store.listEvents(jobId, state.seq)) { state.seq = event.seq; emitter.emit(jobId, event); }
    }).catch(() => {});
  };
  return {
    publish() {},
    subscribe(jobId, listener) {
      if (!cursors.has(jobId)) cursors.set(jobId, {seq: 0, chain: Promise.resolve()});
      emitter.on(jobId, listener);
      return () => { emitter.off(jobId, listener); if (!emitter.listenerCount(jobId)) cursors.delete(jobId); };
    },
    async start() {
      unlisten = await sql.listen(EVENTS_CHANNEL, payload => pull(payload.slice(0, payload.lastIndexOf(':'))));
      timer = setInterval(() => { for (const jobId of cursors.keys()) pull(jobId); }, pollMs);
      timer.unref();
    },
    async close() { clearInterval(timer); await unlisten?.(); },
  };
}

type QueueOptions = {concurrency?: number; workerId?: string; pollMs?: number; heartbeatMs?: number; staleMs?: number};
// Any number of instances can run workers. A job is claimed by exactly one (FOR UPDATE SKIP
// LOCKED); running jobs send heartbeats, and one whose worker stopped is failed as retryable.
// Concurrency 0 runs an API-only instance that enqueues but never executes.
export function createPostgresQueue(store: Store, sql: SqlClient, bus: EventBus,
  {concurrency = 2, workerId = randomUUID(), pollMs = 1000, heartbeatMs = 10_000, staleMs = 60_000}: QueueOptions = {}): Queue & {start(): Promise<void>} {
  const handlers = new Map<JobType, JobHandler>(), running = new Map<string, AbortController>(), drained = new Set<() => void>();
  const unlisten: (() => Promise<void>)[] = [], timers: NodeJS.Timeout[] = [];
  let closed = false, pumping = false, again = false;
  const notifyDrained = () => { if (!running.size) for (const fn of drained) { drained.delete(fn); fn(); } };

  async function finish(job: Job, outcome: {resultId: string} | {cancelled: true} | {error: unknown}) {
    if ('resultId' in outcome) {
      await store.updateJob(job.id, {status: 'completed', resultId: outcome.resultId});
      await recordEvent(store, bus, job.id, {type: 'complete', resultId: outcome.resultId});
    } else if ('cancelled' in outcome) {
      await store.updateJob(job.id, {status: 'cancelled'});
      await recordEvent(store, bus, job.id, {type: 'cancelled'});
    } else {
      const retryable = (outcome.error as {retryable?: boolean} | null)?.retryable === true;
      const error = {code: retryable ? 'interrupted' : 'handler_error', message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error), retryable};
      await store.updateJob(job.id, {status: 'failed', error});
      await recordEvent(store, bus, job.id, {type: 'failed', ...error});
    }
  }

  // A user's cancel ends the job as cancelled; a shutdown ends it as retryable, since nobody asked to stop it.
  const SHUTDOWN = 'Server shutting down';
  const stopped = (controller: AbortController) => !controller.signal.aborted ? null : (controller.signal.reason as Error | undefined)?.message === SHUTDOWN
    ? {error: Object.assign(new Error('The server shut down before this job finished. Submit it again.'), {retryable: true})} : {cancelled: true as const};
  async function run(job: Job) {
    const controller = new AbortController();
    running.set(job.id, controller);
    try {
      const handler = handlers.get(job.type);
      if (!handler) throw new Error(`No handler registered for ${job.type} jobs.`);
      const result = await handler({
        job, signal: controller.signal,
        progress: async (stage, done, total, message) => { if (!controller.signal.aborted) await recordEvent(store, bus, job.id, {type: 'progress', stage, done, total, message}); },
        warn: async message => { if (!controller.signal.aborted) await recordEvent(store, bus, job.id, {type: 'warning', message}); },
      });
      await finish(job, stopped(controller) ?? result);
    } catch (error) {
      await finish(job, stopped(controller) ?? {error}).catch(() => {});
    } finally {
      running.delete(job.id);
      notifyDrained();
      void pump();
    }
  }

  const claim = async (): Promise<Job | null> => {
    const at = new Date().toISOString();
    const [row] = await sql.query(`UPDATE jobs SET status = 'running', worker = $1, heartbeat_at = now(),
        data = data || jsonb_build_object('status', 'running', 'updatedAt', $2::text)
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND type = ANY($3::text[]) ORDER BY ord FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING data`, [workerId, at, [...handlers.keys()]]);
    return row ? JobSchema.parse(json(row.data)) : null;
  };
  // One pump at a time; a wake-up during a pump makes it go round again.
  async function pump() {
    if (closed || !concurrency) return;
    if (pumping) { again = true; return; }
    pumping = true;
    try {
      do {
        again = false;
        while (!closed && running.size < concurrency) { const job = await claim(); if (!job) break; void run(job); }
      } while (again && !closed);
    } catch { /* the next poll retries */ } finally { pumping = false; }
  }

  async function heartbeat() {
    if (!running.size) return;
    const ids = [...running.keys()];
    await sql.query('UPDATE jobs SET heartbeat_at = now() WHERE id = ANY($1::text[]) AND worker = $2', [ids, workerId]);
    for (const row of await sql.query('SELECT id FROM jobs WHERE id = ANY($1::text[]) AND cancel_requested', [ids])) abortLocal(str(row, 'id'));
  }
  async function sweep() {
    const error = {code: 'interrupted', message: 'The worker running this job stopped before it finished. Submit it again.', retryable: true};
    const rows = await sql.query(`UPDATE jobs SET status = 'failed', data = data || jsonb_build_object('status', 'failed', 'error', $1::jsonb, 'updatedAt', $2::text)
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => $3) RETURNING id`, [JSON.stringify(error), new Date().toISOString(), staleMs / 1000]);
    for (const row of rows) await recordEvent(store, bus, str(row, 'id'), {type: 'failed', ...error});
  }
  const abortLocal = (jobId: string) => {
    const controller = running.get(jobId);
    if (controller && !controller.signal.aborted) controller.abort(new DOMException('Job cancelled', 'AbortError'));
  };
  const every = (ms: number, fn: () => Promise<void>) => { const t = setInterval(() => { void fn().catch(() => {}); }, ms); t.unref(); timers.push(t); };

  return {
    register(type, handler) { handlers.set(type, handler); },
    async start() {
      await sweep();
      unlisten.push(await sql.listen(CANCEL_CHANNEL, abortLocal));
      if (concurrency) {
        unlisten.push(await sql.listen(JOBS_CHANNEL, () => void pump()));
        every(pollMs, pump); every(heartbeatMs, heartbeat);
      }
      every(Math.max(staleMs / 2, 1000), sweep);
      void pump();
    },
    async enqueue(job) {
      if (closed) throw new Error('Queue is closed.');
      await sql.query('SELECT pg_notify($1, $2)', [JOBS_CHANNEL, job.id]);
    },
    async cancel(jobId) {
      const at = new Date().toISOString();
      const queued = await sql.query(`UPDATE jobs SET status = 'cancelled', data = data || jsonb_build_object('status', 'cancelled', 'updatedAt', $2::text)
        WHERE id = $1 AND status = 'queued' RETURNING id`, [jobId, at]);
      if (queued.length) { await recordEvent(store, bus, jobId, {type: 'cancelled'}); return true; }
      const requested = await sql.query("UPDATE jobs SET cancel_requested = TRUE WHERE id = $1 AND status = 'running' AND NOT cancel_requested RETURNING id", [jobId]);
      if (!requested.length) return false;
      abortLocal(jobId);
      await sql.query('SELECT pg_notify($1, $2)', [CANCEL_CHANNEL, jobId]);
      return true;
    },
    // Resolves once no job is queued or running anywhere (tests); close() waits only for this instance's.
    async idle() {
      for (;;) {
        const [row] = await sql.query<{n: number}>("SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('queued', 'running')");
        if (!row!.n && !running.size) return;
        await new Promise(resolve => setTimeout(resolve, 20));
        void pump();
      }
    },
    async close() {
      closed = true;
      for (const t of timers) clearInterval(t);
      for (const fn of unlisten) await fn();
      for (const controller of running.values()) controller.abort(new DOMException(SHUTDOWN, 'AbortError'));
      if (running.size) await new Promise<void>(resolve => drained.add(resolve));
    },
  };
}
