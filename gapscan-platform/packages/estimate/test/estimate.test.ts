import test from 'node:test';
import assert from 'node:assert/strict';
import type {EffortDriver, GapItem} from '@gapscan/schema';
import {RUBRIC, NOT_ESTIMATED, applyEstimates, editedRange, estimateItem, levelForDiffs, planningTotals, tokenCategoryRange, variantFactor} from '@gapscan/estimate';

const diff = (driver: EffortDriver) => ({dimension: 'visual' as const, summary: driver, driver});
function item(id: string, drivers: EffortDriver[], overrides: Partial<GapItem> = {}): GapItem {
  const base: GapItem = {
    id, name: id, category: 'Actions', decision: 'update',
    match: {sourceId: id, targetId: 't-' + id, score: 90, status: 'confirmed', reasons: []},
    diffs: drivers.map(diff), variantsInScope: 1, inferredShare: 0, instances: 0,
    effort: {level: null, label: '', drivers: [], low: null, high: null, basis: ''},
    quickWin: false, breaking: false, acceptance: [],
  };
  return {...base, ...overrides};
}

test('driver points and floors map onto the 1–5 rubric', () => {
  assert.equal(levelForDiffs([diff('token_value')]), 1);
  assert.equal(levelForDiffs([diff('a11y_fix')]), 2);
  assert.equal(levelForDiffs([diff('prop_semantic')]), 3);
  assert.equal(levelForDiffs([diff('anatomy_change')]), 4);
  assert.equal(levelForDiffs([diff('no_counterpart')]), 5);
  assert.equal(levelForDiffs([diff('state_missing'), diff('state_missing'), diff('a11y_fix'), diff('prop_rename')]), 4, '2+2+2+2 = 8 points reaches the Hard band');
  assert.equal(levelForDiffs(Array(6).fill(diff('variant_renamed'))), 2, 'variant renames are capped at 3 points');
});

test('a confirmed unchanged item still carries verification time', () => {
  const effort = estimateItem(item('card', [], {decision: 'keep'}));
  assert.equal(effort.level, 1);
  assert.deepEqual([effort.low, effort.high], [...RUBRIC.base[1]]);
});

test('unresolved matches and unapproved replacements are never priced', () => {
  assert.equal(estimateItem(item('a', ['token_value'], {match: {sourceId: 'a', targetId: null, score: 10, status: 'unresolved', reasons: []}})).low, null);
  assert.equal(estimateItem(item('b', [], {decision: 'check_first'})).label, NOT_ESTIMATED);
  const unapproved = estimateItem(item('c', [], {decision: 'replace', match: {sourceId: 'c', targetId: null, score: 0, status: 'suggested', reasons: []}}));
  assert.equal(unapproved.level, null);
  const approved = estimateItem(item('d', [], {decision: 'replace', match: {sourceId: 'd', targetId: null, score: 0, status: 'suggested', reasons: [], approvedBy: 'pm@example.com'}}));
  assert.equal(approved.level, 5);
  assert.ok(approved.drivers.includes('no_counterpart'));
});

test('variant count and inferred evidence widen the range as documented', () => {
  assert.equal(variantFactor(1), 1);
  assert.equal(variantFactor(5), 1.6);
  assert.equal(variantFactor(50), RUBRIC.variant.cap);
  const effort = estimateItem(item('btn', ['prop_semantic'], {variantsInScope: 5, inferredShare: 1}));
  assert.equal(effort.low, 10, '6h × 1.6 rounded up to half hours');
  assert.equal(effort.high, 29, '12h × 1.6 × 1.5 rounded up to half hours');
});

test('totals follow the Part 2 formulas and exclude optional, excluded and unestimated work', () => {
  const items = applyEstimates([
    item('btn', ['a11y_fix']),                                                   // 2–4
    item('table', ['anatomy_change']),                                           // 16–32
    item('tooltip', [], {decision: 'check_first'}),                               // not estimated
    item('badge', ['token_value'], {decision: 'optional'}),                       // optional: excluded
    item('chip', ['token_value']),                                                // 0.5–1.5, excluded below
  ]);
  const totals = planningTotals(items, [{remappedTokens: 10}], {apps: 2, qaPct: 50, rate: 100, engineers: 1, excluded: ['chip']});
  const tokens = tokenCategoryRange(10);                                          // 3–4.5
  assert.equal(totals.low, (2 + 16 + tokens.low) * 2 * 1.5);
  assert.equal(totals.high, (4 + 32 + tokens.high) * 2 * 1.5);
  assert.equal(totals.costLow, totals.low * 100);
  assert.equal(totals.weeksLow, Math.round(totals.low / RUBRIC.productiveHours * 100) / 100);
  assert.equal(totals.notEstimatedCount, 1);
  assert.equal(totals.levelCounts[4], 1);
  assert.equal(totals.quickWins, 1, 'the accessibility fix at level 2 is a quick win');
  assert.equal(totals.breakingChanges, 1, 'the level-4 anatomy change is breaking');
  assert.equal(totals.complexity, Math.round((2 * 3 + 4 * 24) / (3 + 24) * 100) / 100);
});

test('manual edits keep the item spread and flow into totals', () => {
  const [btn] = applyEstimates([item('btn', ['a11y_fix'])]);
  assert.ok(btn);
  assert.deepEqual(editedRange(btn.effort, 3), {low: 3, high: 6});
  assert.equal(planningTotals([btn], [], {qaPct: 0, edited: {btn: 3}}).low, 3);
});

test('totals rise monotonically with applications, QA allowance and rate', () => {
  const items = applyEstimates([item('btn', ['prop_rename'])]);
  const a = planningTotals(items, [], {apps: 1, qaPct: 0, rate: 50}), b = planningTotals(items, [], {apps: 3, qaPct: 20, rate: 90});
  assert.ok(b.low > a.low && b.high > a.high && b.costLow > a.costLow);
});

test('nothing estimable reads as unavailable rather than a $0 quote', () => {
  const totals = planningTotals(applyEstimates([item('x', [], {decision: 'check_first'})]), []);
  assert.equal(totals.available, false);
  assert.equal(totals.complexity, null);
});

test('application usage adds consumer hours, prices prop renames by the usages that pass them, and drops unused components', async () => {
  const {consumerRange} = await import('@gapscan/estimate');
  const usage = (usages: number, propUsages: Record<string, number> = {}) => ({usages, files: 3, screens: 2, propUsages});
  const rename = {dimension: 'api' as const, summary: 'kind → variant', driver: 'prop_rename' as const, before: 'kind', after: 'variant'};
  const renamed = item('btn', [], {diffs: [rename], usage: usage(200, {kind: 40})});
  assert.deepEqual(consumerRange(renamed), {low: 2, high: 6, affected: 40}, 'only the 40 usages that pass `kind`, at codemod rates');
  const semantic = item('table', ['anatomy_change'], {usage: usage(10)});
  assert.deepEqual(consumerRange(semantic), {low: 2.5, high: 5, affected: 10});
  assert.equal(consumerRange(item('card', [], {decision: 'keep', usage: usage(50)})), null, 'kept components need no call-site changes');
  const items = applyEstimates([renamed, semantic, item('ghost', ['token_value'], {usage: usage(0)})]);
  const totals = planningTotals(items, [], {qaPct: 0});
  assert.deepEqual(totals.consumer, {low: 4.5, high: 11, usages: 210, unusedExcluded: 1});
  const withoutUsage = planningTotals(applyEstimates([item('btn', [], {diffs: [rename]})]), [], {qaPct: 0});
  assert.equal(withoutUsage.consumer, null, 'no scan, no consumer estimate and no exclusions');
});
