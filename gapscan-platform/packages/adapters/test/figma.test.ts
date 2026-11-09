import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaAdapter, figmaFileKey} from '@gapscan/adapters';
import type {Observation} from '@gapscan/adapters';

const KEY = 'AbCdEf1234567890';
const of = <T extends Observation['type']>(list: Observation[], type: T) => list.filter((o): o is Extract<Observation, {type: T}> => o.type === type);
const blue = {r: 0, g: 82 / 255, b: 204 / 255, a: 1};

const FILE = {
  name: 'Acme UI',
  styles: {'S:fill1': {name: 'Brand/Primary', styleType: 'FILL'}, 'S:text1': {name: 'Body/Medium', styleType: 'TEXT'}},
  document: {id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{id: '1:1', name: 'Components', type: 'CANVAS', children: [
    {id: '2:1', name: 'Button', type: 'COMPONENT_SET',
      componentPropertyDefinitions: {
        Variant: {type: 'VARIANT', variantOptions: ['Primary', 'Secondary', 'Ghost']},
        Size: {type: 'VARIANT', variantOptions: ['Small', 'Medium', 'Large']},
        State: {type: 'VARIANT', variantOptions: ['Default', 'Hover', 'Focus', 'Disabled']},
        'Label#12:0': {type: 'TEXT', defaultValue: 'Save'},
      },
      children: [{id: '2:2', name: 'Variant=Primary, Size=Medium, State=Default', type: 'COMPONENT', cornerRadius: 8, itemSpacing: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12,
        fills: [{type: 'SOLID', color: blue}], styles: {fill: 'S:fill1'},
        effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.2}, offset: {x: 0, y: 2}, radius: 4}],
        children: [{id: '2:3', name: 'Label', type: 'TEXT', style: {fontFamily: 'Inter', fontSize: 16, fontWeight: 600, lineHeightPx: 24}, styles: {text: 'S:text1'}, fills: [{type: 'SOLID', color: {r: 1, g: 1, b: 1}}]}]}]},
    {id: '3:1', name: 'Promo', type: 'FRAME', fills: [{type: 'SOLID', color: {r: 0.0431, g: 0.3725, b: 0.8392}}]},
  ]}]},
};
const VARIABLES = {meta: {
  variableCollections: {'C:1': {name: 'Color', defaultModeId: 'm1', modes: [{modeId: 'm1', name: 'Light'}, {modeId: 'm2', name: 'Dark'}]}},
  variables: {
    'V:1': {name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'C:1', valuesByMode: {m1: blue, m2: {r: 0.3, g: 0.55, b: 1, a: 1}}},
    'V:2': {name: 'color/action/background', resolvedType: 'COLOR', variableCollectionId: 'C:1', valuesByMode: {m1: {type: 'VARIABLE_ALIAS', id: 'V:1'}, m2: {type: 'VARIABLE_ALIAS', id: 'V:1'}}},
    'V:3': {name: 'space/4', resolvedType: 'FLOAT', variableCollectionId: 'C:1', valuesByMode: {m1: 16, m2: 16}},
  },
}};

function fakeFetch(variablesStatus = 200): {fetch: typeof fetch; calls: {url: string; token: string | null}[]} {
  const calls: {url: string; token: string | null}[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url), token = new Headers(init?.headers).get('x-figma-token');
    calls.push({url: href, token});
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
    if (href === `https://api.figma.com/v1/files/${KEY}`) return json(200, FILE);
    if (href === `https://api.figma.com/v1/files/${KEY}/variables/local`) return variablesStatus === 200 ? json(200, VARIABLES) : json(variablesStatus, {err: 'Forbidden'});
    if (href.includes('/files/SCOPEKEY123456')) return json(403, {status: 403, err: 'Invalid scope(s): file_comments:read. This endpoint requires the file_content:read scope'});
    if (href.includes('/files/EXPIREDKEY1234')) return json(403, {status: 403, err: 'Invalid token'});
    return json(404, {err: 'Not found'});
  }) as typeof fetch;
  return {fetch: fetchImpl, calls};
}
const input = {assetId: 'f1', name: 'Acme UI', uri: `https://www.figma.com/design/${KEY}/Acme-UI?node-id=0-1`, bytes: new Uint8Array()};

test('file keys come only from figma.com links', () => {
  assert.equal(figmaFileKey(input.uri), KEY);
  assert.equal(figmaFileKey(`https://figma.com/file/${KEY}`), KEY);
  assert.throws(() => figmaFileKey('https://evil.example/design/AbCdEf1234567890'), /Figma file link/);
});

