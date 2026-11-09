// The 13-category reference tree and loss-free classification, ported from the
// prototype's engine/taxonomy.mjs. It replaces the prototype's separate 7-domain
// list: every service classifies with this one vocabulary.
import type {Tier} from '@gapscan/schema';

export const TIERS: readonly Tier[] = ['primary', 'secondary', 'others'];
export const ITEM_RANKS = ['primary_items', 'secondary_items', 'other_items'] as const;
export type ItemRank = (typeof ITEM_RANKS)[number];

export type CategoryDefinition = {category: string; tier: Tier; ranks: Record<ItemRank, readonly string[]>};
const def = (category: string, tier: Tier, primary: string[], secondary: string[], other: string[]): CategoryDefinition =>
  ({category, tier, ranks: {primary_items: primary, secondary_items: secondary, other_items: other}});

export const CATEGORY_TAXONOMY: readonly CategoryDefinition[] = [
  def('Foundations and tokens', 'primary', ['color', 'palette', 'typography', 'font', 'spacing', 'grid'], ['shape', 'radius', 'elevation', 'shadow', 'icon', 'motion', 'easing'], ['theme', 'theming', 'dark mode', 'accessibility', 'brand layer']),
  def('Layout and structure', 'primary', ['grid', 'container', 'stack', 'page', 'layout', 'row', 'column'], ['page header', 'panel', 'divider', 'breakpoint', 'accordion', 'collapse'], ['primitive', 'bleed', 'gutter', 'deprecated layout']),
  def('Actions', 'primary', ['button', 'btn', 'link'], ['button group', 'btn group', 'icon button', 'fab', 'floating action button'], ['split button', 'account connection', 'segmented button', 'toolbar']),
  def('Forms and input', 'primary', ['text field', 'textfield', 'text input', 'input', 'checkbox', 'radio', 'select'], ['text area', 'textarea', 'toggle', 'switch', 'slider', 'range', 'date picker'], ['file upload', 'file input', 'color picker', 'validation', 'floating label', 'combobox', 'autocomplete', 'listbox', 'field', 'search box', 'search field', 'spin button', 'number input', 'rating']),
  def('Navigation', 'primary', ['navbar', 'side nav', 'sidenav', 'sidebar', 'navigation', 'tabs', 'tab', 'tab list', 'breadcrumb'], ['menu', 'pagination', 'nav drawer'], ['stepper', 'scrollspy', 'launchpad']),
  def('Data display', 'primary', ['table', 'data grid', 'list', 'card'], ['tree', 'heading', 'code', 'chip', 'tag'], ['chart', 'inline edit', 'visually hidden', 'sr only', 'pill']),
  def('Feedback and status', 'primary', ['alert', 'banner', 'message bar', 'progress', 'spinner', 'busy indicator'], ['toast', 'snackbar', 'notification', 'flag', 'badge', 'skeleton', 'placeholder'], ['lozenge', 'empty state', 'exception list']),
  def('Overlays', 'secondary', ['modal', 'dialog', 'tooltip'], ['popover', 'dropdown', 'drawer', 'offcanvas', 'sheet', 'bottom sheet', 'side sheet'], ['blanket', 'popper', 'portal']),
  def('Media and identity', 'secondary', ['image', 'img', 'icon', 'figure'], ['avatar', 'logo'], ['carousel', 'thumbnail', 'video thumbnail', 'tile', 'persona']),
  def('Patterns and page templates', 'secondary', ['forms flow', 'form flow', 'search and filter', 'search filter', 'search'], ['create', 'edit', 'export'], ['dashboard', 'floorplan', 'chatbot', 'page template']),
  def('Content and voice', 'secondary', ['voice and tone', 'voice', 'tone', 'ui text'], ['error message', 'date and time', 'date time'], ['inclusive language', 'in app help']),
  def('Utilities and tooling', 'others', ['design tokens', 'ui kit'], ['figma library', 'figma libraries', 'plugin'], ['linter', 'storybook addon', 'helper class', 'utility', 'utilities', 'tooling']),
  def('Miscellaneous', 'others', [], [], []),
];

