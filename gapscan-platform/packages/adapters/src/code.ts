// Code adapter for foundations: W3C DTCG / Style Dictionary token JSON, and
// CSS / SCSS / Less custom properties and declarations. Nothing is executed.
// Component inventories still come from the prototype extractor in Phase 2.
import {AdapterError} from './types.ts';
import {typescriptObservations} from './typescript.ts';
import type {Adapter, Observation} from './types.ts';

const COLOR_PROPS = /^(color|background|background-color|border(?:-(?:top|right|bottom|left))?-color|border|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color)$/;
const SPACING_PROPS = /^(margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/;
const COLOR_IN_VALUE = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/gi;
const MAX_DECLARATIONS = 50_000;

type Declaration = {selector: string; property: string; value: string; line: number};

// Flattens nested rules (SCSS nesting, @media blocks) into selector/property/value triples.
export function cssDeclarations(source: string): Declaration[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:"'])\/\/[^\n]*/g, (m, p: string) => p + ' '.repeat(m.length - p.length));
  const out: Declaration[] = [], stack: string[] = [];
  // `&:hover` and `:hover` nested under `.btn` mean `.btn:hover`; other children are descendants.
  const selectorOf = () => stack.filter(Boolean).reduce((all, part) => all + (part.startsWith(':') || !all ? part : ' ' + part), '');
  let buffer = '', line = 1, startLine = 1, quote: string | null = null;
  const flushDeclarations = (chunk: string) => {
    for (const part of chunk.split(';')) {
      const match = part.match(/^\s*([$@]?-{0,2}[a-zA-Z][\w-]*)\s*:\s*([\s\S]+?)\s*(?:!default|!important)?\s*$/);
      if (match && out.length < MAX_DECLARATIONS) out.push({selector: selectorOf() || ':root', property: match[1]!.trim(), value: match[2]!.replace(/\s+/g, ' ').trim(), line: startLine});
    }
  };
  for (const ch of text) {
    if (ch === '\n') line++;
    if (quote) { buffer += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
    if (ch === '{') {
      const lastSemicolon = buffer.lastIndexOf(';');
      if (lastSemicolon >= 0) { flushDeclarations(buffer.slice(0, lastSemicolon)); buffer = buffer.slice(lastSemicolon + 1); }
      const selector = buffer.trim().replace(/\s+/g, ' ');
      stack.push(selector.startsWith('&') && stack.length ? selector.slice(1) : selector.startsWith('@') ? '' : selector);
      buffer = ''; startLine = line; continue;
    }
    if (ch === '}') { flushDeclarations(buffer); buffer = ''; stack.pop(); startLine = line; continue; }
    if (!buffer.trim()) startLine = line;
    buffer += ch;
  }
  flushDeclarations(buffer);
  return out.map(d => ({...d, selector: d.selector.replace(/\s+/g, ' ').trim() || ':root'}));
}

function tokenType(property: string, value: string): string | undefined {
  if (COLOR_IN_VALUE.test(value)) { COLOR_IN_VALUE.lastIndex = 0; return 'color'; }
  if (/radius/.test(property)) return 'radius';
  if (/shadow/.test(property)) return 'shadow';
  if (/font-?family|font$/.test(property)) return 'fontFamily';
  if (/^-?[\d.]+(px|rem|em)$/.test(value)) return 'dimension';
  return undefined;
}

function fromCss(source: string, name: string): Observation[] {
  const observations: Observation[] = [], declarations = cssDeclarations(source);
  // A rule's font-family belongs with its font-size, so body text can be identified by both.
  const familyBySelector = new Map(declarations.filter(d => d.property.toLowerCase() === 'font-family').map(d => [d.selector, d.value]));
  for (const d of declarations) {
    const locator = `${name}:${d.line}`, property = d.property.toLowerCase();
    if (/^(--|\$|@)/.test(d.property)) {
      const type = tokenType(property, d.value);
      observations.push({type: 'token', channel: 'code_tokens', path: d.property, value: d.value, ...(type ? {tokenType: type} : {}), locator, raw: `${d.selector} { ${d.property}: ${d.value} }`});
      for (const color of d.value.match(COLOR_IN_VALUE) ?? []) observations.push({type: 'color', channel: 'code_tokens', value: color, name: d.property, locator});
      continue;
    }
    if (COLOR_PROPS.test(property)) for (const color of d.value.match(COLOR_IN_VALUE) ?? []) observations.push({type: 'color', channel: 'observed_css', value: color, property, selector: d.selector, locator});
    if (property === 'font-size') observations.push({type: 'font', channel: 'observed_css', family: familyBySelector.get(d.selector) ?? '', size: d.value, selector: d.selector, locator});
    if (property === 'font-family') observations.push({type: 'font', channel: 'observed_css', family: d.value, selector: d.selector, locator});
    if (property === 'font') { const size = d.value.match(/(?:^|\s)([\d.]+(?:px|rem|pt))(?:\/[\d.]+\w*)?\s+(.+)$/); if (size) observations.push({type: 'font', channel: 'observed_css', size: size[1]!, family: size[2]!, selector: d.selector, locator}); }
    if (SPACING_PROPS.test(property) && !/var\(|calc\(|auto/.test(d.value)) observations.push({type: 'spacing', channel: 'observed_css', value: d.value, locator});
    if (/^border(-[a-z]+)*-radius$/.test(property) && !/var\(/.test(d.value)) observations.push({type: 'radius', channel: 'observed_css', value: d.value, locator});
    if (property === 'box-shadow' && !/var\(/.test(d.value)) observations.push({type: 'shadow', channel: 'observed_css', value: d.value, locator});
  }
  return observations;
}

// DTCG ($value/$type) and Style Dictionary (value/type) token files; groups become dotted paths.
function fromTokenJson(json: unknown, name: string): Observation[] {
  const observations: Observation[] = [];
  const visit = (node: unknown, path: string[], inheritedType?: string) => {
    if (!node || typeof node !== 'object' || observations.length > MAX_DECLARATIONS) return;
    const record = node as Record<string, unknown>, type = (record.$type ?? record.type ?? inheritedType) as string | undefined;
    const value = '$value' in record ? record.$value : 'value' in record && path.length ? record.value : undefined;
    if (value !== undefined) {
      const text = typeof value === 'string' ? value : JSON.stringify(value), tokenPath = path.join('.');
      observations.push({type: 'token', channel: 'code_tokens', path: tokenPath, value: text, ...(type ? {tokenType: type} : {}), ...(typeof record.$description === 'string' ? {description: record.$description} : {}), locator: `${name}#${tokenPath}`});
      if ((type === 'color' || (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value))) && typeof value === 'string' && !value.startsWith('{'))
        observations.push({type: 'color', channel: 'code_tokens', value, name: tokenPath, locator: `${name}#${tokenPath}`});
      return;
    }
    for (const [key, child] of Object.entries(record)) if (!key.startsWith('$')) visit(child, [...path, key], type);
  };
  visit(json, []);
  return observations;
}

// Groups class selectors into components with variants, sizes and states, the way
// libraries encode them: `.btn` + `.btn-primary` + `.btn-sm`, BEM `.cds--btn--primary`,
// or prop-style `.Polaris-Button--variantPrimary` / `--sizeSlim`.
const SIZE_MOD = /^(?:size[-_]?)?(xs|sm|small|md|medium|lg|large|xl|xxl|2xl|slim|micro|compact|mini|tiny|big|huge)$/i;
const STATE_MOD = /^(?:is[-_]?)?(disabled|loading|active|pressed|selected|focus|focused|hover|hovered|error|invalid|checked|busy|open|expanded)$/i;
const STATE_PSEUDO = /:(hover|focus-visible|focus|active|disabled|checked)(?![\w-])|\[(disabled|aria-disabled|aria-pressed|aria-busy|aria-invalid)/g;
const PROP_PREFIX = /^(variant|tone|kind|appearance|color|type|size|state|status)([A-Z0-9].*)$/;
const lower = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export function cssComponents(source: string, {prefix = ''}: {prefix?: string} = {}): {name: string; variants: string[]; sizes: string[]; states: string[]; selector: string; count: number}[] {
  // Every rule's selector counts, including rules with empty bodies (`.btn:hover {}` still declares the state).
  const selectors = [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|[{}])\s*([^{}@;]+?)\s*\{/g)].map(m => m[2]!.trim()).filter(Boolean);
  const classes = new Set<string>();
  for (const selector of selectors) for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]!);
  const strip = (cls: string) => prefix && cls.startsWith(prefix) ? cls.slice(prefix.length) : prefix ? null : cls;
  const groups = new Map<string, {variants: Set<string>; sizes: Set<string>; states: Set<string>; count: number}>();
  const split = (cls: string): [string, string | null] | null => {
    const bare = strip(cls);
    if (!bare || bare.includes('__')) return null;                    // BEM elements are anatomy, not components
    if (bare.includes('--')) { const [base, mod] = bare.split(/--(.*)/s) as [string, string]; return [base, mod]; }
    const dash = bare.indexOf('-');
    if (dash > 0 && classes.has((prefix || '') + bare.slice(0, dash))) return [bare.slice(0, dash), bare.slice(dash + 1)];
    return [bare, null];
  };
  const group = (base: string) => groups.get(base) ?? (groups.set(base, {variants: new Set(), sizes: new Set(), states: new Set(), count: 0}), groups.get(base)!);
  for (const cls of classes) {
    const parts = split(cls);
    if (!parts) continue;
    const [base, modifier] = parts, entry = group(base);
    entry.count++;
    if (!modifier) continue;
    const prop = modifier.match(PROP_PREFIX), value = lower(prop ? prop[2]! : modifier).replace(/^-/, '');
    if (prop?.[1] === 'size' || SIZE_MOD.test(value)) entry.sizes.add(value.replace(/^size-/, ''));
    else if (STATE_MOD.test(value)) entry.states.add(value.replace(/^is-/, '').replace('focused', 'focus').replace('hovered', 'hover'));
    else if (value.length <= 24 && !/^\d+$/.test(value)) entry.variants.add(prop && prop[1] !== 'variant' ? `${prop[1]}=${value}` : value);
  }
  // Chained modifier classes (Bulma `.button.is-primary`, Bootstrap `.btn.disabled`) belong to the first class.
  for (const selector of selectors) for (const chain of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)((?:\.[\w-]+)+)/g)) {
    const parts = split(chain[1]!);
    if (!parts || !groups.has(parts[0])) continue;
    for (const mod of chain[2]!.split('.').filter(Boolean)) {
      const value = lower(mod.replace(/^(is|has)-/, ''));
      if (!/^(is|has)-/.test(mod) && !STATE_MOD.test(value)) continue;
      const entry = groups.get(parts[0])!;
      if (SIZE_MOD.test(value)) entry.sizes.add(value); else if (STATE_MOD.test(value)) entry.states.add(value.replace('focused', 'focus').replace('hovered', 'hover')); else if (value.length <= 24) entry.variants.add(value);
    }
  }
  for (const selector of selectors) for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)([^\s,>+~]*)/g)) {
    const parts = split(m[1]!), pseudo = m[2] ?? '';
    if (!parts || !groups.has(parts[0])) continue;
    for (const state of pseudo.matchAll(STATE_PSEUDO)) groups.get(parts[0])!.states.add((state[1] ?? state[2]!).replace(/^aria-/, '').replace('pressed', 'active').replace('invalid', 'error').replace('busy', 'loading'));
  }
  return [...groups].filter(([base, g]) => g.variants.size + g.sizes.size + g.states.size > 0 || g.count > 1 || /^[A-Z]/.test(base))
    .map(([base, g]) => ({name: base, variants: [...g.variants].slice(0, 30), sizes: [...g.sizes], states: [...g.states].map(s => s === 'focus' ? 'focus-visible' : s).filter((s, i, all) => all.indexOf(s) === i), selector: '.' + (prefix || '') + base, count: g.count}));
}

