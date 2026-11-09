// GapScan engine (architecture Part 2): match an extracted system's components
// to a reference system, diff what differs, decide what to do, and price it with
// the shared rubric. Pure and deterministic: the same inputs give the same report.
import {applyEstimates, planningTotals} from '@gapscan/estimate';
import {colorDistance, parseColor} from '@gapscan/normalize';
import {classifyItem} from '@gapscan/taxonomy';
import type {UsageReport} from '@gapscan/schema';
import type {Assumptions, ComponentMatch, ComponentObservation, Decision, ExtractedDesignSystem, GapDiff, GapItem, GapScanReport, ReferenceDS, Token} from '@gapscan/schema';

export const MATCH_WEIGHTS = Object.freeze({anatomy: 35, capability: 25, role: 20, tokenSlots: 10, name: 10});
export const MATCH_THRESHOLDS = Object.freeze({confirmed: 75, suggested: 50, ambiguityGap: 5});

const words = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^(polaris|cds|bx|mdc|md|mui|ant|chakra|bs)[-_ ]+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const canonicalName = (c: ComponentObservation) => words(c.canonical);
// Taxonomy aliases that name the same component type in different libraries.
const ITEM_ALIASES: Record<string, string> = {
  btn: 'button', 'btn group': 'button group', textfield: 'text field', 'text input': 'text field', input: 'text field', textarea: 'text area',
  img: 'image', sidenav: 'side nav', 'nav drawer': 'side nav', modal: 'dialog', snackbar: 'toast', flag: 'toast', switch: 'toggle', offcanvas: 'drawer', fab: 'floating action button',
  tag: 'chip', pill: 'chip', collapse: 'accordion', 'message bar': 'alert', notification: 'toast', combobox: 'autocomplete', 'search field': 'search box',
  'number input': 'spin button', 'data grid': 'table', 'tab list': 'tabs', tab: 'tabs', sheet: 'drawer', sidebar: 'side nav',
};
const itemOf = (c: ComponentObservation) => { const alias = classifyItem({name: c.canonical, kind: 'component'}).matchedBy; return ITEM_ALIASES[alias] ?? alias; };
function jaccard(a: readonly string[], b: readonly string[]): number {
  const x = new Set(a), y = new Set(b);
  if (!x.size && !y.size) return 0;
  return [...x].filter(v => y.has(v)).length / new Set([...x, ...y]).size;
}

// Common naming differences between libraries; used to tell a rename from a missing option.
// A word may sit in several groups ("default" is the filled button in shadcn and Chakra, the neutral
// one in Polaris and Ant Design, and the medium size): a pairing needs one shared group.
const SYNONYMS: string[][] = [
  ['primary', 'filled', 'solid', 'contained', 'brand', 'default'], ['secondary', 'outline', 'outlined', 'tonal', 'default'], ['tertiary', 'ghost', 'plain', 'text', 'link', 'subtle'],
  ['danger', 'critical', 'destructive', 'error', 'negative'], ['success', 'positive'], ['warning', 'caution'], ['info', 'informational', 'highlight'],
  ['sm', 'small', 'slim', 'compact'], ['md', 'medium', 'middle', 'default', 'regular'], ['lg', 'large', 'big'], ['xs', 'micro', 'extra small'], ['xl', 'extra large'],
  ['focus', 'focus visible', 'focused'], ['pressed', 'active'], ['hover', 'hovered'], ['loading', 'busy', 'pending'], ['checked', 'selected', 'on', 'toggled'],
  // Prop names that mean the same thing across libraries.
  ['tone', 'color', 'intent', 'severity', 'status', 'color scheme'], ['kind', 'variant', 'appearance', 'look'], ['left icon', 'start icon', 'icon start', 'leading icon', 'prefix'],
  ['right icon', 'end icon', 'icon end', 'trailing icon', 'suffix'], ['removable', 'on delete', 'deletable', 'dismissible', 'closable', 'on remove'],
  ['full width', 'block', 'fluid', 'stretch'], ['helper text', 'hint', 'description', 'help text'], ['label', 'title'],
];
const optionName = (value: string) => words(value.replace(/^[\w ]+=/, '')).replace(/^is /, '');
const groupsOf = (value: string) => SYNONYMS.flatMap((group, i) => group.includes(optionName(value)) ? [i] : []);
export function sameOption(a: string, b: string): 'same' | 'renamed' | null {
  if (optionName(a) === optionName(b)) return 'same';
  const gb = groupsOf(b);
  return groupsOf(a).some(g => gb.includes(g)) ? 'renamed' : null;
}
// outline/outlined, success/successful: one word grown from the other.
const sameStem = (a: string, b: string) => { const x = optionName(a), y = optionName(b); return x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x)); };

