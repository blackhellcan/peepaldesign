// Figma adapter (REST API, read-only). Variables with modes are declared
// tokens; published styles are declared styles; component sets give variant,
// size and state options; auto-layout, radii, shadows and detached fills are
// observed usage. Requests go only to api.figma.com with the caller's token.
import {toHex} from '@gapscan/normalize';
import {AdapterError} from './types.ts';
import type {Adapter, AdapterContext, Observation} from './types.ts';

export const FIGMA_LIMITS = Object.freeze({nodes: 60_000});
const API = 'https://api.figma.com/v1';

type Rgba = {r: number; g: number; b: number; a?: number};
type Paint = {type: string; visible?: boolean; color?: Rgba; opacity?: number};
type Effect = {type: string; visible?: boolean; color?: Rgba; offset?: {x: number; y: number}; radius?: number; spread?: number};
type FigmaNode = {
  id: string; name: string; type: string; children?: FigmaNode[];
  fills?: Paint[]; strokes?: Paint[]; effects?: Effect[]; styles?: Record<string, string>;
  cornerRadius?: number; itemSpacing?: number; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  style?: {fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number};
  componentPropertyDefinitions?: Record<string, {type: string; variantOptions?: string[]; defaultValue?: unknown}>;
};
type FileResponse = {name: string; document: FigmaNode; styles?: Record<string, {name: string; styleType: string}>};
type VariableValue = Rgba | number | string | boolean | {type: 'VARIABLE_ALIAS'; id: string};
type VariablesResponse = {meta: {
  variables: Record<string, {name: string; resolvedType: string; valuesByMode: Record<string, VariableValue>; variableCollectionId: string; description?: string}>;
  variableCollections: Record<string, {name: string; defaultModeId: string; modes: {modeId: string; name: string}[]}>;
}};

