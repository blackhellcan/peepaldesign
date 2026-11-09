import test from 'node:test';
import assert from 'node:assert/strict';
import {codeAdapter, cssDeclarations} from '@gapscan/adapters';
import type {Observation} from '@gapscan/adapters';

const run = (name: string, text: string) => codeAdapter({assetId: 'a', name, uri: 'inline:' + name, bytes: Buffer.from(text)}, {signal: new AbortController().signal});
const of = <T extends Observation['type']>(list: Observation[], type: T) => list.filter((o): o is Extract<Observation, {type: T}> => o.type === type);

test('CSS declarations flatten nesting, media queries and comments with line numbers', () => {
  const decls = cssDeclarations(`/* brand */
:root { --brand: #0B5FD6; --radius-md: 8px }
.btn { color: #fff; background: var(--brand);
  &:hover { background: #004 }
  .icon { fill: currentColor } }
@media (min-width: 600px) { .card { padding: 16px 24px; } }
a[href="x{y}"] { color: red }`);
  assert.deepEqual(decls.map(d => [d.selector, d.property, d.value, d.line]), [
    [':root', '--brand', '#0B5FD6', 2], [':root', '--radius-md', '8px', 2],
    ['.btn', 'color', '#fff', 3], ['.btn', 'background', 'var(--brand)', 3],
    ['.btn:hover', 'background', '#004', 4], ['.btn .icon', 'fill', 'currentColor', 5],
    ['.card', 'padding', '16px 24px', 6], ['a[href="x{y}"]', 'color', 'red', 7],
  ]);
});

test('CSS and SCSS give declared tokens plus observed usage by property', async () => {
  const result = await run('acme.scss', `$space-2: 8px;
:root { --brand: #0B5FD6; --shadow-1: 0 1px 2px rgba(0,0,0,.1) }
.btn-primary { background-color: #0B5FD6; color: #FFFFFF; padding: 8px 16px; border-radius: 4px; font: 600 16px/24px "Inter", sans-serif }
.alert-error { border: 1px solid #D92D20; box-shadow: 0 2px 8px rgba(0,0,0,.15); margin: var(--x) }`);
  const tokens = of(result.observations, 'token');
  assert.deepEqual(tokens.map(t => [t.path, t.tokenType]), [['$space-2', 'dimension'], ['--brand', 'color'], ['--shadow-1', 'color']]);
  const colors = of(result.observations, 'color');
  assert.ok(colors.some(c => c.channel === 'observed_css' && c.selector === '.btn-primary' && c.property === 'background-color' && c.value === '#0B5FD6'));
  assert.ok(colors.some(c => c.selector === '.alert-error' && c.value === '#D92D20'));
  assert.deepEqual(of(result.observations, 'spacing').map(s => s.value), ['8px 16px'], 'var() values are not counted as spacing');
  assert.deepEqual(of(result.observations, 'radius').map(r => r.value), ['4px']);
  assert.ok(of(result.observations, 'font').some(f => f.size === '16px' && f.family.startsWith('"Inter"')));
  assert.equal(of(result.observations, 'shadow').length, 1);
});

test('DTCG and Style Dictionary token files become dotted token paths with aliases kept', async () => {
  const dtcg = await run('tokens.json', JSON.stringify({color: {$type: 'color', brand: {primary: {$value: '#0052CC', $description: 'Main brand'}}, action: {$value: '{color.brand.primary}'}}, space: {4: {$value: '16px', $type: 'dimension'}}}));
  const tokens = of(dtcg.observations, 'token');
  assert.deepEqual(tokens.map(t => [t.path, t.value, t.tokenType]), [['color.brand.primary', '#0052CC', 'color'], ['color.action', '{color.brand.primary}', 'color'], ['space.4', '16px', 'dimension']]);
  assert.equal(tokens[0]?.description, 'Main brand');
  assert.deepEqual(of(dtcg.observations, 'color').map(c => c.name), ['color.brand.primary'], 'aliases are not duplicated as colours');
  const sd = await run('sd.json', JSON.stringify({color: {base: {red: {value: '#D92D20', type: 'color'}}}}));
  assert.equal(of(sd.observations, 'token')[0]?.path, 'color.base.red');
  await assert.rejects(run('broken.json', '{nope'), /not valid JSON/);
});

