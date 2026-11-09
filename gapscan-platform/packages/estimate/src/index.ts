// The only implementation of GapScan effort, cost and time (architecture Part 2).
// The API calls it on the server; clients only display its output. Numbers are
// editable planning heuristics, not measured delivery guarantees.
import {Assumptions as AssumptionsSchema} from '@gapscan/schema';
import type {Assumptions, EffortDriver, EffortEstimate, EffortLevel, GapDiff, GapItem, GapScanTotals} from '@gapscan/schema';

type DriverRule = {points: number; floor: EffortLevel; cap?: number; label: string};

export const RUBRIC = Object.freeze({
  base: Object.freeze({1: [0.5, 1.5], 2: [2, 4], 3: [6, 12], 4: [16, 32], 5: [40, 80]}) as Readonly<Record<EffortLevel, readonly [number, number]>>,
  labels: Object.freeze({1: 'Trivial', 2: 'Easy', 3: 'Moderate', 4: 'Hard', 5: 'Very hard'}) as Readonly<Record<EffortLevel, string>>,
  // [maximum points, level]; anything above the last band is level 5.
  bands: Object.freeze([[1, 1], [3, 2], [6, 3], [10, 4]] as const),
  drivers: Object.freeze({
    token_value: {points: 1, floor: 1, label: 'Value-only token change'},
    token_rename: {points: 1, floor: 1, label: 'Token rename or alias remap'},
    variant_renamed: {points: 1, floor: 2, cap: 3, label: 'Variant renamed or merged'},
    variant_missing: {points: 2, floor: 2, label: 'Variant or size has no target equivalent'},
    state_missing: {points: 2, floor: 2, label: 'Missing state must be built'},
    a11y_fix: {points: 2, floor: 2, label: 'Accessibility fix needed'},
    prop_rename: {points: 2, floor: 2, label: 'Mechanical prop or API rename'},
    prop_semantic: {points: 4, floor: 3, label: 'Prop or API semantic change'},
    anatomy_change: {points: 4, floor: 4, label: 'Markup or anatomy change'},
    behaviour_change: {points: 4, floor: 4, label: 'Behaviour, keyboard or ARIA change'},
    no_counterpart: {points: 8, floor: 5, label: 'No counterpart; replacement or custom build'},
    framework_switch: {points: 2, floor: 2, label: 'Framework switch: imports and call sites change'},
  }) as Readonly<Record<EffortDriver, DriverRule>>,
  variant: Object.freeze({step: 0.15, cap: 2.5}),
  uncertaintySpan: 0.5,
  tokens: Object.freeze({verificationHours: 2, hoursPerToken: 0.1, highRatio: 1.5}),
  quickWin: Object.freeze({maxLevel: 2, minInstances: 50}),
  productiveHours: 35,
  // Updating call sites in the application, per affected usage: renames a codemod can apply vs. changes needing rework.
  consumer: Object.freeze({mechanical: [0.05, 0.15] as const, semantic: [0.25, 0.5] as const}),
});

export const NOT_ESTIMATED = 'Not estimated';
const halfHourUp = (value: number) => Math.ceil(value * 2) / 2;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function effortLabel(level: EffortLevel | null): string {
  return level ? `Level ${level} · ${RUBRIC.labels[level]}` : NOT_ESTIMATED;
}

// Each diff adds its driver's points (capped per driver where the rubric says so);
// the level is the larger of the points band and the most severe driver's floor.
export function levelForDiffs(diffs: readonly Pick<GapDiff, 'driver'>[]): EffortLevel {
  const perDriver = new Map<EffortDriver, number>();
  for (const diff of diffs) if (diff.driver) perDriver.set(diff.driver, (perDriver.get(diff.driver) ?? 0) + 1);
  let points = 0, floor: EffortLevel = 1;
  for (const [driver, count] of perDriver) {
    const rule = RUBRIC.drivers[driver];
    points += rule.points * Math.min(count, rule.cap ?? count);
    if (rule.floor > floor) floor = rule.floor;
  }
  const band = (RUBRIC.bands.find(([max]) => points <= max)?.[1] ?? 5) as EffortLevel;
  return (band > floor ? band : floor);
}