export function figmaFileKey(uri: string): string {
  const match = uri.match(/^https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]{10,40})(?:[/?#]|$)/);
  if (!match) throw new AdapterError('Use a Figma file link like https://www.figma.com/design/<file key>/…');
  return match[1]!;
}

const hex = (c: Rgba, opacity = 1) => toHex({r: c.r, g: c.g, b: c.b, alpha: (c.a ?? 1) * opacity}).toUpperCase();
const STATE_WORDS = /^(default|rest|enabled|hover|hovered|focus|focused|pressed|active|disabled|selected|error|loading|checked|indeterminate)$/i;
const SIZE_WORDS = /^(xs|sm|small|md|medium|lg|large|xl|xxl|compact|comfortable|slim|micro)$/i;

async function get<T>(context: AdapterContext, path: string, token: string): Promise<{ok: true; data: T} | {ok: false; status: number; message: string}> {
  const response = await (context.fetch ?? fetch)(`${API}${path}`, {headers: {'X-Figma-Token': token}, signal: context.signal});
  if (response.ok) return {ok: true, data: await response.json() as T};
  const body = await response.json().catch(() => ({})) as {err?: string; message?: string};
  return {ok: false, status: response.status, message: body.err ?? body.message ?? response.statusText};
}

export function createFigmaAdapter(token: string | undefined): Adapter {
  return async ({uri}, context) => {
    if (!token) throw new AdapterError('Figma is not connected. Set GAPSCAN_FIGMA_TOKEN on the server to read Figma files.');
    const key = figmaFileKey(uri), observations: Observation[] = [], failed: {locator: string; reason: string}[] = [];
    const file = await get<FileResponse>(context, `/files/${key}`, token);
    if (!file.ok) throw new AdapterError(
      // Figma says "Invalid scope" when the token exists but wasn't given read access to file content.
      file.status === 403 && /scope/i.test(file.message) ? 'The Figma token can’t read file content. Make a new token in Figma (Settings → Security → Personal access tokens) with “File content: Read only”, and replace the old one.'
      : file.status === 403 && /token/i.test(file.message) ? 'The Figma token was refused: it may have expired or been revoked. Make a new one in Figma and replace it.'
      : file.status === 403 || file.status === 404 ? 'This Figma file is not shared with the connected account, or the link is wrong.' : `Figma returned ${file.status}: ${file.message}`);

    // Variables need a plan with REST variable access; without it we fall back to styles and usage.
    const variables = await get<VariablesResponse>(context, `/files/${key}/variables/local`, token);
    let themes: string[] = [];
    if (variables.ok) {
      const {variables: vars, variableCollections: collections} = variables.data.meta;
      themes = [...new Set(Object.values(collections).flatMap(c => c.modes.map(m => m.name)))];
      for (const [id, variable] of Object.entries(vars)) {
        const collection = collections[variable.variableCollectionId];
        const defaultMode = collection?.defaultModeId ?? Object.keys(variable.valuesByMode)[0]!;
        const value = variable.valuesByMode[defaultMode];
        const path = variable.name.replaceAll('/', '.');
        const render = (v: VariableValue | undefined): string => v === undefined ? '' : typeof v === 'object' && 'type' in v ? `{${vars[v.id]?.name.replaceAll('/', '.') ?? v.id}}` : typeof v === 'object' ? hex(v) : String(v);
        const modes = collection && collection.modes.length > 1 ? collection.modes.map(m => `${m.name}=${render(variable.valuesByMode[m.modeId])}`).join('; ') : undefined;
        observations.push({type: 'token', channel: 'figma_variables', path, value: render(value), tokenType: variable.resolvedType.toLowerCase(), ...(variable.description ? {description: variable.description} : {}), locator: `variable ${id}`, ...(modes ? {raw: modes} : {})});
        if (variable.resolvedType === 'COLOR' && value && typeof value === 'object' && !('type' in value)) observations.push({type: 'color', channel: 'figma_variables', value: hex(value), name: path, locator: `variable ${id}`});
      }
    } else failed.push({locator: 'variables', reason: variables.status === 403 ? 'Variables are not available to this account through the REST API; styles and usage were read instead.' : `Variables could not be read (${variables.status}).`});

    const styleNames = file.data.styles ?? {}, fills = new Map<string, {count: number; name?: string}>();
    // The whole file is always walked for component definitions (cheap, and a big file keeps its
    // components on later pages); the node budget only bounds sampling of fills, text and spacing.
    let visited = 0, budgetHit = false;
    const walk = (node: FigmaNode, inComponent: boolean) => {
      const sampling = ++visited <= FIGMA_LIMITS.nodes;
      if (!sampling) budgetHit = true;
      if (visited % 5000 === 0) context.signal.throwIfAborted();
      if (sampling) for (const paint of node.fills ?? []) if (paint.type === 'SOLID' && paint.visible !== false && paint.color) {
        const value = hex(paint.color, paint.opacity ?? 1), styleName = node.styles?.fill ? styleNames[node.styles.fill]?.name : undefined;
        const entry = fills.get(value) ?? {count: 0}; entry.count++; if (styleName) entry.name ??= styleName; fills.set(value, entry);
      }
      if (sampling && node.type === 'TEXT' && node.style?.fontSize) {
        const styleName = node.styles?.text ? styleNames[node.styles.text]?.name : undefined;
        observations.push({type: 'font', channel: 'figma_styles', family: node.style.fontFamily ?? '', size: `${node.style.fontSize}px`,
          ...(node.style.fontWeight ? {weight: String(node.style.fontWeight)} : {}), ...(node.style.lineHeightPx ? {lineHeight: `${Math.round(node.style.lineHeightPx * 100) / 100}px`} : {}),
          ...(styleName ? {role: styleName} : {}), locator: `node ${node.id}`});
      }
      if (sampling && inComponent) {
        for (const value of [node.itemSpacing, node.paddingLeft, node.paddingRight, node.paddingTop, node.paddingBottom]) if (value) observations.push({type: 'spacing', channel: 'figma_styles', value: `${value}px`, locator: `node ${node.id}`});
        if (node.cornerRadius) observations.push({type: 'radius', channel: 'figma_styles', value: `${node.cornerRadius}px`, locator: `node ${node.id}`});
        for (const effect of node.effects ?? []) if (effect.type === 'DROP_SHADOW' && effect.visible !== false && effect.color)
          observations.push({type: 'shadow', channel: 'figma_styles', value: `${effect.offset?.x ?? 0}px ${effect.offset?.y ?? 0}px ${effect.radius ?? 0}px ${effect.spread ?? 0}px ${hex(effect.color)}`, locator: `node ${node.id}`});
      }
      // Names starting with "." or "_" are private building blocks by Figma convention, never published.
      if ((node.type === 'COMPONENT_SET' || (node.type === 'COMPONENT' && !inComponent)) && !/^[._]/.test(node.name.trim())) {
        const options = Object.entries(node.componentPropertyDefinitions ?? {}).filter(([, d]) => d.type === 'VARIANT');
        const values = (pattern: RegExp, propName: RegExp) => options.flatMap(([name, d]) => propName.test(name) ? d.variantOptions ?? [] : (d.variantOptions ?? []).filter(v => pattern.test(v)));
        const states = values(STATE_WORDS, /state|status|interaction/i), sizes = values(SIZE_WORDS, /^size$/i);
        const variants = options.filter(([name]) => !/state|status|interaction|^size$/i.test(name)).flatMap(([name, d]) => (d.variantOptions ?? []).map(v => `${name}=${v}`));
        observations.push({type: 'component', channel: 'figma_styles', name: node.name, states: [...new Set(states.map(s => s.toLowerCase()))], variants: [...new Set([...variants, ...sizes.map(s => `size=${s}`)])],
          props: Object.entries(node.componentPropertyDefinitions ?? {}).filter(([, d]) => d.type !== 'VARIANT').map(([name, d]) => ({name: name.replace(/#\d+:\d+$/, ''), type: d.type.toLowerCase()})), locator: `node ${node.id}`});
      }
      for (const childNode of node.children ?? []) walk(childNode, inComponent || node.type === 'COMPONENT_SET' || node.type === 'COMPONENT');
    };
    walk(file.data.document, false);
    for (const [value, {count, name}] of fills) observations.push({type: 'color', channel: 'figma_styles', value, property: 'fill', count, ...(name ? {name} : {}), locator: name ? `style ${name}` : 'detached fills'});
    if (budgetHit) failed.push({locator: 'styles', reason: `Colours, text and spacing were sampled from the first ${FIGMA_LIMITS.nodes.toLocaleString('en')} of ${visited.toLocaleString('en')} layers; every component was read.`});
    return {observations, fetched: Math.min(visited, FIGMA_LIMITS.nodes), failed, budgetHit, themes};
  };
}