// An inferred specimen: the team's own CSS rules for a component, applied to generated
// markup (one element per modifier class). Labelled as inferred wherever it is shown.
export function inferredSpecimen(source: string, base: string, prefix = ''): {html: string; css: string} | null {
  const full = prefix + base, escaped = full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].filter(m => new RegExp(`\\.${escaped}(?![\\w])|\\.${escaped}[-_]`).test(m[1]!));
  if (!rules.length) return null;
  const css = rules.map(m => `${m[1]!.trim()}{${m[2]!.trim()}}`).join('\n').slice(0, 6000);
  // Style variants first, then sizes; states (disabled, pressed…) last since they need interaction anyway.
  const isState = (cls: string) => STATE_MOD.test(lower(cls.replace(full, '').replace(/^[-_]+/, '').replace(/^(is|has)-/, '')));
  const modifiers = [...new Set([...css.matchAll(new RegExp(`\\.(${escaped}(?:--|-)[\\w-]+)`, 'g'))].map(m => m[1]!))].filter(c => !/__/.test(c)).sort((a, b) => Number(isState(a)) - Number(isState(b))).slice(0, 6);
  const tag = /btn|button/i.test(base) ? 'button' : /input|field/i.test(base) ? 'input' : /select/i.test(base) ? 'select' : /badge|tag|chip|pill/i.test(base) ? 'span' : 'div';
  const element = (cls: string) => tag === 'input' ? `<input class="${cls}" value="${cls}">` : `<${tag} class="${cls}">${cls}</${tag}>`;
  const extra = (c: string) => /^(is|has)-/.test(c) ? `${full} ${c}` : `${full} ${c}`;
  return {html: `<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">${[element(full), ...modifiers.map(c => element(extra(c)))].join('')}</div>`, css};
}

