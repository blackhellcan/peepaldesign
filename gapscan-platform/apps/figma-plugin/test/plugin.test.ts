// Runs the importer's real code against a strict stand-in for the Figma Plugin API, with an
// export built from a fixture extraction. It checks what would be created, not how Figma draws it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildFigmaPlan} from '@gapscan/exports';

type Node = Record<string, any>;
function fakeFigma(fonts: string[]) {
  let id = 0;
  const log = {variables: [] as Node[], collections: [] as Node[], textStyles: [] as Node[], effectStyles: [] as Node[], pages: [] as Node[], sets: [] as Node[], bindings: 0, messages: [] as Node[]};
  const node = (type: string, extra: Node = {}): Node => {
    const n: Node = {id: `${++id}:1`, type, name: '', children: [], fills: [], strokes: [], width: 100, height: 40, ...extra,
      resize(w: number, h: number) { n.width = w; n.height = h; },
      appendChild(c: Node) { n.children.push(c); c.parent = n; },
      findOne(fn: (x: Node) => boolean): Node | null { for (const c of n.children) { if (fn(c)) return c; const d = c.findOne?.(fn); if (d) return d; } return null; },
      setBoundVariable(field: string, v: Node) { assert.ok(v && v.id?.startsWith('VariableID'), `binding ${field} needs a variable`); log.bindings++; },
      async setTextStyleIdAsync(sid: string) { assert.ok(log.textStyles.some(s => s.id === sid), 'text style exists'); n.textStyleId = sid; },
      async loadAsync() {},
      addComponentProperty(name: string) { return `${name}#1`; }};
    return n;
  };
  const root: Node = node('DOCUMENT');
  const first = node('PAGE', {name: 'Page 1'}); root.children.push(first);
  const figma: Node = {
    root, ui: {postMessage: (m: Node) => log.messages.push(m), onmessage: null as any},
    showUI() {}, async listAvailableFontsAsync() { return fonts.map(f => { const [family, style] = f.split(':'); return {fontName: {family, style}}; }); },
    async loadFontAsync(f: Node) { assert.ok(fonts.includes(`${f.family}:${f.style}`), `font ${f.family} ${f.style} is available`); },
    variables: {
      async getLocalVariableCollectionsAsync() { return log.collections; }, async getLocalVariablesAsync() { return log.variables; },
      createVariableCollection(name: string) { const c = {id: `VariableCollectionId:${++id}`, name, modes: [{modeId: 'm1', name: 'Mode 1'}], renameMode(_: string, n: string) { c.modes[0]!.name = n; }}; log.collections.push(c); return c; },
      createVariable(name: string, coll: Node, type: string) {
        const v: Node = {id: `VariableID:${++id}`, name, type, variableCollectionId: coll.id, values: {}, syntax: {},
          setValueForMode(_: string, value: Node | number) {
            if (type === 'COLOR' && !(value as Node).type) for (const k of ['r', 'g', 'b', 'a']) assert.ok((value as Node)[k] >= 0 && (value as Node)[k] <= 1, `${name}.${k} in 0–1`);
            if ((value as Node).type === 'VARIABLE_ALIAS') assert.ok(log.variables.some(x => x.id === (value as Node).id), `${name} aliases an existing variable`);
            v.value = value; },
          setVariableCodeSyntax(platform: string, s: string) { v.syntax[platform] = s; }};
        log.variables.push(v); return v; },
      setBoundVariableForPaint(paint: Node, field: string, v: Node) { assert.ok(v?.id?.startsWith('VariableID'), 'paint bound to a variable'); log.bindings++; return {...paint, boundVariables: {[field]: v.id}}; },
    },
    async getLocalTextStylesAsync() { return log.textStyles; }, createTextStyle() { const s = {id: `S:${++id}`, name: ''}; log.textStyles.push(s); return s; },
    async getLocalEffectStylesAsync() { return log.effectStyles; }, createEffectStyle() { const s = {id: `S:${++id}`, name: ''}; log.effectStyles.push(s); return s; },
    createPage() { const p = node('PAGE'); root.children.push(p); log.pages.push(p); return p; }, async setCurrentPageAsync() {},
    createFrame: () => node('FRAME'), createComponent: () => node('COMPONENT'), createRectangle: () => node('RECTANGLE'),
    createText: () => node('TEXT', {fontName: {family: 'Inter', style: 'Regular'}, characters: ''}),
    combineAsVariants(components: Node[], parent: Node) { const s = node('COMPONENT_SET', {children: components}); parent.appendChild(s); log.sets.push(s); return s; },
  };
  return {figma, log};
}

