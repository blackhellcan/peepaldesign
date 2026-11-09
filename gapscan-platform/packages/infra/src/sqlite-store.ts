// Zero-install Store on Node's built-in SQLite. Synchronous under the hood but
// exposed through the async Store interface so Postgres can drop in later.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {Job as JobSchema, JobEvent as JobEventSchema, Project as ProjectSchema, SourceAsset as SourceAssetSchema} from '@gapscan/schema';
import type {Job, JobEvent, JobEventBody, Project, SourceAsset} from '@gapscan/schema';
import type {ExtractionRecord, GapScanRecord, MatchApproval, Role, Store} from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sources_project ON sources(project_id, created_at);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS job_events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (job_id, seq));
CREATE TABLE IF NOT EXISTS extractions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  blob_key TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, version));
CREATE TABLE IF NOT EXISTS gapscans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, extraction_id TEXT NOT NULL, reference_id TEXT NOT NULL, blob_key TEXT NOT NULL,
  summary TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS match_approvals (key TEXT PRIMARY KEY, eds_fingerprint TEXT NOT NULL, reference_id TEXT NOT NULL, source_id TEXT NOT NULL,
  target_id TEXT, approved_by TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS approvals_scope ON match_approvals(eds_fingerprint, reference_id);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_tokens (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS login_tokens_email ON login_tokens(email, created_at);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
  added_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
CREATE INDEX IF NOT EXISTS members_user ON project_members(user_id);
`;

type Row = Record<string, unknown>;
const text = (row: Row | undefined, column: string) => String(row?.[column] ?? '');
const gapScanRow = (row: Row): GapScanRecord => ({id: text(row, 'id'), projectId: text(row, 'project_id'), extractionId: text(row, 'extraction_id'), referenceId: text(row, 'reference_id'), blobKey: text(row, 'blob_key'),
  summary: JSON.parse(text(row, 'summary')) as Record<string, unknown>, createdAt: text(row, 'created_at'), updatedAt: text(row, 'updated_at')});

export function createSqliteStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const now = () => new Date().toISOString();
  const readJob = (row: Row | undefined) => row ? JobSchema.parse(JSON.parse(text(row, 'data'))) : null;
  const writeJob = (job: Job) => db.prepare('INSERT OR REPLACE INTO jobs (id, project_id, status, data) VALUES (?, ?, ?, ?)').run(job.id, job.projectId, job.status, JSON.stringify(job));
  const toExtraction = (row: Row): ExtractionRecord => ({id: text(row, 'id'), projectId: text(row, 'project_id'), version: Number(row.version), fingerprint: text(row, 'fingerprint'),
    blobKey: text(row, 'blob_key'), summary: JSON.parse(text(row, 'summary')) as Record<string, unknown>, createdAt: text(row, 'created_at')});
  const toEvent = (row: Row): JobEvent => JobEventSchema.parse({jobId: text(row, 'job_id'), seq: Number(row.seq), at: text(row, 'at'), body: JSON.parse(text(row, 'body'))});

  return {
    async createProject(name) {
      const project = ProjectSchema.parse({id: randomUUID(), name, createdAt: now()});
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(project.id, project.name, project.createdAt);
      return project;
    },
    async getProject(id) {
      const row = db.prepare('SELECT id, name, created_at FROM projects WHERE id = ?').get(id) as Row | undefined;
      return row ? ProjectSchema.parse({id: text(row, 'id'), name: text(row, 'name'), createdAt: text(row, 'created_at')}) : null;
    },
    async renameProject(id, name) {
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
      const row = db.prepare('SELECT id, name, created_at FROM projects WHERE id = ?').get(id) as Row | undefined;
      return row ? ProjectSchema.parse({id: text(row, 'id'), name: text(row, 'name'), createdAt: text(row, 'created_at')}) : null;
    },
    async listProjects() {
      return (db.prepare('SELECT id, name, created_at FROM projects ORDER BY created_at DESC').all() as Row[])
        .map(row => ProjectSchema.parse({id: text(row, 'id'), name: text(row, 'name'), createdAt: text(row, 'created_at')}));
    },
    async addSource(source) {
      const parsed = SourceAssetSchema.parse(source);
      db.prepare('INSERT INTO sources (id, project_id, data, created_at) VALUES (?, ?, ?, ?)').run(parsed.id, parsed.projectId, JSON.stringify(parsed), parsed.createdAt);
    },
    async listSources(projectId) {
      const rows = db.prepare('SELECT data FROM sources WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[];
      return rows.map(row => SourceAssetSchema.parse(JSON.parse(text(row, 'data'))) as SourceAsset);
    },
    async createJob({type, projectId, subjectId, payload}) {
      const at = now();
      const job = JobSchema.parse({id: randomUUID(), type, projectId, ...(subjectId ? {subjectId} : {}), status: 'queued', payload, createdAt: at, updatedAt: at});
      writeJob(job);
      return job;
    },
    async getJob(id) { return readJob(db.prepare('SELECT data FROM jobs WHERE id = ?').get(id) as Row | undefined); },
    async updateJob(id, patch) {
      const current = readJob(db.prepare('SELECT data FROM jobs WHERE id = ?').get(id) as Row | undefined);
      if (!current) throw new Error(`Job ${id} not found.`);
      const next = JobSchema.parse({...current, ...patch, updatedAt: now()});
      writeJob(next);
      return next;
    },
    async listUnfinishedJobs() {
      return (db.prepare("SELECT data FROM jobs WHERE status IN ('queued', 'running')").all() as Row[]).map(row => readJob(row)!);
    },
    async listRecentJobs(limit) {
      return (db.prepare("SELECT data FROM jobs ORDER BY json_extract(data, '$.createdAt') DESC LIMIT ?").all(limit) as Row[]).map(row => readJob(row)!);
    },
    async appendEvent(jobId, body: JobEventBody) {
      // Sequence numbers are per job and gap-free, so a client can resume from Last-Event-ID.
      const at = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const last = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id = ?').get(jobId) as Row;
        const seq = Number(last.seq) + 1;
        db.prepare('INSERT INTO job_events (job_id, seq, at, body) VALUES (?, ?, ?, ?)').run(jobId, seq, at, JSON.stringify(body));
        db.exec('COMMIT');
        return JobEventSchema.parse({jobId, seq, at, body});
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async listEvents(jobId, afterSeq = 0) {
      return (db.prepare('SELECT job_id, seq, at, body FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq').all(jobId, afterSeq) as Row[]).map(toEvent);
    },
    async saveExtraction(record: ExtractionRecord) {
      db.prepare('INSERT INTO extractions (id, project_id, version, fingerprint, blob_key, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.projectId, record.version, record.fingerprint, record.blobKey, JSON.stringify(record.summary), record.createdAt);
    },
    async getExtraction(id) {
      const row = db.prepare('SELECT * FROM extractions WHERE id = ?').get(id) as Row | undefined;
      return row ? toExtraction(row) : null;
    },
    async listExtractions(projectId) {
      return (db.prepare('SELECT * FROM extractions WHERE project_id = ? ORDER BY version DESC').all(projectId) as Row[]).map(toExtraction);
    },
    async latestExtractionVersion(projectId) {
      return Number((db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM extractions WHERE project_id = ?').get(projectId) as Row).version);
    },
    async saveGapScan(record: GapScanRecord) {
      db.prepare('INSERT OR REPLACE INTO gapscans (id, project_id, extraction_id, reference_id, blob_key, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.projectId, record.extractionId, record.referenceId, record.blobKey, JSON.stringify(record.summary), record.createdAt, record.updatedAt);
    },
    async listGapScans(extractionId) {
      return (db.prepare('SELECT * FROM gapscans WHERE extraction_id = ? ORDER BY created_at DESC').all(extractionId) as Row[]).map(gapScanRow);
    },
    async getGapScan(id) {
      const row = db.prepare('SELECT * FROM gapscans WHERE id = ?').get(id) as Row | undefined;
      return row ? gapScanRow(row) : null;
    },
    async saveApproval(a: MatchApproval) {
      db.prepare('INSERT OR REPLACE INTO match_approvals (key, eds_fingerprint, reference_id, source_id, target_id, approved_by, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(a.key, a.edsFingerprint, a.referenceId, a.sourceId, a.targetId, a.by, a.reason, a.at);
    },
    async listApprovals(edsFingerprint, referenceId) {
      return (db.prepare('SELECT * FROM match_approvals WHERE eds_fingerprint = ? AND reference_id = ? ORDER BY at').all(edsFingerprint, referenceId) as Row[]).map(row => ({
        key: text(row, 'key'), edsFingerprint: text(row, 'eds_fingerprint'), referenceId: text(row, 'reference_id'), sourceId: text(row, 'source_id'),
        targetId: row.target_id === null ? null : text(row, 'target_id'), by: text(row, 'approved_by'), reason: text(row, 'reason'), at: text(row, 'at')}));
    },
    async ensureUser(email) {
      const normalized = email.trim().toLowerCase();
      db.prepare('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)').run(randomUUID(), normalized, now());
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized) as Row;
      return {id: text(row, 'id'), email: text(row, 'email'), createdAt: text(row, 'created_at')};
    },
    async findUserByEmail(email) {
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as Row | undefined;
      return row ? {id: text(row, 'id'), email: text(row, 'email'), createdAt: text(row, 'created_at')} : null;
    },
    async getUser(id) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
      return row ? {id: text(row, 'id'), email: text(row, 'email'), createdAt: text(row, 'created_at')} : null;
    },
    async saveLoginToken(t) { db.prepare('INSERT INTO login_tokens (hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)').run(t.hash, t.email, t.expiresAt, t.createdAt); },
    async consumeLoginToken(hash, at) {
      const row = db.prepare('DELETE FROM login_tokens WHERE hash = ? RETURNING email, expires_at').get(hash) as Row | undefined;
      return row && text(row, 'expires_at') > at ? text(row, 'email') : null;
    },
    async countLoginTokens(email, since) {
      return Number((db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?').get(email, since) as Row).n);
    },
    async saveSession(x) { db.prepare('INSERT INTO sessions (hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(x.hash, x.userId, x.expiresAt, x.createdAt); },
    async getSession(hash, at) {
      const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE hash = ? AND expires_at > ?').get(hash, at) as Row | undefined;
      return row ? {userId: text(row, 'user_id'), expiresAt: text(row, 'expires_at')} : null;
    },
    async deleteSession(hash) { db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash); },
    async setMember(projectId, userId, role) {
      db.prepare('INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role').run(projectId, userId, role, now());
    },
    async removeMember(projectId, userId) { db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId); },
    async listMembers(projectId) {
      return (db.prepare('SELECT m.user_id, u.email, m.role, m.added_at FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.added_at, u.email').all(projectId) as Row[])
        .map(row => ({userId: text(row, 'user_id'), email: text(row, 'email'), role: text(row, 'role') as Role, addedAt: text(row, 'added_at')}));
    },
    async roleOf(projectId, userId) {
      const row = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) as Row | undefined;
      return row ? text(row, 'role') as Role : null;
    },
    async listProjectsFor(userId) {
      return (db.prepare('SELECT p.id, p.name, p.created_at FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC').all(userId) as Row[])
        .map(row => ProjectSchema.parse({id: text(row, 'id'), name: text(row, 'name'), createdAt: text(row, 'created_at')}));
    },
    async close() { db.close(); },
  };
}
