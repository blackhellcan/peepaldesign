// Phase 1 bridge: runs the prototype's deterministic code extractor and maps its
// inventory onto the Part 1 schema. Phase 2 replaces this with native adapters
// (rendered URLs, Figma, PDF, PPTX); until then the prototype stays the parser.
import {createHash} from 'node:crypto';
import {classifyItem} from '@gapscan/taxonomy';
import type {ComponentObservation, EvidenceRecord, QuirkRecord, Specimen, Token, TokenType} from '@gapscan/schema';

type LegacyEvidence = {source?: string; line?: number; snippet?: string};
type LegacyItem = {
  id: string; name: string; kind: string; value?: string; html?: string; css?: string;
  evidence?: LegacyEvidence[]; observations?: {css?: string; html?: string}[];
  variants?: (string | {name?: string})[]; evidenceProfile?: {quality?: string}; sourceIssue?: unknown;
};
type LegacyEngine = {
  extractDocuments(docs: {content: string; url: string; type: string}[]): unknown;
  filterInventory(inventory: unknown, system: string): {inventory: {items: LegacyItem[]}; audit: {excludedItems?: number}};
};

const DEFAULT_ROOT = new URL('../../../../gapscan/engine/', import.meta.url);
let cached: Promise<LegacyEngine> | undefined;

export function loadLegacyEngine(root: URL = process.env.GAPSCAN_LEGACY_ENGINE ? new URL(process.env.GAPSCAN_LEGACY_ENGINE) : DEFAULT_ROOT): Promise<LegacyEngine> {
  cached ??= (async () => {
    const [extract, relevance] = await Promise.all([import(new URL('extract.mjs', root).href), import(new URL('relevance.mjs', root).href)]);
    return {extractDocuments: extract.extractDocuments, filterInventory: relevance.filterInventory} as LegacyEngine;
  })();
  return cached;
}

export type CodeDocument = {assetId: string; name: string; content: string};
export type BridgeOutput = {evidence: EvidenceRecord[]; tokens: Token[]; components: ComponentObservation[]; specimens: Specimen[]; quirks: QuirkRecord[]; excludedSupportItems: number};