export function variantFactor(variantsInScope: number): number {
  return Math.min(RUBRIC.variant.cap, 1 + RUBRIC.variant.step * (Math.max(1, variantsInScope) - 1));
}

export function uncertaintyFactor(inferredShare: number): number {
  return 1 + RUBRIC.uncertaintySpan * Math.min(1, Math.max(0, inferredShare));
}

type EstimateInput = Pick<GapItem, 'decision' | 'match' | 'diffs'> & Partial<Pick<GapItem, 'variantsInScope' | 'inferredShare'>>;

// Unresolved matches and unreviewed replacements return null hours: absence from
// captured evidence is not proof of work, and is never shown as free work.
export function estimateItem(item: EstimateInput): EffortEstimate {
  const priced = item.diffs.filter((d): d is typeof d & {driver: EffortDriver} => d.driver !== null), drivers = [...new Set(priced.map(diff => diff.driver))];
  const notEstimated = (basis: string): EffortEstimate => ({level: null, label: NOT_ESTIMATED, drivers, low: null, high: null, basis});
  if (item.decision === 'check_first' || item.match.status === 'unresolved') return notEstimated('Match or evidence unresolved; review before estimating.');
  if (item.decision === 'replace' && !item.match.approvedBy) return notEstimated('No counterpart in captured evidence; a reviewer must approve the replacement scope first.');
  const diffs = item.decision === 'replace' && !drivers.includes('no_counterpart') ? [...priced, {driver: 'no_counterpart' as const}] : priced;
  const level = diffs.length ? levelForDiffs(diffs) : 1;
  const [baseLow, baseHigh] = RUBRIC.base[level], factor = variantFactor(item.variantsInScope ?? 1);
  const low = halfHourUp(baseLow * factor), high = halfHourUp(baseHigh * factor * uncertaintyFactor(item.inferredShare ?? 0));
  const basis = diffs.length ? `Level ${level} from ${[...new Set(diffs.map(d => RUBRIC.drivers[d.driver].label))].join(', ')}.` : 'Level 1: verification of an unchanged, confirmed definition.';
  return {level, label: effortLabel(level), drivers: [...new Set(diffs.map(d => d.driver))], low, high, basis};
}

// A manual edit replaces the low baseline; the high end keeps the item's spread.
export function editedRange(effort: EffortEstimate, editedLow: number | undefined): {low: number; high: number} | null {
  if (effort.low === null || effort.high === null) return null;
  if (editedLow === undefined) return {low: effort.low, high: effort.high};
  const ratio = effort.low > 0 ? effort.high / effort.low : 1;
  return {low: editedLow, high: halfHourUp(editedLow * ratio)};
}

export function tokenCategoryRange(remappedTokens: number): {low: number; high: number} {
  const low = RUBRIC.tokens.verificationHours + RUBRIC.tokens.hoursPerToken * remappedTokens;
  return {low: round2(low), high: halfHourUp(low * RUBRIC.tokens.highRatio)};
}

export function isQuickWin(item: Pick<GapItem, 'diffs' | 'instances'>, effort: EffortEstimate): boolean {
  return effort.level !== null && effort.level <= RUBRIC.quickWin.maxLevel
    && (item.diffs.some(diff => diff.driver === 'a11y_fix' || (diff.driver === null && diff.dimension === 'a11y')) || (item.instances ?? 0) >= RUBRIC.quickWin.minInstances);
}

export function isBreaking(item: Pick<GapItem, 'diffs' | 'decision'>, effort: EffortEstimate): boolean {
  return (effort.level !== null && effort.level >= 4) || item.decision === 'replace' || item.diffs.some(diff => diff.driver === 'prop_semantic');
}

// Recomputes effort and flags so every item in a report follows the current rubric.
export function applyEstimates<T extends GapItem>(items: readonly T[]): T[] {
  return items.map(item => {
    const effort = estimateItem(item);
    return {...item, effort, quickWin: isQuickWin(item, effort), breaking: isBreaking(item, effort)};
  });
}