// The closest option in `targets`: an identical value wins over a synonym, and among equals the one
// on the same (or a synonymous) prop. Bare values belong to `variant`. GapScan's diff and the codemod
// both pair options with this, so the report and the rewrite always agree.
const optionProp = (option: string) => option.match(/^([\w-]+)=/)?.[1] ?? 'variant';
export function pairOption(option: string, targets: readonly string[], bare = 'variant'): {option: string; kind: 'same' | 'renamed'} | null {
  const propOf = (o: string) => o.includes('=') ? optionProp(o) : bare;
  let best: {option: string; kind: 'same' | 'renamed'} | null = null, bestScore = 0;
  for (const t of targets) {
    const kind = sameOption(option, t);
    if (!kind) continue;
    const score = (kind === 'same' ? 4 : sameStem(option, t) ? 3 : 2) + (propOf(t) === propOf(option) || sameOption(propOf(t), propOf(option)) ? 1 : 0);
    if (score > bestScore) { best = {option: t, kind}; bestScore = score; }
  }
  return best;
}

export type Candidate = {target: ComponentObservation; score: number; reasons: string[]};
export function scoreCandidate(source: ComponentObservation, target: ComponentObservation): Candidate {
  const reasons: string[] = [];
  const sameItem = itemOf(source) === itemOf(target) && !/Catch-all/.test(itemOf(source));
  const anatomy = sameItem ? 1 : source.category === target.category ? 0.4 : 0;
  if (sameItem) reasons.push(`Same component type (${itemOf(source)})`); else if (anatomy) reasons.push('Same category, different component type');
  // Prop names are capability evidence too: Button and Toggle Button share a type but not an API.
  const withProps = Boolean(source.props?.length && target.props?.length);
  const options = (c: ComponentObservation) => [...c.variants.map(v => v.name), ...c.sizes, ...c.statesObserved, ...(withProps ? (c.props ?? []).map(p => `prop ${p.name}`) : [])].map(optionName);
  const sourceOptions = options(source), targetOptions = options(target);
  const overlap = sourceOptions.filter(o => targetOptions.some(t => sameOption(o.replace(/^prop /, ''), t.replace(/^prop /, '')) && o.startsWith('prop ') === t.startsWith('prop '))).length;
  const capability = sourceOptions.length && targetOptions.length ? overlap / Math.max(sourceOptions.length, Math.min(targetOptions.length, sourceOptions.length * 2)) : 0;
  if (capability > 0) reasons.push(`${overlap} shared variant, size or state option${overlap === 1 ? '' : 's'}`);
  const role = source.category === target.category ? 1 : 0;
  const slots = (c: ComponentObservation) => c.variants.flatMap(v => Object.keys(v.tokenRefs));
  const tokenSlots = jaccard(slots(source), slots(target));
  if (tokenSlots > 0) reasons.push('Shared token slots');
  const naming = canonicalName(source) === canonicalName(target) ? 1 : canonicalName(source).includes(canonicalName(target)) || canonicalName(target).includes(canonicalName(source)) ? 0.5 : 0;
  if (naming === 1) reasons.push('Same name');
  const score = Math.round(MATCH_WEIGHTS.anatomy * anatomy + MATCH_WEIGHTS.capability * Math.min(1, capability) + MATCH_WEIGHTS.role * role + MATCH_WEIGHTS.tokenSlots * tokenSlots + MATCH_WEIGHTS.name * naming);
  return {target, score, reasons};
}

