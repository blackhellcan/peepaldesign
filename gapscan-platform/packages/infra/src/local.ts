// Local adapters: filesystem blobs, an in-process event bus and job queue.
import {EventEmitter} from 'node:events';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve, sep} from 'node:path';
import type {Job, JobEventBody, JobType} from '@gapscan/schema';
import type {BlobStore, EventBus, JobHandler, Queue, Store} from './types.ts';

export const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

export function createFsBlobStore(root: string): BlobStore {
  const base = resolve(root);
  const pathFor = (key: string) => {
    const target = resolve(join(base, key));
    if (!SAFE_KEY.test(key) || key.includes('..') || !target.startsWith(base + sep)) throw new Error(`Unsafe blob key: ${key}`);
    return target;
  };
  return {
    async put(key, data) {
      const target = pathFor(key);
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, data);
      return key;
    },
    async get(key) {
      try { return await readFile(pathFor(key)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async delete(key) { await rm(pathFor(key), {force: true}); },
  };
}

export function createLocalEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish(event) { emitter.emit(event.jobId, event); },
    subscribe(jobId, listener) { emitter.on(jobId, listener); return () => { emitter.off(jobId, listener); }; },
  };
}

// Persist first, then publish: a subscriber that misses the live event will
// find it when it replays from the store.
export async function recordEvent(store: Store, bus: EventBus, jobId: string, body: JobEventBody) {
  const event = await store.appendEvent(jobId, body);
  bus.publish(event);
  return event;
}

export function createInProcessQueue(store: Store, bus: EventBus, {concurrency = 2} = {}): Queue {
  const handlers = new Map<JobType, JobHandler>();
  const waiting: Job[] = [], running = new Map<string, AbortController>(), settled = new Set<() => void>();
  let closed = false;
  const notifyIdle = () => { if (!waiting.length && !running.size) for (const resolve of settled) { settled.delete(resolve); resolve(); } };

  async function finish(job: Job, outcome: {resultId: string} | {cancelled: true} | {error: unknown}) {
    if ('resultId' in outcome) {
      await store.updateJob(job.id, {status: 'completed', resultId: outcome.resultId});
      await recordEvent(store, bus, job.id, {type: 'complete', resultId: outcome.resultId});
    } else if ('cancelled' in outcome) {
      await store.updateJob(job.id, {status: 'cancelled'});
      await recordEvent(store, bus, job.id, {type: 'cancelled'});
    } else {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      const error = {code: 'handler_error', message, retryable: false};
      await store.updateJob(job.id, {status: 'failed', error});
      await recordEvent(store, bus, job.id, {type: 'failed', ...error});
    }
  }

  async function run(job: Job) {
    const controller = new AbortController();
    running.set(job.id, controller);
    try {
      const handler = handlers.get(job.type);
      if (!handler) throw new Error(`No handler registered for ${job.type} jobs.`);
      await store.updateJob(job.id, {status: 'running'});
      const result = await handler({
        job, signal: controller.signal,
        progress: async (stage, done, total, message) => { if (!controller.signal.aborted) await recordEvent(store, bus, job.id, {type: 'progress', stage, done, total, message}); },
        warn: async message => { if (!controller.signal.aborted) await recordEvent(store, bus, job.id, {type: 'warning', message}); },
      });
      await finish(job, controller.signal.aborted ? {cancelled: true} : result);
    } catch (error) {
      await finish(job, controller.signal.aborted ? {cancelled: true} : {error});
    } finally {
      running.delete(job.id);
      pump();
      notifyIdle();
    }
  }

  function pump() {
    while (!closed && running.size < concurrency && waiting.length) void run(waiting.shift()!);
  }

  return {
    register(type, handler) { handlers.set(type, handler); },
    async enqueue(job) {
      if (closed) throw new Error('Queue is closed.');
      waiting.push(job);
      pump();
    },
    async cancel(jobId) {
      const index = waiting.findIndex(job => job.id === jobId);
      if (index >= 0) {
        const [job] = waiting.splice(index, 1);
        await finish(job!, {cancelled: true});
        notifyIdle();
        return true;
      }
      const controller = running.get(jobId);
      if (!controller || controller.signal.aborted) return false;
      controller.abort(new DOMException('Job cancelled', 'AbortError'));
      return true;
    },
    idle() { return !waiting.length && !running.size ? Promise.resolve() : new Promise<void>(resolve => settled.add(resolve)); },
    async close() {
      closed = true;
      for (const controller of running.values()) controller.abort(new DOMException('Server shutting down', 'AbortError'));
      await this.idle();
    },
  };
}
