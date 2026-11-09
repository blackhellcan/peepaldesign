// Ported from the prototype's tests/taxonomy.test.mjs, plus a parity check that
// the TypeScript port classifies exactly like the original module.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {CATEGORY_TAXONOMY, ITEM_RANKS, TIERS, assertCollectionCoverage, classifyItem, collectMasterList} from '@gapscan/taxonomy';

const item = (name: string, kind = 'component', source = 'Pasted code') => ({id: name, name, kind, evidence: [{source, line: 1, snippet: name}]});

test('visits every tier, category, and rank in fixed order', () => {
  const master = CATEGORY_TAXONOMY.filter(c => c.category !== 'Miscellaneous')
    .flatMap(c => ITEM_RANKS.filter(r => c.ranks[r].length).map(r => item(c.ranks[r][0]!))).reverse();
  master.push(item('UnmappedQuantumWidget'));
  const r = collectMasterList([{system: 'old', items: master}]);
  assert.equal(r.items.length, master.length);
  const order = (i: (typeof r.items)[number]) => TIERS.indexOf(i.tier) * 100 + CATEGORY_TAXONOMY.findIndex(c => c.category === i.category) * 3 + ITEM_RANKS.indexOf(i.rank);
  assert.deepEqual(r.items.map(order), r.items.map(order).sort((a, b) => a - b));
  assert.equal(r.coverage.verified, true);
  assert.equal(r.items.at(-1)?.category, 'Miscellaneous');
});

test('preserves repeated IDs across and inside systems as separate occurrences', () => {
  const r = collectMasterList([{system: 'A', items: [item('Button'), item('Button')]}, {system: 'B', items: [item('Button')]}]);
  assert.equal(r.items.length, 3);
  assert.equal(new Set(r.items.map(i => i.collectionId)).size, 3);
  assert.equal(r.counts.perSystem.A?.total, 2);
  assert.equal(r.counts.perSystem.B?.total, 1);
  assert.ok(r.items.every(i => i.source[0] === 'Pasted code'));
});

test('specific compound names select the right rank instead of a broad button match', () => {
  assert.equal(classifyItem(item('IconButton')).rank, 'secondary_items');
  assert.equal(classifyItem(item('SplitButton')).rank, 'other_items');
  assert.equal(classifyItem(item('Button')).rank, 'primary_items');
  assert.equal(classifyItem(item('Checkboxes')).category, 'Forms and input');
  assert.equal(classifyItem(item('Card')).category, 'Data display');
  assert.equal(classifyItem(item('Modal')).category, 'Overlays');
});

test('resolves grid and icon ambiguity by primary job', () => {
  assert.equal(classifyItem(item('Grid')).category, 'Layout and structure');
  assert.equal(classifyItem(item('grid', 'token')).category, 'Foundations and tokens');
  assert.equal(classifyItem(item('Icon')).category, 'Media and identity');
  assert.equal(classifyItem(item('icon-size', 'token')).category, 'Foundations and tokens');
  assert.equal(classifyItem(item('Drawer')).category, 'Overlays');
  assert.equal(classifyItem(item('NavDrawer')).category, 'Navigation');
});

test('coverage fails on count mismatch, duplicates, or foreign occurrences', () => {
  const master = [{collectionId: 'A:0'}, {collectionId: 'A:1'}];
  assert.throws(() => assertCollectionCoverage(master, [master[0]!]), /coverage failed/);
  assert.throws(() => assertCollectionCoverage(master, [master[0]!, master[0]!]), /coverage failed/);
  assert.throws(() => assertCollectionCoverage(master, [master[0]!, {collectionId: 'B:0'}]), /coverage failed/);
});

const legacyPath = new URL('../../../../gapscan/engine/taxonomy.mjs', import.meta.url);
test('classifies the prototype’s vocabulary exactly like the prototype module', {skip: !existsSync(legacyPath) && 'prototype checkout not present'}, async () => {
  const legacy = await import(legacyPath.href) as {classifyItem: typeof classifyItem; CATEGORY_TAXONOMY: typeof CATEGORY_TAXONOMY};
  // The prototype's own vocabulary: aliases added since (combobox, accordion, chip…) are new behaviour, not drift.
  const names = [...new Set(legacy.CATEGORY_TAXONOMY.flatMap(c => ITEM_RANKS.flatMap(r => c.ranks[r])))]
    .flatMap(alias => [alias, alias.replace(/ (\w)/g, (_, c: string) => c.toUpperCase()), 'Mui' + alias.replace(/^\w/, c => c.toUpperCase())]);
  const extras = [item('m-2'), item('legacy.test.js', 'component', 'src/legacy.test.js'), {name: 'Widget', html: '<nav role="navigation"></nav>'}, {name: 'Thing', taxonomyHint: 'Overlays'}, {name: 'Deprecated Button'}];
  for (const subject of [...names.map(n => item(n)), ...names.map(n => item(n, 'token')), ...extras])
    assert.deepEqual(classifyItem(subject), legacy.classifyItem(subject), subject.name);
});

test('common component types from current libraries have a home', () => {
  const cases: [string, string, string][] = [['Combobox', 'Forms and input', 'combobox'], ['SearchBox', 'Forms and input', 'search box'], ['TabList', 'Navigation', 'tab list'],
    ['DataGrid', 'Data display', 'data grid'], ['Chip', 'Data display', 'chip'], ['Tag', 'Data display', 'tag'], ['MessageBar', 'Feedback and status', 'message bar'],
    ['Accordion', 'Layout and structure', 'accordion'], ['Toolbar', 'Actions', 'toolbar'], ['Persona', 'Media and identity', 'persona'], ['Notification', 'Feedback and status', 'notification']];
  for (const [name, category, alias] of cases) assert.deepEqual([classifyItem({name}).category, classifyItem({name}).matchedBy], [category, alias], name);
});