const SEMANTIC_DRIVERS: ReadonlySet<EffortDriver> = new Set(['prop_semantic', 'anatomy_change', 'behaviour_change', 'variant_missing', 'state_missing', 'no_counterpart']);
// Call sites to update for one item. Prop renames only touch usages that pass that prop.
export function consumerRange(item: Pick<GapItem, 'diffs' | 'decision' | 'usage'>): {low: number; high: number; affected: number} | null {
  if (!item.usage || !item.usage.usages || item.decision === 'keep' || item.decision === 'optional') return null;
  const priced = item.diffs.filter(d => d.driver !== null);
  if (!priced.length && item.decision !== 'replace') return null;
  const semantic = item.decision === 'replace' || priced.some(d => SEMANTIC_DRIVERS.has(d.driver!));
  const propRenames = priced.filter(d => d.driver === 'prop_rename').map(d => String(d.before));
  const touchesAll = semantic || priced.some(d => d.driver !== 'prop_rename');
  const affected = touchesAll ? item.usage.usages : Math.min(item.usage.usages, propRenames.reduce((sum, p) => sum + (item.usage!.propUsages[p] ?? 0), 0));
  const [low, high] = RUBRIC.consumer[semantic ? 'semantic' : 'mechanical'];
  return {low: Math.round(affected * low * 100) / 100, high: Math.round(affected * high * 100) / 100, affected};
}

export function planningTotals(items: readonly GapItem[], tokenCategories: readonly {remappedTokens: number}[], input: Partial<Assumptions> = {}): GapScanTotals {
  const assumptions = AssumptionsSchema.parse(input), excluded = new Set(assumptions.excluded);
  // With an application scan, components nobody uses are not required work.
  const unused = items.filter(item => item.decision !== 'optional' && item.usage && item.usage.usages === 0 && !excluded.has(item.id));
  const required = items.filter(item => item.decision !== 'optional' && !excluded.has(item.id) && !(item.usage && item.usage.usages === 0));
  const ranges = required.map(item => ({item, range: editedRange(item.effort, assumptions.edited[item.id])}));
  const known = ranges.filter((entry): entry is {item: GapItem; range: {low: number; high: number}} => entry.range !== null);
  const tokenRanges = tokenCategories.map(category => tokenCategoryRange(category.remappedTokens));
  const multiplier = assumptions.apps * (1 + assumptions.qaPct / 100);
  const consumers = required.flatMap(item => item.effort.level === null && item.decision !== 'replace' ? [] : [consumerRange(item)].filter((r): r is NonNullable<typeof r> => r !== null));
  const scanned = items.some(item => item.usage);
  const consumer = scanned ? {low: round2(consumers.reduce((s, r) => s + r.low, 0)), high: round2(consumers.reduce((s, r) => s + r.high, 0)), usages: required.reduce((s, i) => s + (i.usage?.usages ?? 0), 0), unusedExcluded: unused.length} : null;
  const low = ([...known.map(k => k.range), ...tokenRanges].reduce((sum, r) => sum + r.low, 0) + (consumer?.low ?? 0)) * multiplier;
  const high = ([...known.map(k => k.range), ...tokenRanges].reduce((sum, r) => sum + r.high, 0) + (consumer?.high ?? 0)) * multiplier;
  const weekly = assumptions.engineers * RUBRIC.productiveHours;
  // Hours-weighted mean so one level-5 rebuild is not hidden by many token swaps.
  const weighted = known.filter(k => k.item.effort.level !== null), weight = weighted.reduce((sum, k) => sum + (k.range.low + k.range.high) / 2, 0);
  const complexity = weight > 0 ? round2(weighted.reduce((sum, k) => sum + (k.item.effort.level ?? 0) * (k.range.low + k.range.high) / 2, 0) / weight) : null;
  const levelCounts: Record<string, number> = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, not_estimated: 0};
  for (const {item} of ranges) levelCounts[item.effort.level ?? 'not_estimated'] = (levelCounts[item.effort.level ?? 'not_estimated'] ?? 0) + 1;
  return {
    available: known.length + tokenRanges.length > 0,
    low: round2(low), high: round2(high),
    costLow: round2(low * assumptions.rate), costHigh: round2(high * assumptions.rate),
    weeksLow: round2(low / weekly), weeksHigh: round2(high / weekly),
    complexity, levelCounts, notEstimatedCount: levelCounts.not_estimated ?? 0,
    quickWins: required.filter(item => item.quickWin).length, breakingChanges: required.filter(item => item.breaking).length,
    productiveHours: RUBRIC.productiveHours, consumer,
  };
}