export function matchComponent(source: ComponentObservation, targets: readonly ComponentObservation[], approvals: ReadonlyMap<string, {targetId: string | null; by: string}> = new Map()): ComponentMatch & {candidates: Candidate[]} {
  const candidates = targets.map(t => scoreCandidate(source, t)).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id));
  const approval = approvals.get(source.id);
  if (approval) {
    const chosen = candidates.find(c => c.target.id === approval.targetId);
    return {sourceId: source.id, targetId: approval.targetId, score: chosen?.score ?? 0, status: 'confirmed', reasons: ['Approved by a reviewer', ...(chosen?.reasons ?? [])], approvedBy: approval.by, candidates};
  }
  const [best, second] = candidates;
  if (!best || best.score < MATCH_THRESHOLDS.suggested) return {sourceId: source.id, targetId: null, score: best?.score ?? 0, status: 'unresolved', reasons: best ? ['Closest candidate is too weak to propose'] : ['No counterpart identified'], candidates};
  const ambiguous = second !== undefined && best.score - second.score < MATCH_THRESHOLDS.ambiguityGap;
  const status = ambiguous ? 'unresolved' : best.score >= MATCH_THRESHOLDS.confirmed && best.target.category === source.category ? 'confirmed' : 'suggested';
  return {sourceId: source.id, targetId: ambiguous ? null : best.target.id, score: best.score, status, reasons: ambiguous ? [`Several possible matches (${best.target.canonical}, ${second.target.canonical})`] : best.reasons, candidates};
}

const REQUIRED_A11Y = new Set(['focus-visible', 'focus']);
export function diffComponents(source: ComponentObservation, target: ComponentObservation): GapDiff[] {
  const diffs: GapDiff[] = [];
  const compare = (from: string[], to: string[], dimension: 'variants' | 'sizes', label: string) => {
    for (const option of from) {
      const paired = pairOption(option, to);
      if (paired?.kind === 'same') continue;
      diffs.push(paired
        ? {dimension, driver: 'variant_renamed', summary: `${label} “${optionName(option)}” becomes “${optionName(paired.option)}”`, before: option, after: paired.option}
        : {dimension, driver: 'variant_missing', summary: `${label} “${optionName(option)}” has no equivalent in ${target.canonical}`, before: option});
    }
  };
  compare(source.variants.map(v => v.name), target.variants.map(v => v.name), 'variants', 'Style');
  // A target with no size options has one default size: your medium/default size maps to it.
  compare(target.sizes.length ? source.sizes : source.sizes.filter(s => !groupsOf(s).includes(SYNONYMS.findIndex(g => g.includes('medium')))), target.sizes, 'sizes', 'Size');
  // States you rely on that the target lacks must be built; states the target adds come with it.
  // Hover, focus and pressed are styling: a reference read from type declarations cannot show them,
  // so they are compared only when the reference recorded at least one of them.
  const INTERACTION = /^(hover|focus|focus-visible|active|pressed)$/;
  const targetShowsInteraction = target.statesObserved.some(s => INTERACTION.test(s));
  // Disabled, read-only and required come from the native element: a reference read from type
  // declarations often inherits them without listing them, so their absence there proves nothing.
  const NATIVE_STATE = /^(disabled|readonly|read-only|required)$/;
  const inheritsNative = (state: string) => NATIVE_STATE.test(state) && Boolean(target.props?.length) && !target.props!.some(p => p.name.toLowerCase() === state.replace('-', ''));
  for (const state of source.statesObserved) {
    if (target.statesObserved.some(t => sameOption(state, t))) continue;
    if (INTERACTION.test(state) && !targetShowsInteraction) continue;
    if (inheritsNative(state)) continue;
    diffs.push({dimension: REQUIRED_A11Y.has(state) ? 'a11y' : 'states', driver: 'state_missing', summary: `Your ${optionName(state)} state has no equivalent in ${target.canonical}; it must be built or dropped`, before: state});
  }
  for (const state of target.statesObserved) {
    if (source.statesObserved.some(s => sameOption(s, state))) continue;
    diffs.push(REQUIRED_A11Y.has(state)
      ? {dimension: 'a11y', driver: null, summary: `Gains a visible keyboard focus style built into ${target.canonical}`, after: state}
      : {dimension: 'states', driver: null, summary: `Gains the ${optionName(state)} state built into ${target.canonical}`, after: state});
  }
  // Props whose values were already compared as styles or sizes are not priced a second time.
  const OPTION_PROPS = /^(variant|kind|appearance|tone|color|colorScheme|intent|look|size|type|status|severity)$/;
  // Event handlers and DOM attributes pass through to the element in every React library;
  // references read from type declarations list only the component's own props.
  const DOM_PROPS = /^(on[A-Z]\w*|aria-[\w-]+|data-[\w-]+|className|style|id|children|ref|key|role|tabIndex|disabled|required|readOnly|placeholder|name|value|defaultValue|autoFocus|autoComplete|href|target|rel)$/;
  if (source.props?.length && target.props?.length) for (const prop of source.props) {
    if (target.props.some(p => p.name === prop.name) || OPTION_PROPS.test(prop.name) || DOM_PROPS.test(prop.name)) continue;
    const similar = target.props.find(p => sameOption(p.name, prop.name) || words(p.name).replace(/ /g, '') === words(prop.name).replace(/ /g, ''));
    diffs.push(similar
      ? {dimension: 'api', driver: 'prop_rename', summary: `Prop “${prop.name}” becomes “${similar.name}”`, before: prop.name, after: similar.name}
      : {dimension: 'api', driver: 'prop_semantic', summary: `Prop “${prop.name}” has no direct equivalent; usage needs rework`, before: prop.name});
  }
  // Neither side shows keyboard focus: that has to be built, whichever system you use.
  const targetHasFocus = target.statesObserved.some(s => REQUIRED_A11Y.has(s));
  if (source.a11y.focusVisible === false && !targetHasFocus && targetShowsInteraction) diffs.push({dimension: 'a11y', driver: 'a11y_fix', summary: 'Needs a visible keyboard focus style; neither version has one', after: 'focus-visible'});
  return diffs;
}

