import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPlan, buildScript, dryRun, transformFile} from '@gapscan/codemod';
import {diffComponents} from '@gapscan/gapscan';
import {codemodBinding, loadReference} from '@gapscan/library';
import {scanUsage} from '@gapscan/usage';
import type {ComponentObservation, ExtractedDesignSystem, GapItem, GapScanReport, ReferenceDS} from '@gapscan/schema';

const component = (canonical: string, rawNames: string[], extra: Partial<ComponentObservation> = {}): ComponentObservation => ({
  id: `cmp:${canonical}`, canonical, rawNames, category: 'Actions', tier: 'primary', variants: [], sizes: [], statesObserved: [], statesMissing: [],
  a11y: {focusVisible: null}, instances: 1, evidence: [], confidence: 0.8, ...extra});
const variants = (...names: string[]) => names.map(name => ({name, tokenRefs: {}}));

// A React library: <Button kind="primary" isBusy>, <Chip removable>, <TextField>.
const button = component('Button', ['Button'], {variants: variants('kind=primary', 'kind=danger', 'kind=ghost'), sizes: ['sm'],
  props: [{name: 'kind', type: 'string', values: ['primary', 'danger', 'ghost']}, {name: 'size', type: 'string', values: ['sm']}, {name: 'isBusy', type: 'boolean'}, {name: 'onClick', type: 'function'}, {name: 'tooltipText', type: 'string'}]});
const chip = component('Chip', ['Chip'], {props: [{name: 'removable', type: 'boolean'}, {name: 'label', type: 'string'}]});
const field = component('Text Field', ['TextField'], {category: 'Forms', props: [{name: 'label', type: 'string'}]});
const css = component('button', ['button'], {variants: variants('primary', 'ghost', 'weird'), sizes: ['sm']});

function report(source: ComponentObservation[], reference: ReferenceDS, pairs: Record<string, [string, 'confirmed' | 'suggested']>): GapScanReport {
  const items = source.map(c => {
    const [targetName, status] = pairs[c.canonical] ?? [null, 'confirmed'];
    const target = reference.components.find(t => t.canonical === targetName || t.rawNames.includes(targetName!)) ?? null;
    return {id: `gap:${c.id}`, name: c.canonical, category: c.category, decision: target ? 'update' : 'replace', diffs: target ? diffComponents(c, target) : [],
      match: {sourceId: c.id, targetId: target?.id ?? null, score: 90, status, reasons: []}} as unknown as GapItem;
  });
  return {id: 'r1', edsId: 'e1', edsFingerprint: 'f', reference: {id: reference.id, version: reference.libraryVersion}, items} as unknown as GapScanReport;
}
const eds = (components: ComponentObservation[]) => ({components}) as unknown as ExtractedDesignSystem;

const page = `import {Button as Btn, Chip, Card} from '@/components/ui';
import TextField from '@acme/ui/TextField';
import styled from 'styled';

const Fancy = styled(Btn)\`margin: 0\`;
export default function Page({k, rest}) {
  return <Card>
    <TextField label="Name" />
    <Btn kind="primary" isBusy={saving} onClick={save}>Save</Btn>
    <Btn kind="ghost" size="sm">Cancel</Btn>
    <Btn kind="danger">Delete</Btn>
    <Btn kind={k}>Dynamic</Btn>
    <Btn {...rest}>Spread</Btn>
    <Btn tooltipText="Hi">Tip</Btn>
    <Chip removable label="Tag" />
  </Card>;
}
`;

async function muiPlan() {
  const mui = (await loadReference('mui-6.4.7'))!;
  const source = [button, chip, field];
  const usage = {id: 'u', projectId: 'p', createdAt: new Date().toISOString(), sources: [], ...scanUsage([{path: 'src/app/page.tsx', content: page}], source)};
  return buildPlan({report: report(source, mui, {Button: ['Button', 'confirmed'], Chip: ['Chip', 'confirmed'], 'Text Field': ['TextField', 'confirmed']}), source: eds(source), reference: mui, usage, binding: codemodBinding('mui-6.4.7')});
}

test('rules come from the report: prop renames, option values and the reference package', async () => {
  const plan = await muiPlan(), btn = plan.rules.components.find(c => c.component === 'Button')!.jsx!;
  assert.equal(btn.package, '@mui/material');
  assert.equal(btn.exportName, 'Button');
  assert.deepEqual(btn.modules, ['@/components/ui']);
  assert.deepEqual(btn.props, {isBusy: 'loading'});
  assert.deepEqual(btn.manualProps, ['tooltipText']);
  const option = (value: string) => btn.options.find(o => o.prop === 'kind' && o.value === value);
  assert.deepEqual([option('primary')?.toProp, option('primary')?.toValue], ['color', 'primary'], 'the same pairing GapScan’s diff uses');
  assert.deepEqual([option('danger')?.toProp, option('danger')?.toValue], ['color', 'error']);
  assert.deepEqual([option('ghost')?.toProp, option('ghost')?.toValue], ['variant', 'text']);
  assert.match(plan.hash, /^[0-9a-f]{16}$/);
});

