import test from 'node:test';
import assert from 'node:assert/strict';
import {isScreen, scanUsage} from '@gapscan/usage';
import type {ComponentObservation} from '@gapscan/schema';

const component = (canonical: string, rawNames: string[] = [canonical]): ComponentObservation => ({id: canonical, canonical, rawNames, category: 'Actions', tier: 'primary', variants: [], sizes: [], statesObserved: [], statesMissing: [], a11y: {focusVisible: null}, instances: 1, evidence: [], confidence: 0.8});
const system = [component('Button'), component('Chip'), component('btn', ['btn']), component('Text Field', ['TextField']), component('Unused')];

const files = [
  {path: 'src/components/ui/Button.tsx', content: 'export function Button(props) { return <button className="btn" {...props} /> }'},
  {path: 'src/app/settings/page.tsx', content: `import {Button as Btn, Chip} from '@/components/ui';
import TextField from '@acme/ui/TextField';
export default function Page() {
  return <form>
    <TextField label="Name" error />
    <Btn kind="primary" isBusy={saving} onClick={save}>Save</Btn>
    <Btn kind="ghost">Cancel</Btn>
    <Chip tone="success" removable />
    <div className="btn btn-primary btn-sm">Legacy</div>
  </form>;
}`},
  {path: 'src/app/home/page.tsx', content: `import {Button} from '@/components/ui';\nexport default () => <main><Button>Go</Button><Button/></main>;`},
  {path: 'public/legacy.html', content: '<a class="btn btn-ghost" href="/x">Old</a>\n<md-filled-button disabled>Hi</md-filled-button>'},
  {path: 'src/app/home/page.test.tsx', content: 'import {Button} from "x"; <Button/>'},
  {path: 'node_modules/lib/index.js', content: 'import {Button} from "x"; <Button/>'},
  {path: 'README.md', content: '<Button/>'},
];

test('counts JSX usages through import aliases, with the props each one passes', () => {
  const scan = scanUsage(files, system), by = (name: string) => scan.components.find(c => c.component === name)!;
  assert.equal(by('Button').usages, 4, 'two aliased Btn and two Button');
  assert.deepEqual(by('Button').propUsages, {kind: 2, isBusy: 1, onClick: 1});
  assert.deepEqual(by('Button').imports, ['@/components/ui']);
  assert.equal(by('Text Field').usages, 1);
  assert.deepEqual(by('Text Field').propUsages, {label: 1, error: 1});
  assert.equal(by('Chip').propUsages.tone, 1);
  assert.equal(by('Unused').usages, 0);
});

test('counts class-name usages in JSX and HTML, recording modifier classes', () => {
  const btn = scanUsage(files, system).components.find(c => c.component === 'btn')!;
  assert.equal(btn.usages, 3, 'the wrapper component, the legacy div and the HTML link');
  assert.deepEqual(btn.propUsages, {'class:primary': 1, 'class:sm': 1, 'class:ghost': 1});
});

test('tests, dependencies and docs are skipped; screens are recognised by route conventions', () => {
  const scan = scanUsage(files, system);
  assert.equal(scan.filesScanned, 4);
  assert.equal(scan.filesSkipped, 3);
  assert.equal(scan.screens, 3, 'two app pages and one HTML page');
  assert.deepEqual(scan.components.find(c => c.component === 'Button')!.screens.sort(), ['src/app/home/page.tsx', 'src/app/settings/page.tsx']);
  for (const [path, expected] of [['src/pages/Checkout.tsx', true], ['app/routes/orders.$id.tsx', true], ['src/components/Card.tsx', false], ['src/app/components/Nav.tsx', false], ['src/SettingsScreen.tsx', true]] as const)
    assert.equal(isScreen(path), expected, path);
});

test('a broken file is skipped rather than failing the scan', () => {
  const scan = scanUsage([{path: 'src/a.tsx', content: 'export const x = <Button kind="a" />;'}, {path: 'src/b.tsx', content: 'import {Button} from "x"; const y = <<<'}], system);
  assert.equal(scan.filesScanned, 2);
});