export function decide(match: ComponentMatch, diffs: readonly GapDiff[]): Decision {
  if (match.status === 'unresolved') return match.targetId === null && match.reasons.includes('No counterpart identified') ? 'replace' : 'check_first';
  if (!match.targetId) return 'replace';
  return diffs.some(d => d.driver !== null) ? 'update' : 'keep';
}

const TOKEN_CATEGORY: Record<string, string> = {color: 'Colours', dimension: 'Spacing and sizing', radius: 'Shape', shadow: 'Elevation', fontFamily: 'Typography', fontWeight: 'Typography', typography: 'Typography', duration: 'Motion', cubicBezier: 'Motion'};
// Tokens the team declared (not palette clusters GapScan inferred) all need mapping to the target's names.
export function tokenCategories(tokens: readonly Token[]): {name: string; remappedTokens: number}[] {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.path.startsWith('color.palette.') || token.confidence < 0.5) continue;
    const name = TOKEN_CATEGORY[token.type];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, remappedTokens]) => ({name, remappedTokens})).sort((a, b) => a.name.localeCompare(b.name));
}

// Role-level colour mapping for the technical layer: your role value → the reference's.
export function tokenDiff(source: readonly Token[], target: readonly Token[]) {
  const roles = (tokens: readonly Token[]) => new Map(tokens.filter(t => /^color\.(primary|text|surface|border|danger|warning|success|info)$/.test(t.path)).map(t => [t.path, String(t.value)]));
  const s = roles(source), t = roles(target);
  return [...s].map(([path, before]) => {
    const after = t.get(path), distance = after ? colorDistance(before, after) : null;
    return {slot: path, before, after: after ?? null, change: after === undefined ? 'no reference role' : distance !== null && distance < 2 ? 'same' : 'remap'};
  });
}

// Projected "after" preview (Part 2 §2.4): the reference's own CSS with its role colours
// replaced by yours. Always labelled projected; it is not built or verified code.
export function projectSpecimen(css: string, mapping: readonly {before: string; after: string | null; change: string}[]) {
  const substitutions: {from: string; to: string}[] = [];
  const swaps = mapping.filter((m): m is {before: string; after: string; change: string} => m.change === 'remap' && m.after !== null && parseColor(m.before) !== null);
  const projected = css.replace(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/gi, literal => {
    if ((parseColor(literal)?.alpha ?? 1) < 1) return literal;   // translucent overlays and shadows keep their own colour
    const swap = swaps.find(s => (colorDistance(literal, s.after) ?? 99) < 2);
    if (!swap) return literal;
    if (!substitutions.some(x => x.from === literal)) substitutions.push({from: literal, to: swap.before});
    return swap.before;
  });
  return {css: projected, substitutions};
}