test('imports are re-pointed, props and values renamed, and unsafe call sites flagged instead of changed', async () => {
  const {rules} = await muiPlan();
  const result = transformFile('src/app/page.tsx', page, rules);
  assert.match(result.output, /^import \{Card\} from '@\/components\/ui';\nimport \{Button as Btn, Chip\} from '@mui\/material';\nimport \{TextField\} from '@mui\/material';/);
  assert.match(result.output, /<Btn color="primary" loading=\{saving\} onClick=\{save\}>Save<\/Btn>/);
  assert.match(result.output, /<Btn variant="text" size="small">Cancel<\/Btn>/);
  assert.match(result.output, /<Btn color="error">Delete<\/Btn>/);
  assert.match(result.output, /<Chip removable label="Tag" \/>/, 'MUI’s Chip declares no counterpart for `removable`, so it is flagged');
  assert.match(result.output, /<Btn kind=\{k\}>Dynamic/, 'computed values are left alone');
  const reasons = result.manual.map(m => `${m.line} ${m.reason}`);
  assert.ok(reasons.some(r => /^12 “kind” is computed; map its values by hand \(primary → color=primary/.test(r)), reasons.join('\n'));
  assert.ok(reasons.some(r => /^13 Spread props/.test(r)));
  assert.ok(reasons.some(r => /^14 Prop “tooltipText” has no equivalent/.test(r)));
  assert.ok(reasons.some(r => /^5 Btn is used outside JSX \(styled\(Btn\)\)/.test(r)));
  assert.ok(reasons.some(r => /^15 Prop “removable” has no equivalent in Chip/.test(r)));
  assert.equal(result.manual.length, 5);
  assert.ok(result.output.includes('<Btn tooltipText="Hi">'), 'a flagged element is not partly edited');
});

test('a value the target prop does not accept is flagged, not passed through', async () => {
  const antd = (await loadReference('antd-5.24.2'))!, source = [button];
  const app = `import {Button} from '@/components/ui';\nexport const a = <Button type="submit" kind="primary">Go</Button>;`;
  const usage = {id: 'u', projectId: 'p', createdAt: new Date().toISOString(), sources: [], ...scanUsage([{path: 'a.tsx', content: app}], source)};
  const plan = buildPlan({report: report(source, antd, {Button: ['Button', 'confirmed']}), source: eds(source), reference: antd, usage, binding: codemodBinding('antd-5.24.2')});
  const result = transformFile('a.tsx', app, plan.rules);
  assert.ok(result.output.includes('<Button type="submit" kind="primary">'));
  assert.match(result.manual[0]!.reason, /^type="submit" means something else in Button, which expects .*primary/);
});

test('new imports follow the file’s brace spacing', async () => {
  const {rules} = await muiPlan();
  assert.match(transformFile('a.tsx', `import { Chip } from '@/components/ui';\n<Chip />;`, rules).output, /^import \{ Chip \} from '@mui\/material';/);
});

test('a value two props would both claim is flagged rather than producing a duplicate prop', async () => {
  const {rules} = await muiPlan();
  const result = transformFile('a.tsx', `import {Button} from '@/components/ui';\nexport const x = <Button kind="danger" color="primary" />;`, rules);
  assert.ok(result.output.includes('kind="danger" color="primary"'));
  assert.match(result.manual[0]!.reason, /would become “color”, which is already set|Both/);
});

test('class names map to the reference’s classes; unmapped modifiers and built strings are flagged', async () => {
  const bootstrap = (await loadReference('bootstrap-5.3.3'))!;
  const plan = buildPlan({report: report([css], bootstrap, {button: ['Button', 'confirmed']}), source: eds([css]), reference: bootstrap, usage: null, binding: codemodBinding('bootstrap-5.3.3')});
  const rule = plan.rules.components[0]!.classes!;
  assert.equal(rule.map['button'], 'btn');
  assert.equal(rule.map['button-primary'], 'btn-primary');
  assert.equal(rule.map['button-ghost'], 'btn-link');
  assert.equal(rule.map['button-sm'], 'btn-sm');
  assert.equal(rule.map['button-weird'], undefined);
  const html = transformFile('index.html', '<a class="button button-primary button-sm" href="#">Go</a>\n<b class="button-weird">?</b>', plan.rules);
  assert.equal(html.output.split('\n')[0], '<a class="btn btn-primary btn-sm" href="#">Go</a>');
  assert.deepEqual(html.manual.map(m => [m.line, m.reason]), [[2, 'Class “button-weird” has no equivalent in Button']]);
  const jsx = transformFile('a.jsx', 'const a = <i className={clsx("button", {"button-ghost": x})} />;\nconst b = <i className={`button button-${kind}`} />;', plan.rules);
  assert.match(jsx.output, /clsx\("btn", \{"btn-link": x\}\)/);
  assert.equal(jsx.manual[0]?.line, 2);
  const bulma = (await loadReference('bulma-1.0.2'))!;
  const chained = buildPlan({report: report([css], bulma, {button: ['Button', 'confirmed']}), source: eds([css]), reference: bulma, usage: null, binding: codemodBinding('bulma-1.0.2')});
  assert.equal(transformFile('x.html', '<a class="button button-primary button-sm">', chained.rules).output, '<a class="button is-primary is-small">');
});

test('only confirmed matches are rewritten; the rest are listed', async () => {
  const mui = (await loadReference('mui-6.4.7'))!, source = [button, chip];
  const usage = {id: 'u', projectId: 'p', createdAt: new Date().toISOString(), sources: [], ...scanUsage([{path: 'src/app/page.tsx', content: page}], source)};
  const plan = buildPlan({report: report(source, mui, {Button: ['Button', 'suggested']}), source: eds(source), reference: mui, usage, binding: codemodBinding('mui-6.4.7')});
  assert.deepEqual(plan.rules.components, []);
  assert.ok(plan.notes.some(n => /Button → Button is a suggested match; approve it to include its \d+ uses/.test(n)));
  assert.ok(plan.notes.some(n => /Chip \(1 uses\) has no counterpart/.test(n)));
  const web = (await loadReference('material-web-2.3.0'))!;
  const toWeb = buildPlan({report: report([button], web, {Button: ['Button', 'confirmed']}), source: eds([button]), reference: web, usage, binding: codemodBinding('material-web-2.3.0')});
  assert.deepEqual(toWeb.rules.components, []);
  assert.ok(toWeb.notes.some(n => /not published as an importable/.test(n)), 'web components are not guessed at');
});

test('the dry run reports per-file diffs, and the downloaded script makes the same changes', async () => {
  const plan = await muiPlan();
  const files = [{path: 'src/app/page.tsx', content: page}, {path: 'src/app/page.test.tsx', content: `import {Chip} from '@/components/ui';\n<Chip removable />;\n`}, {path: 'README.md', content: '<Btn kind="primary" />'}];
  const run = dryRun(files, plan.rules);
  assert.equal(run.totals.filesRead, 2, 'tests are migrated too; docs are not code');
  assert.equal(run.totals.filesChanged, 2);
  assert.match(run.files[0]!.diff, /^--- a\/src\/app\/page.test.tsx\n\+\+\+ b\/src\/app\/page.test.tsx\n@@ -1,3 \+1,3 @@\n-import \{Chip\} from '@\/components\/ui';\n\+import \{Chip\} from '@mui\/material';\n <Chip removable \/>;/);
  assert.equal(run.files[0]!.manual[0]!.line, 2);

  const script = await buildScript(plan, {reportId: 'r1', library: 'MUI', version: '6.4.7', generatedAt: '2026-11-03T00:00:00Z'});
  assert.doesNotMatch(script, /: string\b|import ts from/, 'types and the typescript import are stripped');
  const dir = mkdtempSync(join(tmpdir(), 'codemod-'));
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(join(import.meta.dirname, '../../../node_modules/typescript'), join(dir, 'node_modules/typescript'));
  writeFileSync(join(dir, 'package.json'), '{}');
  for (const f of files) { mkdirSync(join(dir, f.path, '..'), {recursive: true}); writeFileSync(join(dir, f.path), f.content); }
  writeFileSync(join(dir, 'gapscan-codemod.mjs'), script);
  const dry = execFileSync(process.execPath, ['gapscan-codemod.mjs', 'src'], {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  assert.equal(dry, run.files.map(f => f.diff).join(''), 'the script prints exactly the dry-run diff');
  assert.equal(readFileSync(join(dir, files[0]!.path), 'utf8'), page, 'nothing is written without --write');
  execFileSync(process.execPath, ['gapscan-codemod.mjs', 'src', '--write'], {cwd: dir, stdio: 'ignore'});
  assert.equal(readFileSync(join(dir, files[0]!.path), 'utf8'), transformFile(files[0]!.path, page, plan.rules).output);
});