const fixture = JSON.parse(readFileSync(new URL('./blush-design-system.json', import.meta.url), 'utf8'));
async function run(fonts: string[], options = {foundations: true, components: true}) {
  const {figma, log} = fakeFigma(fonts);
  vm.runInNewContext(readFileSync(new URL('../code.js', import.meta.url), 'utf8'), {figma, __html__: '', console});
  await figma.ui.onmessage({type: 'build', plan: buildFigmaPlan(fixture), options});
  return {figma, log, done: log.messages.find(m => m.type === 'done' || m.type === 'error')!};
}

test('the importer builds variables, styles, a foundations page and components from an export', async () => {
  const {log, done} = await run(['Inter:Regular', 'Inter:Medium', 'Inter:Bold', 'DM Sans:Regular', 'DM Sans:Medium', 'DM Sans:Bold']);
  assert.equal(done.type, 'done', JSON.stringify(done));
  assert.deepEqual(log.collections.map(c => c.name), ['Primitives', 'Color', 'Spacing', 'Radius']);
  const ink = log.variables.find(v => v.name === 'ink/900')!;
  assert.equal(ink.syntax.WEB, 'var(--color-ink-900)');
  assert.ok(Math.abs(ink.value.r - 0x28 / 255) < 1e-6, 'colours keep their value');
  assert.equal(log.variables.find(v => v.name === 'color/bg/action')!.value.type, 'VARIABLE_ALIAS');
  assert.equal(done.result.font, 'DM Sans');
  assert.equal(done.result.substituted, true);
  assert.match(log.textStyles[0]!.description, /Shown in DM Sans because gordita-web is not available/);
  assert.deepEqual(log.sets.map(s => s.name), fixture.components.map((c: {name: string}) => c.name));
  const button = log.sets.find(s => s.name === 'Button')!;
  const names = Array.from(button.children, (c: Node) => c.name as string);
  assert.deepEqual(names, ['Style=Secondary, State=Default', 'Style=Secondary, State=Hover', 'Style=Outline, State=Default', 'Style=Outline, State=Hover', 'Style=Outline, State=Pressed',
    'Style=Ghost, State=Default', 'Style=Ghost, State=Hover', 'Style=Primary, State=Default'], 'a variant per captured state');
  const hover = button.children.find((c: Node) => c.name === 'Style=Secondary, State=Hover');
  assert.ok(hover.effects.some((e: Node) => e.type === 'INNER_SHADOW'), 'the hover ring (an inset shadow on the site) is drawn');
  assert.ok(button.children.every((c: Node) => c.x >= 0 && c.y >= 0) && new Set(Array.from(button.children, (c: Node) => `${c.x},${c.y}`)).size === names.length, 'laid out as a grid, no overlaps');
  const ghostHover = button.children.find((c: Node) => c.name === 'Style=Ghost, State=Hover');
  assert.equal(ghostHover.findOne((n: Node) => n.type === 'TEXT').textDecoration, 'UNDERLINE');
  const primary = button.children.find((c: Node) => c.name === 'Style=Primary, State=Default');
  assert.equal(primary.fills[0].boundVariables.color, log.variables.find(v => v.name === 'color/bg/action')!.id, 'the primary fill is the semantic action colour');
  assert.ok(log.bindings > 50);
});

test('re-running updates in place and leaves existing component sets alone', async () => {
  const {figma, log} = await run(['Inter:Regular', 'Inter:Medium', 'Inter:Bold']);
  const before = {variables: log.variables.length, sets: log.sets.length};
  log.messages.length = 0;
  await figma.ui.onmessage({type: 'build', plan: buildFigmaPlan(fixture), options: {foundations: true, components: true}});
  const done = log.messages.find(m => m.type === 'done')!;
  assert.equal(log.variables.length, before.variables, 'no duplicate variables');
  assert.equal(log.sets.length, before.sets, 'no duplicate components');
  assert.equal(done.result.skipped.length, before.sets);
});

test('a file that is not a GapScan export is refused with a readable message', async () => {
  const {figma, log} = fakeFigma(['Inter:Regular']);
  vm.runInNewContext(readFileSync(new URL('../code.js', import.meta.url), 'utf8'), {figma, __html__: '', console});
  await figma.ui.onmessage({type: 'build', plan: {format: 'tokens-studio'}, options: {}});
  assert.match(log.messages.at(-1)!.message, /not a GapScan Figma export/);
});