export type GapScanInput = {source: ExtractedDesignSystem; reference: ReferenceDS; assumptions?: Partial<Assumptions>; approvals?: ReadonlyMap<string, {targetId: string | null; by: string}>; usage?: UsageReport | null};
export function runGapScan({source, reference, assumptions = {}, approvals = new Map(), usage = null}: GapScanInput): Omit<GapScanReport, 'id'> {
  const usageOf = new Map((usage?.components ?? []).map(u => [u.component, u]));
  const claimed = new Set<string>();
  const items: GapItem[] = source.components.map(component => {
    const {candidates: _candidates, ...match} = matchComponent(component, reference.components, approvals);
    const target = reference.components.find(c => c.id === match.targetId);
    if (target) claimed.add(target.id);
    const diffs = target ? diffComponents(component, target) : [];
    const decision = decide(match, diffs);
    const sourceSpecimen = source.specimens.find(s => s.id === `sp:${component.id}`)?.id;
    const targetSpecimen = target ? reference.specimens.find(s => s.id === `sp:${target.id}`)?.id : undefined;
    return {
      id: `gap:${component.id}`, name: component.canonical, category: component.category, match, decision, diffs,
      variantsInScope: Math.max(1, component.variants.length + component.sizes.length), inferredShare: component.confidence < 0.5 ? 1 : 0,
      ...(() => { const u = usageOf.get(component.canonical); return u ? {instances: u.usages, usage: {usages: u.usages, files: u.files.length, screens: u.screens.length, propUsages: u.propUsages}} : {instances: component.instances}; })(),
      effort: {level: null, label: '', drivers: [], low: null, high: null, basis: ''}, quickWin: false, breaking: false,
      ...(sourceSpecimen ? {beforeSpecimenId: sourceSpecimen} : {}), ...(targetSpecimen ? {afterSpecimenId: targetSpecimen} : {}),
      acceptance: [
        ...(target ? [`Matches ${reference.library} ${target.canonical} visually in every kept variant`] : []),
        ...(diffs.some(d => d.dimension === 'a11y') ? ['Keyboard focus is visible on every interactive state'] : []),
        ...(decision === 'replace' ? ['A reviewer has chosen a replacement or confirmed custom code'] : []),
      ],
    };
  });
  // Reference components nothing maps to are optional adoption, never required work.
  for (const target of reference.components) if (!claimed.has(target.id)) items.push({
    id: `gap:target:${target.id}`, name: target.canonical, category: target.category, decision: 'optional', diffs: [],
    match: {sourceId: `target:${target.id}`, targetId: target.id, score: 0, status: 'suggested', reasons: ['Only in the reference system']},
    variantsInScope: 1, inferredShare: 0, instances: 0, effort: {level: null, label: '', drivers: [], low: null, high: null, basis: ''}, quickWin: false, breaking: false, acceptance: [],
  });
  const estimated = applyEstimates(items), categories = tokenCategories(source.tokens);
  const totals = planningTotals(estimated, categories, assumptions);
  const mapping = tokenDiff(source.tokens, reference.tokens);
  return {
    edsId: source.id, edsFingerprint: source.fingerprint, reference: {id: reference.id, version: reference.libraryVersion},
    items: estimated.map(item => item.decision === 'optional' ? item : {...item, tech: {tokenDiff: mapping, propMap: item.diffs.filter(d => d.dimension === 'api').map(d => ({from: d.before, to: d.after ?? null}))}}),
    tokenCategories: categories, assumptions: {rate: 75, apps: 1, engineers: 2, qaPct: 20, excluded: [], edited: {}, ...assumptions}, totals,
    exclusions: [
      totals.notEstimatedCount === 1 ? '1 item needs review before it can be estimated' : `${totals.notEstimatedCount} items need review before they can be estimated`,
      usage ? `${totals.consumer?.unusedExcluded ?? 0} component${totals.consumer?.unusedExcluded === 1 ? '' : 's'} not used in the scanned application (${usage.filesScanned} files) are left out` : 'Your application code was not scanned, so screen and usage counts are unknown',
      'Optional components from the reference system are not included',
      'Dedicated regression, visual and accessibility testing beyond the QA allowance',
    ],
  };
}
