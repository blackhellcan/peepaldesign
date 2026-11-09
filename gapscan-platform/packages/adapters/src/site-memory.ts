// Saved websites: every page the reader renders is kept, with the crawl's progress, so importing
// the same site again reuses what was read and continues from the pages not read yet (after a
// page budget, a cancel or a restart). Storage is any key/value store (local files or S3).
import {createHash} from 'node:crypto';
import type {Observation} from './types.ts';
import type {VariantStates, VariantStyle} from './types.ts';

// Bump whenever what a page record holds or how pages are read changes; older records are then
// ignored (read again) instead of mixing two versions of the reader in one result.
export const SITE_MEMORY_VERSION = 'site-4';
export const SITE_MEMORY_MAX_AGE_DAYS = 30;

export type SavedStyle = {count: number; style: VariantStyle; html: string; text: string; ref: string; disabled?: boolean; captured?: boolean; states?: VariantStates; screenshot?: string};
export type PageRecord = {
  url: string; landed: string; readAt: string; dark: boolean;
  observations: Observation[];
  components: Record<string, {count: number; classes: string[]; html: string; named: boolean; styles: Record<string, SavedStyle>}>;
  selectors: string[]; links: string[];
};
export type SiteState = {version: string; start: string; startedAt: string; updatedAt: string; done: string[]; seen: string[]; queue: string[]; failed: {locator: string; reason: string}[]};
export type KeyValueStore = {get(key: string): Promise<Uint8Array | null>; put(key: string, data: string | Uint8Array): Promise<unknown>};

// One site per start address: lower-case host, no fragment, no trailing slash.
export function siteKey(start: string): string {
  const url = new URL(start);
  url.hash = '';
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '') || ''}${url.search}`;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

export type SiteMemory = {
  load(start: string): Promise<{state: SiteState; pages: PageRecord[]} | null>;
  savePage(start: string, record: PageRecord): Promise<void>;
  saveState(start: string, state: SiteState): Promise<void>;
  info(start: string): Promise<{pages: number; queued: number; failed: number; startedAt: string; updatedAt: string; stale: boolean} | null>;
};

export function createSiteMemory(store: KeyValueStore, {maxAgeDays = SITE_MEMORY_MAX_AGE_DAYS, now = () => Date.now()} = {}): SiteMemory {
  const base = (start: string) => `sites/${hash(siteKey(start))}`;
  const read = async <T>(key: string): Promise<T | null> => {
    const bytes = await store.get(key);
    if (!bytes) return null;
    try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { return null; }
  };
  const stateOf = async (start: string) => {
    const state = await read<SiteState>(`${base(start)}/state.json`);
    return state && state.version === SITE_MEMORY_VERSION && state.start === siteKey(start) ? state : null;
  };
  const stale = (state: SiteState) => now() - Date.parse(state.startedAt) > maxAgeDays * 86_400_000;
  return {
    async load(start) {
      const state = await stateOf(start);
      if (!state || stale(state)) return null;
      const pages: PageRecord[] = [];
      for (const url of state.done) { const page = await read<PageRecord>(`${base(start)}/pages/${hash(url)}.json`); if (page) pages.push(page); }
      // A page whose record went missing is read again.
      const kept = new Set(pages.map(p => p.url));
      return {state: {...state, done: state.done.filter(u => kept.has(u)), queue: [...state.done.filter(u => !kept.has(u)), ...state.queue]}, pages};
    },
    async savePage(start, record) { await store.put(`${base(start)}/pages/${hash(record.url)}.json`, JSON.stringify(record)); },
    async saveState(start, state) { await store.put(`${base(start)}/state.json`, JSON.stringify({...state, version: SITE_MEMORY_VERSION, start: siteKey(start), updatedAt: new Date(now()).toISOString()})); },
    async info(start) {
      const state = await stateOf(start);
      return state ? {pages: state.done.length, queued: state.queue.length, failed: state.failed.length, startedAt: state.startedAt, updatedAt: state.updatedAt, stale: stale(state)} : null;
    },
  };
}
