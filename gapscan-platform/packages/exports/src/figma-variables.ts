// Figma Variables sync (architecture Part 3 §3.2). `planFigmaSync` compares the
// extraction's tokens with a file's existing variables and builds the exact
// POST /v1/files/:key/variables payload. Nothing is written here: applying is a
// separate, confirmed step that must present the hash of the plan it approves.
import {createHash} from 'node:crypto';
import {parseColor, toPx} from '@gapscan/normalize';
import type {ExtractedDesignSystem, Token} from '@gapscan/schema';

type Rgba = {r: number; g: number; b: number; a: number};
type FigmaValue = Rgba | number | string | boolean | {type: 'VARIABLE_ALIAS'; id: string};
export type ExistingVariables = {meta: {
  variables: Record<string, {id: string; name: string; resolvedType: string; variableCollectionId: string; valuesByMode: Record<string, FigmaValue>}>;
  variableCollections: Record<string, {id: string; name: string; defaultModeId: string; modes: {modeId: string; name: string}[]}>;
}};
export type SyncChange = {name: string; type: 'COLOR' | 'FLOAT' | 'STRING'; before?: string; after: string; mode: string};
export type SyncPlan = {
  collection: string; collectionExists: boolean; modes: string[];
  create: SyncChange[]; update: SyncChange[]; unchanged: number; skipped: {path: string; reason: string}[];
  payload: Record<string, unknown[]>; hash: string;
};

const round = (n: number) => Math.round(n * 1000) / 1000;
// `--brand-primary` → brand/primary, `color.primary` → color/primary.
export const variableName = (path: string) => (path.startsWith('--') || !path.includes('.') ? path.replace(/^[-$@]+/, '').split('-') : path.split('.')).filter(Boolean).join('/');

function toFigma(token: Token, value: string): {type: SyncChange['type']; value: FigmaValue} | null {
  if (token.type === 'color') { const c = parseColor(value); return c ? {type: 'COLOR', value: {r: round(c.r), g: round(c.g), b: round(c.b), a: round(c.alpha)}} : null; }
  if (token.type === 'dimension' || token.type === 'radius' || token.type === 'fontWeight') { const px = token.type === 'fontWeight' ? Number(value) : toPx(value); return px !== null && Number.isFinite(px) ? {type: 'FLOAT', value: px} : null; }
  if (token.type === 'fontFamily') return {type: 'STRING', value: value.split(',')[0]!.replace(/['"]/g, '').trim()};
  return null;
}
const show = (v: FigmaValue | undefined): string => v === undefined ? '—' : typeof v !== 'object' ? String(v) : 'type' in v ? `→ ${v.id}` : `rgba(${Math.round(v.r * 255)}, ${Math.round(v.g * 255)}, ${Math.round(v.b * 255)}, ${v.a})`;
const same = (a: FigmaValue | undefined, b: FigmaValue) => show(a) === show(b);

export function planFigmaSync(eds: ExtractedDesignSystem, existing: ExistingVariables | null, collection = 'GapScan tokens'): SyncPlan {
  const vars = Object.values(existing?.meta.variables ?? {}), found = Object.values(existing?.meta.variableCollections ?? {}).find(c => c.name === collection);
  const tokens = eds.tokens.filter(t => t.status === 'resolved' && t.confidence >= 0.5 && !t.path.startsWith('color.palette.'));
  const modeNames = [...new Set(['Light', ...tokens.flatMap(t => Object.keys(t.modes ?? {}))].map(m => m[0]!.toUpperCase() + m.slice(1)))];
  const collectionId = found?.id ?? 'tmp:collection';
  const modeId = (name: string) => found?.modes.find(m => m.name.toLowerCase() === name.toLowerCase())?.modeId ?? (name === 'Light' && found ? found.defaultModeId : `tmp:mode:${name}`);
  const payload: Record<string, unknown[]> = {variableCollections: [], variableModes: [], variables: [], variableModeValues: []};
  if (!found) {
    payload.variableCollections!.push({action: 'CREATE', id: collectionId, name: collection, initialModeId: 'tmp:mode:Light'});
    payload.variableModes!.push({action: 'UPDATE', id: 'tmp:mode:Light', name: 'Light', variableCollectionId: collectionId});
  }
  for (const mode of modeNames.filter(m => m !== 'Light' && !found?.modes.some(x => x.name.toLowerCase() === m.toLowerCase())))
    payload.variableModes!.push({action: 'CREATE', id: `tmp:mode:${mode}`, name: mode, variableCollectionId: collectionId});

  const create: SyncChange[] = [], update: SyncChange[] = [], skipped: SyncPlan['skipped'] = [];
  let unchanged = 0;
  const idFor = new Map<string, string>();
  const byName = new Map(vars.filter(v => v.variableCollectionId === collectionId).map(v => [v.name, v]));
  for (const token of tokens) { const name = variableName(token.path); idFor.set(token.path, byName.get(name)?.id ?? `tmp:var:${name}`); }
  for (const token of tokens.sort((a, b) => a.path.localeCompare(b.path))) {
    const name = variableName(token.path), current = byName.get(name), id = idFor.get(token.path)!;
    const first = toFigma(token, String(token.value));
    if (!first && !token.aliasOf) { skipped.push({path: token.path, reason: `${token.type} values are not supported as Figma variables`}); continue; }
    const type = token.aliasOf ? toFigma(tokens.find(t => t.path === token.aliasOf) ?? token, String(tokens.find(t => t.path === token.aliasOf)?.value ?? token.value))?.type : first!.type;
    if (!type) { skipped.push({path: token.path, reason: 'Alias target is not a supported value'}); continue; }
    if (current && current.resolvedType !== type) { skipped.push({path: token.path, reason: `Figma already has ${name} as ${current.resolvedType}`}); continue; }
    if (!current) payload.variables!.push({action: 'CREATE', id, name, variableCollectionId: collectionId, resolvedType: type});
    const values: [string, FigmaValue][] = token.aliasOf && idFor.has(token.aliasOf) ? [['Light', {type: 'VARIABLE_ALIAS', id: idFor.get(token.aliasOf)!}]]
      : Object.keys(token.modes ?? {}).length ? Object.entries(token.modes!).flatMap(([mode, v]) => { const f = toFigma(token, String(v)); return f ? [[mode[0]!.toUpperCase() + mode.slice(1), f.value] as [string, FigmaValue]] : []; })
      : [['Light', first!.value]];
    let changed = !current;
    for (const [mode, value] of values) {
      const before = current?.valuesByMode[modeId(mode)];
      if (current && same(before, value)) continue;
      changed = true;
      payload.variableModeValues!.push({variableId: id, modeId: modeId(mode), value});
      (current ? update : create).push({name, type, ...(current ? {before: show(before)} : {}), after: show(value), mode});
    }
    if (!changed) unchanged++;
  }
  // The hash binds an approval to this exact payload; any drift between preview and apply is refused.
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return {collection, collectionExists: Boolean(found), modes: modeNames, create, update, unchanged, skipped, payload, hash};
}