export type CodeAdapterOptions = {classPrefix?: string};
export function createCodeAdapter({classPrefix}: CodeAdapterOptions = {}): Adapter {
  return async ({bytes, name}) => {
    const source = Buffer.from(bytes).toString('utf8');
    let observations: Observation[];
    if (/\.json$/i.test(name) || /^\s*\{/.test(source) && !/[;}]\s*\.[a-z]/i.test(source.slice(0, 2000))) {
      let json: unknown;
      try { json = JSON.parse(source); } catch { if (/\.json$/i.test(name)) throw new AdapterError(`${name} is not valid JSON.`); json = undefined; }
      observations = json === undefined ? fromCss(source, name) : fromTokenJson(json, name);
    } else {
      observations = fromCss(source, name);
      if (/\.[jt]sx?$/i.test(name)) observations.push(...typescriptObservations(source, name));
      if (/\.(css|scss|sass|less)$/i.test(name)) for (const c of cssComponents(source, {prefix: classPrefix ?? ''}))
        { const specimen = inferredSpecimen(source, c.name, classPrefix ?? '');
          observations.push({type: 'component', channel: 'code_tokens', name: c.name, variants: [...c.variants, ...c.sizes.map(s => `size=${s}`)], states: c.states, ...(specimen ? {html: specimen.html, css: specimen.css} : {}), locator: `${name} ${c.selector}`, raw: `${c.count} classes`}); }
    }
    return {observations, fetched: 1, failed: [], budgetHit: observations.length >= MAX_DECLARATIONS};
  };
}
export const codeAdapter: Adapter = createCodeAdapter();