export type ClassifiableItem = {
  name: string; kind?: string; html?: string; deprecated?: boolean; confidence?: string;
  taxonomyHint?: string; evidence?: readonly {source?: string}[]; source?: string | readonly string[];
};
export type Classification = {category: string; tier: Tier; rank: ItemRank; matchedBy: string; crossReferences: string[]};
type Candidate = {category: string; tier: Tier; rank: ItemRank; alias: string; categoryIndex: number; rankIndex: number};

function normalizedName(name: string): string {
  return String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/^(?:Mui|Mdc|Ant)(?=[A-Z])/, '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}
function hits(text: string, alias: string): boolean {
  const padded = ' ' + text + ' ';
  return padded.includes(' ' + alias + ' ') || padded.includes(' ' + alias + 's ') || padded.includes(' ' + alias + 'es ')
    || (alias.endsWith('y') && padded.includes(' ' + alias.slice(0, -1) + 'ies '));
}
const categoryTier = (category: string): Tier => CATEGORY_TAXONOMY.find(c => c.category === category)?.tier ?? 'others';
const unique = (values: string[]) => [...new Set(values)];

export function classifyItem(item: ClassifiableItem): Classification {
  const name = normalizedName(item.name);
  const archived = (item.evidence ?? []).some(e => /(?:^|\/)(?:archives?|backups?|__tests__|__mocks__|fixtures?)(?:\/|$)|\.(?:test|spec|stories)\.[a-z]+$/i.test(e.source ?? ''));
  if (archived || item.deprecated === true || /\bdeprecated\b/.test(name) || (item.confidence === 'Documentation heading' && /\b(?:guide|instructions?|archive|changelog|tutorial)\b/.test(name)))
    return {category: 'Miscellaneous', tier: 'others', rank: 'other_items', matchedBy: 'Supporting, archived, or deprecated material', crossReferences: []};
  if (item.kind !== 'token' && /^(?:d-|m[trblsexy]?-|p[trblsexy]?-|text-(?:left|right|start|end|center|nowrap)|w-|h-|gap-)/.test(item.name || ''))
    return {category: 'Utilities and tooling', tier: 'others', rank: 'other_items', matchedBy: 'Runtime helper class', crossReferences: []};

  let candidates: Candidate[] = [];
  for (const [categoryIndex, category] of CATEGORY_TAXONOMY.entries())
    for (const [rankIndex, rank] of ITEM_RANKS.entries())
      for (const alias of category.ranks[rank]) if (hits(name, alias)) candidates.push({category: category.category, tier: category.tier, rank, alias, categoryIndex, rankIndex});

  if (item.kind === 'token') {
    candidates = candidates.filter(c => c.category === 'Foundations and tokens');
    if (!candidates.length) return {category: 'Foundations and tokens', tier: 'primary', rank: 'other_items', matchedBy: 'Declared design token', crossReferences: []};
  } else {
    // A shared alias resolves to the item's primary job: a Grid component is layout, an Icon is media.
    if (candidates.some(c => c.category === 'Layout and structure' && c.alias === 'grid')) candidates = candidates.filter(c => !(c.category === 'Foundations and tokens' && c.alias === 'grid'));
    if (candidates.some(c => c.category === 'Media and identity' && c.alias === 'icon')) candidates = candidates.filter(c => !(c.category === 'Foundations and tokens' && c.alias === 'icon'));
  }

  if (!candidates.length && item.html) {
    const tag = item.html.match(/^<([a-z][\w-]*)/i)?.[1]?.toLowerCase() ?? '', role = item.html.match(/role\s*=\s*["']([^"']+)["']/i)?.[1];
    const category = tag === 'button' || tag === 'a' || role === 'button' ? 'Actions'
      : ['input', 'select', 'textarea'].includes(tag) ? 'Forms and input'
      : ['table', 'ul', 'ol'].includes(tag) ? 'Data display'
      : tag === 'nav' || role === 'navigation' ? 'Navigation'
      : tag === 'dialog' || role === 'dialog' || role === 'tooltip' ? 'Overlays'
      : ['img', 'svg'].includes(tag) ? 'Media and identity'
      : role === 'alert' || role === 'status' ? 'Feedback and status' : null;
    if (category) return {category, tier: categoryTier(category), rank: 'primary_items', matchedBy: 'Observed semantic element/role', crossReferences: []};
  }
  const hint = CATEGORY_TAXONOMY.find(c => c.category === item.taxonomyHint);
  if (!candidates.length && hint) return {category: hint.category, tier: hint.tier, rank: 'other_items', matchedBy: 'Imported registry category', crossReferences: []};
  if (!candidates.length) return {category: 'Miscellaneous', tier: 'others', rank: 'other_items', matchedBy: 'Catch-all: no category match', crossReferences: []};

  candidates.sort((a, b) => b.alias.length - a.alias.length || a.categoryIndex - b.categoryIndex || a.rankIndex - b.rankIndex);
  if (hint) {
    const preferred = candidates.find(c => c.category === hint.category);
    return {category: hint.category, tier: hint.tier, rank: preferred?.rank ?? 'other_items', matchedBy: 'Imported registry category: ' + (preferred?.alias ?? hint.category), crossReferences: unique(candidates.filter(c => c.category !== hint.category).map(c => c.category))};
  }
  const chosen = candidates[0]!;
  return {category: chosen.category, tier: chosen.tier, rank: chosen.rank, matchedBy: chosen.alias, crossReferences: unique(candidates.filter(c => c.category !== chosen.category).map(c => c.category))};
}

export type Occurrence<T> = T & Classification & {collectionId: string; system: string; source: string[]; legacyCategory?: string};

export function assertCollectionCoverage(master: readonly {collectionId: string}[], collected: readonly {collectionId: string}[]) {
  if (master.length !== collected.length) throw new Error(`Taxonomy coverage failed: ${master.length} master items, ${collected.length} collected items.`);
  const expected = new Set(master.map(i => i.collectionId)), visited = new Set<string>();
  if (expected.size !== master.length) throw new Error('Taxonomy coverage failed: master occurrence IDs are not unique.');
  for (const item of collected) {
    if (!expected.has(item.collectionId) || visited.has(item.collectionId)) throw new Error('Taxonomy coverage failed: missing, duplicate, or foreign occurrence.');
    visited.add(item.collectionId);
  }
  return {verified: true as const, masterCount: master.length, collectedCount: collected.length};
}

// Visits tiers → categories → ranks in fixed order, assigns every occurrence once,
// and verifies the collected list reconciles with the master list.
export function collectMasterList<T extends ClassifiableItem & {category?: string}>(systems: readonly {system: string; items: readonly T[]}[]) {
  const master: Occurrence<T>[] = systems.flatMap(({system, items}) => items.map((item, index) => ({
    ...item, legacyCategory: item.category, collectionId: system + ':' + index, system,
    source: unique([...(item.evidence ?? []).map(e => e.source ?? ''), ...(Array.isArray(item.source) ? item.source : typeof item.source === 'string' ? [item.source] : [])].filter(Boolean)),
    ...classifyItem(item),
  })));
  const collected: Occurrence<T>[] = [], visited = new Set<string>();
  for (const tier of TIERS) for (const category of CATEGORY_TAXONOMY.filter(c => c.tier === tier)) for (const rank of ITEM_RANKS)
    for (const item of master) if (item.category === category.category && item.rank === rank) { collected.push(item); visited.add(item.collectionId); }
  for (const item of master) if (!visited.has(item.collectionId)) collected.push({...item, category: 'Miscellaneous', tier: 'others', rank: 'other_items', matchedBy: 'Catch-all: unvisited occurrence'});
  const coverage = assertCollectionCoverage(master, collected);
  const count = (filter: (item: Occurrence<T>) => boolean) => collected.filter(filter).length;
  const counts = {
    perTier: Object.fromEntries(TIERS.map(t => [t, count(i => i.tier === t)])),
    perCategory: Object.fromEntries(CATEGORY_TAXONOMY.map(c => [c.category, count(i => i.category === c.category)])),
    perSystem: Object.fromEntries(systems.map(s => [s.system, {
      total: count(i => i.system === s.system),
      perTier: Object.fromEntries(TIERS.map(t => [t, count(i => i.system === s.system && i.tier === t)])),
      perCategory: Object.fromEntries(CATEGORY_TAXONOMY.map(c => [c.category, count(i => i.system === s.system && i.category === c.category)])),
    }])),
  };
  return {items: collected, coverage, counts, order: {tiers: TIERS, categories: CATEGORY_TAXONOMY.map(c => c.category), ranks: ITEM_RANKS}};
}