const STATES = ['hover', 'focus-visible', 'focus', 'active', 'disabled', 'checked', 'selected'] as const;
const INTERACTIVE = new Set(['Actions', 'Forms and input', 'Navigation']);
const QUALITY_CONFIDENCE: Record<string, number> = {strong: 0.9, moderate: 0.7, weak: 0.5};
const humanLabel = (name: string) => name.replace(/^[.#$-]+/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || name;

function tokenType(name: string, value: string): TokenType {
  const n = name.toLowerCase(), v = value.trim().toLowerCase();
  if (/shadow/.test(n)) return 'shadow';
  if (/radius|rounded/.test(n)) return 'radius';
  if (/font-?family|font$|typeface/.test(n)) return 'fontFamily';
  if (/weight/.test(n) && /^\d{3}$/.test(v)) return 'fontWeight';
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\()/.test(v)) return 'color';
  if (/^-?[\d.]+m?s$/.test(v)) return 'duration';
  if (/^cubic-bezier\(/.test(v)) return 'cubicBezier';
  if (/^-?[\d.]+(px|rem|em|%|vh|vw)$/.test(v)) return 'dimension';
  return 'other';
}

export async function extractCode(documents: CodeDocument[], engine?: LegacyEngine): Promise<BridgeOutput> {
  const legacy = engine ?? await loadLegacyEngine();
  const docs = documents.map(doc => ({content: doc.content, url: 'inline:' + doc.name, type: 'text/plain'}));
  const assetBySource = new Map(documents.map(doc => ['inline:' + doc.name, doc.assetId]));
  const filtered = legacy.filterInventory(legacy.extractDocuments(docs), 'source');
  const evidence: EvidenceRecord[] = [], tokens: Token[] = [], components: ComponentObservation[] = [], specimens: Specimen[] = [], quirks: QuirkRecord[] = [];

  const evidenceFor = (item: LegacyItem) => (item.evidence ?? []).map((e, index) => {
    const record: EvidenceRecord = {id: `ev:${item.id}:${index}`, assetId: assetBySource.get(e.source ?? '') ?? documents[0]?.assetId ?? 'unknown',
      trust: item.kind === 'foundation' ? 'observed' : 'declared', locator: `${e.source ?? 'inline'}:${e.line ?? 1}`, raw: (e.snippet ?? '').slice(0, 500)};
    evidence.push(record);
    return record.id;
  });

  const items = filtered.inventory.items;
  const declared = new Map(items.filter(i => i.kind === 'token').map(i => [i.name, i.value ?? '']));
  for (const item of items) {
    const evidenceIds = evidenceFor(item), value = item.value ?? '';
    if (item.kind === 'token' || item.kind === 'foundation') {
      const alias = value.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/)?.[1];
      const unresolved = (/var\(|calc\(/.test(value) && !(alias && declared.has(alias))) || Boolean(item.sourceIssue);
      tokens.push({
        id: item.id, tier: 'global', path: item.kind === 'foundation' ? `observed.${item.name.replace(/^Observed\s+/i, '').replace(/\s+/g, '.')}` : item.name,
        type: tokenType(item.name, value), value, ...(alias && declared.has(alias) ? {aliasOf: alias} : {}),
        status: unresolved ? 'unresolved' : 'resolved', evidence: evidenceIds,
        confidence: item.kind === 'foundation' ? 0.5 : 0.9, usageCount: evidenceIds.length,
      });
      if (unresolved) quirks.push({id: `q:unresolved:${item.id}`, kind: 'unresolved_value', severity: 'minor', subjectIds: [item.id],
        summary: `${item.name} depends on a value we could not resolve (${value}). It is kept, and anything using it stays unestimated.`, evidence: evidenceIds});
      continue;
    }
    const classification = classifyItem({name: item.name, kind: item.kind, ...(item.html ? {html: item.html} : {}), evidence: item.evidence ?? []});
    const styleText = [item.css ?? '', ...(item.observations ?? []).map(o => o.css ?? '')].join('\n');
    const statesObserved = STATES.filter(state => new RegExp(`:${state}(?![\\w-])`).test(styleText) || (state === 'disabled' && /\[disabled\]|aria-disabled/.test(styleText)));
    const interactive = INTERACTIVE.has(classification.category);
    const focusVisible = styleText.trim() ? statesObserved.some(s => s.startsWith('focus')) : null;
    const specimenId = `sp:${item.id}`;
    if (item.html || item.css) specimens.push({id: specimenId, ...(item.html ? {html: item.html} : {}), ...(item.css ? {css: item.css} : {}), origin: 'captured'});
    components.push({
      id: item.id, canonical: humanLabel(item.name), rawNames: [item.name], category: classification.category, tier: classification.tier,
      variants: (item.variants ?? []).map(v => ({name: typeof v === 'string' ? v : v.name ?? 'variant', tokenRefs: {}})),
      sizes: [], statesObserved: [...statesObserved],
      statesMissing: interactive ? ['focus-visible', 'disabled'].filter(s => !statesObserved.some(o => o === s || (s === 'focus-visible' && o === 'focus'))) : [],
      a11y: {focusVisible: interactive ? focusVisible : null}, instances: evidenceIds.length, evidence: evidenceIds,
      confidence: QUALITY_CONFIDENCE[item.evidenceProfile?.quality ?? 'weak'] ?? 0.5,
    });
    if (interactive && focusVisible === false) quirks.push({id: `q:focus:${item.id}`, kind: 'missing_state', severity: 'major', subjectIds: [item.id],
      summary: `${humanLabel(item.name)} has no visible keyboard focus style in the supplied code.`, evidence: evidenceIds});
  }
  return {evidence, tokens, components, specimens, quirks, excludedSupportItems: filtered.audit.excludedItems ?? 0};
}

export function fingerprint(output: Pick<BridgeOutput, 'tokens' | 'components'>): string {
  const canonical = {
    tokens: output.tokens.map(t => [t.path, t.value, t.status]).sort(),
    components: output.components.map(c => [c.rawNames.join('|'), c.category, [...c.statesObserved].sort()]).sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