test('class conventions group into components with variants, sizes and states', async () => {
  const {cssComponents} = await import('@gapscan/adapters');
  const bootstrap = cssComponents(`.btn{padding:6px} .btn-primary{background:#0d6efd} .btn-outline-secondary{color:#6c757d} .btn-sm{padding:4px} .btn-lg{padding:8px}
.btn:hover{} .btn:focus-visible{} .btn:disabled,.btn.disabled{} .card{} .card-body{} .card-header{}`);
  const btn = bootstrap.find(c => c.name === 'btn')!;
  assert.deepEqual(btn.variants.sort(), ['outline-secondary', 'primary']);
  assert.deepEqual(btn.sizes.sort(), ['lg', 'sm']);
  assert.deepEqual(btn.states.sort(), ['disabled', 'focus-visible', 'hover']);
  const polaris = cssComponents(`.Polaris-Button{} .Polaris-Button--variantPrimary{} .Polaris-Button--variantPlain{} .Polaris-Button--toneCritical{} .Polaris-Button--sizeSlim{} .Polaris-Button--disabled{} .Polaris-Button__Icon{} .Polaris-Button:focus-visible{}`, {prefix: 'Polaris-'});
  const button = polaris.find(c => c.name === 'Button')!;
  assert.deepEqual(button.variants.sort(), ['plain', 'primary', 'tone=critical']);
  assert.deepEqual(button.sizes, ['slim']);
  assert.deepEqual(button.states.sort(), ['disabled', 'focus-visible']);
  assert.ok(!polaris.some(c => /Icon/.test(c.name)), 'BEM elements are not components');
  const carbon = cssComponents(`.cds--btn{} .cds--btn--primary{} .cds--btn--danger{} .cds--btn--sm{} .cds--btn:focus{} .cds--btn--disabled{} .unrelated{}`, {prefix: 'cds--'});
  assert.deepEqual(carbon.map(c => c.name), ['btn']);
  assert.deepEqual(carbon[0]!.variants.sort(), ['danger', 'primary']);
});

test('chained is-/has- modifier classes count as variants of the first class', async () => {
  const {cssComponents} = await import('@gapscan/adapters');
  const [button] = cssComponents('.button{} .button.is-primary{} .button.is-danger{} .button.is-small{} .button.is-loading{} .button:hover{}');
  assert.deepEqual(button?.variants.sort(), ['danger', 'primary']);
  assert.deepEqual(button?.sizes, ['small']);
  assert.deepEqual(button?.states.sort(), ['hover', 'loading']);
});

test('inferred specimens apply the real rules to generated markup for each modifier', async () => {
  const {inferredSpecimen} = await import('@gapscan/adapters');
  const css = '.btn{padding:8px} .btn-primary{background:#0B5FD6} .btn-sm{padding:4px} .btn:hover{opacity:.9} .card{padding:24px} .btnx{color:red}';
  const specimen = inferredSpecimen(css, 'btn')!;
  assert.match(specimen.css, /\.btn\{padding:8px\}/);
  assert.match(specimen.css, /\.btn:hover/);
  assert.doesNotMatch(specimen.css, /card|btnx/, 'only this component’s rules');
  assert.match(specimen.html, /<button class="btn">btn<\/button>/);
  assert.match(specimen.html, /<button class="btn btn-primary">/);
  assert.equal(inferredSpecimen(css, 'missing'), null);
});

test('font size and family set by the same rule travel together', async () => {
  const result = await run('a.css', 'body { font-family: Inter, sans-serif; font-size: 16px }');
  assert.ok(of(result.observations, 'font').some(f => f.size === '16px' && f.family.startsWith('Inter')));
});