test('variables with modes, styles, component sets and auto-layout become observations', async () => {
  const {fetch, calls} = fakeFetch();
  const result = await createFigmaAdapter('secret-token')(input, {signal: new AbortController().signal, fetch});
  assert.ok(calls.every(c => c.url.startsWith('https://api.figma.com/v1/') && c.token === 'secret-token'));
  assert.deepEqual(result.themes, ['Light', 'Dark']);
  const tokens = of(result.observations, 'token');
  assert.equal(tokens.find(t => t.path === 'color.brand.primary')?.value, '#0052CC');
  assert.match(tokens.find(t => t.path === 'color.brand.primary')?.raw ?? '', /Light=#0052CC; Dark=#4D8CFF/);
  assert.equal(tokens.find(t => t.path === 'color.action.background')?.value, '{color.brand.primary}', 'aliases are kept as references');
  assert.equal(tokens.find(t => t.path === 'space.4')?.value, '16');
  const button = of(result.observations, 'component').find(c => c.name === 'Button')!;
  assert.deepEqual(button.states, ['default', 'hover', 'focus', 'disabled']);
  assert.deepEqual(button.variants, ['Variant=Primary', 'Variant=Secondary', 'Variant=Ghost', 'size=Small', 'size=Medium', 'size=Large']);
  assert.deepEqual(button.props, [{name: 'Label', type: 'text'}]);
  assert.equal(of(result.observations, 'component').length, 1, 'variants inside a set are not separate components');
  assert.ok(of(result.observations, 'color').some(c => c.name === 'Brand/Primary' && c.value === '#0052CC' && c.property === 'fill'));
  assert.ok(of(result.observations, 'color').some(c => c.locator === 'detached fills' && c.value === '#0B5FD6'), 'detached fills are kept as observed usage');
  assert.ok(of(result.observations, 'font').some(f => f.family === 'Inter' && f.size === '16px' && f.role === 'Body/Medium'));
  assert.deepEqual(of(result.observations, 'spacing').map(s => s.value).sort(), ['12px', '12px', '16px', '16px', '8px']);
  assert.deepEqual(of(result.observations, 'radius').map(r => r.value), ['8px']);
  assert.equal(of(result.observations, 'shadow')[0]?.value, '0px 2px 4px 0px #00000033');
});

test('without variable access the adapter falls back to styles and says so', async () => {
  const {fetch} = fakeFetch(403);
  const result = await createFigmaAdapter('t')(input, {signal: new AbortController().signal, fetch});
  assert.equal(of(result.observations, 'token').length, 0);
  assert.match(result.failed[0]?.reason ?? '', /styles and usage were read instead/);
  assert.ok(of(result.observations, 'component').length);
});

test('a missing token or unshared file gives a clear reason', async () => {
  await assert.rejects(createFigmaAdapter(undefined)(input, {signal: new AbortController().signal}), /not connected/);
  const {fetch} = fakeFetch();
  await assert.rejects(createFigmaAdapter('t')({...input, uri: 'https://www.figma.com/design/ZZZZZZZZZZZZ/x'}, {signal: new AbortController().signal, fetch}), /not shared/);
  await assert.rejects(createFigmaAdapter('t')({...input, uri: 'https://www.figma.com/design/SCOPEKEY123456/x'}, {signal: new AbortController().signal, fetch}), /can’t read file content.*File content: Read only/);
  await assert.rejects(createFigmaAdapter('t')({...input, uri: 'https://www.figma.com/design/EXPIREDKEY1234/x'}, {signal: new AbortController().signal, fetch}), /expired or been revoked/);
});

test('a big file: every component is read past the sampling budget, and private components are left out', async () => {
  const {FIGMA_LIMITS} = await import('@gapscan/adapters');
  const filler = Array.from({length: FIGMA_LIMITS.nodes + 10}, (_, i) => ({id: `9:${i}`, name: 'Shape', type: 'RECTANGLE', fills: [{type: 'SOLID', color: blue}]}));
  const big = {name: 'Big', styles: {}, document: {id: '0:0', name: 'Document', type: 'DOCUMENT', children: [
    {id: '1:1', name: 'Covers', type: 'CANVAS', children: filler},
    {id: '1:2', name: 'Components', type: 'CANVAS', children: [
      {id: '5:1', name: 'Checkbox', type: 'COMPONENT_SET', componentPropertyDefinitions: {State: {type: 'VARIANT', variantOptions: ['Default', 'Checked', 'Disabled']}}, children: []},
      {id: '5:2', name: '.helper frame', type: 'COMPONENT', children: []},
      {id: '5:3', name: '_internal', type: 'COMPONENT_SET', children: []},
    ]},
  ]}};
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url), json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
    return href.endsWith('/variables/local') ? json(403, {err: 'Invalid scope(s)'}) : json(200, big);
  }) as typeof fetch;
  const result = await createFigmaAdapter('t')(input, {signal: new AbortController().signal, fetch: fetchImpl});
  assert.deepEqual(of(result.observations, 'component').map(c => c.name), ['Checkbox'], 'found on a later page; private ones are skipped');
  assert.equal(result.budgetHit, true);
  assert.ok(result.failed.some(f => /sampled from the first .* every component was read/.test(f.reason)));
});
