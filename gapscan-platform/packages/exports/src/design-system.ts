// The design-system document: an extraction laid out the way a Figma library is organised
// (colour ramps, text styles, spacing, radius, effects, components with variants). One model
// feeds the in-app page, the self-contained HTML export and the Figma build. Everything read
// from a website is re-validated here before it reaches markup or styles.
import {parseColor, toHex} from '@gapscan/normalize';
import type {ExtractedDesignSystem} from '@gapscan/schema';

export type Swatch = {name: string; hex: string; variable?: string};
export type TextStyle = {name: string; px: number; weight: number; lineHeightPx: number | null; family: string; uses: number};
export type Shadow = {x: number; y: number; blur: number; spread: number; color: string; inset: boolean};
export type ComponentStyle = {background: string | null; color: string | null; border: string | null; borderWidth: number; radius: number; fontSize: number; fontWeight: number;
  paddingY: number; paddingX: number; height: number; label: string;
  shadows: Shadow[]; outline: {width: number; color: string; offset: number} | null; underline: boolean; opacity: number};
export type StateName = 'hover' | 'focus-visible' | 'active' | 'disabled';
export type DesignSystemDoc = {
  name: string; source: string; generatedAt: string;
  colors: {groups: {name: string; swatches: Swatch[]; declared: boolean}[]; roles: {role: string; hex: string; reason: string}[]};
  typography: {families: string[]; styles: TextStyle[]};
  spacing: {base: number | null; steps: number[]};
  radius: {name: string; px: number}[];
  shadows: {name: string; value: string}[];
  components: {name: string; category: string; states: string[]; missing: string[];
    variants: {name: string; style: ComponentStyle; uses: number; states: {name: StateName; style: ComponentStyle}[]; screenshot?: string}[]; sizes: {name: string; style: ComponentStyle}[]}[];
  alsoFound: {name: string; category: string}[];   // components with no visual style of their own (transparent, unbordered)
  notes: string[];
};
type ScalesLike = {roles?: {role: string; hex: string; reason: string}[]; colors?: {hex: string; count: number; neutral: boolean}[]; spacing?: {baseUnit: number | null; steps: number[]};
  textStyles?: {px: number; weight: number; lineHeightPx: number | null; family: string; count: number}[]; type?: {families?: string[]; sizes?: {px: number; role: string}[]} | null};

const hexOf = (value: unknown): string | null => { const c = typeof value === 'string' ? parseColor(value.trim()) : null; return c && c.alpha > 0 ? toHex(c) : null; };
const px = (value: unknown): number => { const m = typeof value === 'string' ? value.match(/^(-?[\d.]+)px$/) : null; return m ? Math.round(Number(m[1]) * 10) / 10 : 0; };
const WEIGHTS: Record<number, string> = {100: 'Thin', 200: 'Extralight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extrabold', 900: 'Black'};
const weightName = (w: number) => WEIGHTS[Math.round(w / 100) * 100] ?? String(w);
const titleCase = (text: string) => text.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
// Set names keep short prefixes as initials (ds-blue → DS Blue, ui-bg → UI Bg).
const setName = (text: string) => titleCase(text).replace(/^(\w{1,2})\b/, c => c.toUpperCase());

// Declared custom properties with colour values, grouped into ramps by name:
// --color-ink-900 → Ink / 900, --color-brand-teal-main → Brand teal / Main. Tailwind internals are skipped.
function declaredColorGroups(eds: ExtractedDesignSystem) {
  const vars = new Map(eds.tokens.filter(t => t.path.startsWith('--')).map(t => [t.path, String(t.value)]));
  const resolve = (value: string, depth = 0): string => depth > 6 ? value : value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_, name: string, fallback?: string) => resolve(vars.get(name) ?? fallback ?? '', depth + 1));
  const groups = new Map<string, Swatch[]>();
  for (const [name, value] of vars) {
    // Framework internals (Tailwind's --tw-*) and compiler-generated names (--sx-1mc3c6y) aren't the team's tokens.
    if (/^--(tw|chakra-ring|webkit)-/.test(name) || /-(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}$/.test(name) && !/-\d+$/.test(name)) continue;
    const hex = hexOf(resolve(value));
    if (!hex) continue;
    // The last segment is the step (900, main, primary…), the rest names the set: ramps and
    // semantic sets (--color-bg-primary, --color-bg-secondary) group the same way.
    const bare = name.replace(/^--/, '').replace(/^colou?rs?-/, '');
    const cut = bare.lastIndexOf('-'), m = cut > 0 ? [bare, bare.slice(0, cut), bare.slice(cut + 1)] : null;
    const group = m ? setName(m[1]!) : 'Other', step = m ? titleCase(m[2]!) : titleCase(bare);
    groups.set(group, [...(groups.get(group) ?? []), {name: step, hex, variable: name}]);
  }
  const order = (s: Swatch) => /^\d+$/.test(s.name) ? Number(s.name) : ({Lightest: 0, Lighter: 1, Light: 2, Main: 3, Base: 3, Default: 3, Dark: 4, Darker: 5, Darkest: 6} as Record<string, number>)[s.name] ?? 9;
  // Singles join "Other"; a ramp needs at least two steps. Shorthand aliases (--brand-light repeating
  // --color-brand-teal-light) are dropped when a larger ramp already holds every one of their colours.
  const ramps = [...groups].filter(([g, s]) => g !== 'Other' && s.length >= 2).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const kept: [string, Swatch[]][] = [];
  for (const [name, swatches] of ramps) {
    const covered = new Set(kept.flatMap(([, s]) => s.map(x => x.hex)));
    if (!swatches.every(s => covered.has(s.hex))) kept.push([name, swatches]);
  }
  const known = new Set(kept.flatMap(([, s]) => s.map(x => x.hex)));
  const other = [...groups].filter(([g, s]) => g === 'Other' || s.length < 2).flatMap(([, s]) => s).filter((s, i, all) => !known.has(s.hex) && all.findIndex(x => x.hex === s.hex) === i);
  const firstIndex = (name: string) => [...groups.keys()].indexOf(name);
  return [...kept.sort((a, b) => firstIndex(a[0]) - firstIndex(b[0])).map(([name, swatches]) => ({name, swatches: swatches.sort((a, b) => order(a) - order(b)), declared: true})),
    ...(other.length ? [{name: 'Other', swatches: other, declared: true}] : [])];
}

// Box shadows as structured layers (invisible ones dropped), so they can be drawn and exported safely.
export function parseShadows(value: string | undefined): Shadow[] {
  if (!value || value === 'none') return [];
  return value.split(/,(?![^(]*\))/).flatMap(layer => {
    const colorText = layer.match(/(rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}\b/i)?.[0], color = colorText ? parseColor(colorText) : null;
    const lengths = layer.replace(/(rgba?|hsla?)\([^)]*\)|#[0-9a-f]+|inset/gi, ' ').trim().split(/\s+/).map(v => px(v.endsWith('px') ? v : `${v}px`));
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    return color && color.alpha > 0 && (x || y || blur || spread) ? [{x, y, blur, spread, color: toHex(color), inset: /\binset\b/.test(layer)}] : [];
  }).slice(0, 4);
}
function componentStyle(refs: Record<string, string>): ComponentStyle {
  const border = refs.border && refs.border !== 'none' ? refs.border : '';
  const outline = refs.outline && refs.outline !== 'none' ? refs.outline.match(/^([\d.]+)px\s+(.+?)\s+(-?[\d.]+)px$/) : null, outlineColor = outline ? hexOf(outline[2]) : null;
  return {background: hexOf(refs.background), color: hexOf(refs.color), border: border ? hexOf(border.replace(/^[\d.]+px\s*/, '')) : null, borderWidth: border ? px(border.split(/\s+/)[0]) : 0,
    radius: Math.min(px(refs.radius) || (refs.radius?.endsWith('%') ? 999 : 0), 999), fontSize: px(refs.fontSize), fontWeight: Number(refs.fontWeight) || 400,
    paddingY: px(refs.paddingY), paddingX: px(refs.paddingX), height: px(refs.height), label: (refs.label ?? '').slice(0, 40),
    shadows: parseShadows(refs.shadow), outline: outline && outlineColor ? {width: Number(outline[1]), color: outlineColor, offset: Number(outline[3])} : null,
    underline: /underline/.test(refs.textDecoration ?? ''), opacity: Number.isFinite(Number(refs.opacity ?? 1)) ? Math.min(1, Math.max(0, Number(refs.opacity ?? 1))) : 1};
}
const STATE_ORDER: StateName[] = ['hover', 'focus-visible', 'active', 'disabled'];
const SCREENSHOT = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

export function buildDesignSystem(eds: ExtractedDesignSystem, scales: ScalesLike, name: string): DesignSystemDoc {
  const declared = declaredColorGroups(eds), notes: string[] = [];
  const palette = (scales.colors ?? []).filter(c => hexOf(c.hex)).slice(0, 24);
  const groups = declared.length ? declared : [
    {name: 'Neutrals', swatches: palette.filter(c => c.neutral).map((c, i) => ({name: String(i + 1), hex: hexOf(c.hex)!})), declared: false},
    {name: 'Colours', swatches: palette.filter(c => !c.neutral).map((c, i) => ({name: String(i + 1), hex: hexOf(c.hex)!})), declared: false},
  ].filter(g => g.swatches.length);
  if (!declared.length) notes.push('The site declares no colour variables, so colours are grouped from what the pages render, most used first.');
  const roleOf = (size: number) => scales.type?.sizes?.find(s => Math.round(s.px) === size)?.role ?? (size >= 24 ? 'display' : size >= 18 ? 'title' : size >= 15 ? 'body' : 'caption');
  const styles = (scales.textStyles ?? []).slice(0, 18).map(t => ({name: `${titleCase(roleOf(t.px))} / ${t.px} ${weightName(t.weight)}`, px: t.px, weight: t.weight, lineHeightPx: t.lineHeightPx, family: t.family, uses: t.count}));
  const components = eds.components.filter(c => c.variants.some(v => Object.keys(v.tokenRefs).length) || c.sizes.length).map(c => ({
    name: c.canonical, category: c.category, states: c.statesObserved, missing: c.statesMissing,
    variants: c.variants.filter(v => Object.keys(v.tokenRefs).length).map(v => ({name: titleCase(v.name), style: componentStyle(v.tokenRefs), uses: Number(v.tokenRefs.instances) || 0,
      states: STATE_ORDER.filter(st => v.states?.[st]).map(st => ({name: st, style: componentStyle({...v.tokenRefs, ...v.states![st]})})),
      ...(v.screenshot && SCREENSHOT.test(v.screenshot) ? {screenshot: v.screenshot} : {})})),
    sizes: Object.entries(c.sizeStyles ?? {}).map(([size, refs]) => ({name: size.toUpperCase(), style: componentStyle(refs)})),
  })).filter(c => c.variants.length);
  // A component whose every variant is transparent and unbordered has nothing to draw; list it instead.
  const drawable = (c: (typeof components)[number]) => c.variants.some(v => v.style.background || v.style.borderWidth);
  const alsoFound = [...components.filter(c => !drawable(c)), ...eds.components.filter(c => !components.some(d => d.name === c.canonical))].map(c => ({name: 'name' in c ? c.name : c.canonical, category: c.category}));
  notes.push('Component variants are named by appearance (filled, neutral, outline, plain) from computed styles on the rendered pages; check the names against how your team talks about them.');
  return {
    name, source: eds.sources.map(s => s.uri).filter(u => /^https:/.test(u)).join(', ') || eds.sources.map(s => s.label ?? s.uri).join(', '), generatedAt: new Date().toISOString(),
    colors: {groups, roles: (scales.roles ?? []).filter(r => hexOf(r.hex)).map(r => ({...r, hex: hexOf(r.hex)!}))},
    typography: {families: [...new Set([...(scales.type?.families ?? []), ...styles.map(s => s.family)].filter(Boolean))].slice(0, 4), styles},
    spacing: {base: scales.spacing?.baseUnit ?? null, steps: (scales.spacing?.steps ?? []).filter(n => n > 0 && n <= 128)},
    // Radii round to whole pixels (5.4px and 5px are one radius); shadows keep the eight most distinct.
    radius: [...new Map(eds.tokens.filter(t => t.path.startsWith('radius.')).map(t => Math.round(px(String(t.value)))).filter(n => n > 0).map(n => [n, n])).values()]
      .sort((a, b) => a - b).map(n => ({name: n >= 999 ? 'Full' : `${n}`, px: n})),
    shadows: eds.tokens.filter(t => t.path.startsWith('shadow.')).map(t => String(t.value)).filter(v => /^[\w\s#().,%-]+$/.test(v))
      .filter((v, i, all) => i === all.length - 1 || i % Math.ceil(all.length / 8) === 0).slice(0, 8).map((value, i) => ({name: `Shadow ${i + 1}`, value})),
    components: components.filter(drawable), alsoFound, notes,
  };
}

// ── Self-contained HTML (no scripts; fonts from Google Fonts only) ─────────
const esc = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const ink = (hex: string) => { const c = parseColor(hex)!; return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.6 ? '#111111' : '#ffffff'; };   // channels are 0–1
const family = (name: string) => `'${esc(name).replace(/'/g, '')}', 'Hanken Grotesk', system-ui, sans-serif`;

function specimen(style: ComponentStyle, fallbackLabel: string, typeface: string, textHex: string, surface: string) {
  const css = [`background:${style.background ?? 'transparent'}`, `color:${style.color ?? textHex}`, `border:${style.borderWidth}px solid ${style.border ?? 'transparent'}`,
    `border-radius:${style.radius}px`, `font-size:${style.fontSize || 14}px`, `font-weight:${style.fontWeight}`, `padding:${style.paddingY}px ${Math.min(style.paddingX, 48)}px`,
    `min-height:${Math.min(style.height, 64)}px`, `font-family:${typeface}`, `opacity:${style.opacity}`, `text-decoration:${style.underline ? 'underline' : 'none'}`,
    `box-shadow:${style.shadows.length ? style.shadows.map(sh => `${sh.inset ? 'inset ' : ''}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread}px ${sh.color}`).join(', ') : 'none'}`,
    style.outline ? `outline:${style.outline.width}px solid ${style.outline.color};outline-offset:${style.outline.offset}px` : 'outline:none'].join(';');
  // Same colour as the surface (or none) and no border: mark the bounds, as Figma shows a frame's edge.
  const invisible = !style.borderWidth && (!style.background || style.background === surface);
  return `<span class="specimen${invisible ? ' bounds' : ''}" style="${css}">${esc(style.label || fallbackLabel)}</span>`;
}

// `links` are added when GapScan serves the page; a shared copy has no app to link back to.
export function renderDesignSystemHtml(doc: DesignSystemDoc, links: {figmaExport?: string; reviewHref?: string} = {}): string {
  const typeface = doc.typography.families[0] ? family(doc.typography.families[0]) : "'Hanken Grotesk', system-ui, sans-serif";
  const frame = (label: string, body: string, wide = false) => `<figure class="frame${wide ? ' wide' : ''}"><figcaption>${esc(label)}</figcaption><div class="board">${body}</div></figure>`;
  const colorFrames = doc.colors.groups.map(g => frame(`Colour / ${g.name}`, `<div class="ramp">${g.swatches.map(s =>
    `<div class="swatch"><div class="chip" style="background:${s.hex};color:${ink(s.hex)}">${esc(s.name)}</div><div class="meta"><b>${esc(s.name)}</b><code>${s.hex.toUpperCase()}</code>${s.variable ? `<code class="var">${esc(s.variable)}</code>` : ''}</div></div>`).join('')}</div>`, g.swatches.length > 6)).join('');
  const roles = doc.colors.roles.length ? frame('Colour / Roles', `<div class="roles">${doc.colors.roles.map(r => `<div class="role"><i style="background:${r.hex}"></i><div><b>${esc(titleCase(r.role))}</b><code>${r.hex.toUpperCase()}</code><span>${esc(r.reason)}</span></div></div>`).join('')}</div>`, true) : '';
  const type = frame('Text styles', `<div class="types">${doc.typography.styles.map(t => `<div class="type"><div class="sample" style="font-family:${family(t.family)};font-size:${Math.min(t.px, 64)}px;font-weight:${t.weight};line-height:${t.lineHeightPx ? `${t.lineHeightPx}px` : 'normal'}">The quick brown fox jumps over the lazy dog</div><div class="tmeta"><b>${esc(t.name)}</b><code>${esc(t.family)} · ${t.px}/${t.lineHeightPx ?? '—'} · ${t.weight}</code><span>${t.uses.toLocaleString('en')} uses</span></div></div>`).join('') || '<p class="empty">No text styles were recorded.</p>'}</div>`, true);
  const spacing = frame(`Spacing${doc.spacing.base ? ` / ${doc.spacing.base}px grid` : ''}`, `<div class="spaces">${doc.spacing.steps.map(n => `<div class="space"><i style="width:${n}px"></i><code>${n}</code></div>`).join('')}</div>`);
  const radius = frame('Radius', `<div class="radii">${doc.radius.map(r => `<div class="radius"><i style="border-radius:${Math.min(r.px, 40)}px"></i><b>${esc(r.name)}</b><code>${r.px >= 999 ? 'full' : `${r.px}px`}</code></div>`).join('')}</div>`);
  const effects = frame('Effects', doc.shadows.length ? `<div class="radii">${doc.shadows.map(s => `<div class="radius"><i style="box-shadow:${esc(s.value)};border-radius:8px"></i><b>${esc(s.name)}</b><code>${esc(s.value)}</code></div>`).join('')}</div>` : '<p class="empty">No visible shadows were found.</p>');
  // Components sit on the site's own surface, the way they appear on its pages (and in a Figma frame).
  const surface = doc.colors.roles.find(r => r.role === 'surface')?.hex ?? '#ffffff', text = doc.colors.roles.find(r => r.role === 'text')?.hex ?? ink(surface);
  const STATE_LABEL: Record<string, string> = {hover: 'Hover', 'focus-visible': 'Focus', active: 'Pressed', disabled: 'Disabled'};
  // Each variant: the screenshot taken on the site (when small enough), the look drawn from its styles, then its captured states.
  const variantBlock = (c: DesignSystemDoc['components'][number], v: DesignSystemDoc['components'][number]['variants'][number]) => `<div class="variant-row">
    <div class="variant"><b>${esc(v.name)}</b><span>${v.uses.toLocaleString('en')} on the pages read</span></div>
    ${v.screenshot ? `<figure class="shot"><img src="${v.screenshot}" alt="${esc(v.name)} ${esc(c.name)} as captured on the site"><figcaption>Captured</figcaption></figure>` : ''}
    <figure class="shot">${specimen(v.style, c.name, typeface, text, surface)}<figcaption>Default</figcaption></figure>
    ${v.states.map(st => `<figure class="shot">${specimen(st.style, c.name, typeface, text, surface)}<figcaption>${STATE_LABEL[st.name]}</figcaption></figure>`).join('')}</div>`;
  const components = doc.components.map((c, i) => frame(`${c.name}`, `<div class="variant-rows">${c.variants.map(v => variantBlock(c, v)).join('')}</div>${c.sizes.length ? `<div class="sizes"><span class="label">Sizes</span>${c.sizes.map(s => `<div class="variant">${specimen(s.style, s.name, typeface, text, surface)}<b>${esc(s.name)} · ${s.style.height}px</b></div>`).join('')}</div>` : ''}${c.states.length || c.missing.length ? `<p class="states">${c.states.length ? `States with a visible style: ${c.states.map(esc).join(', ')}` : ''}${c.missing.length ? `<em>No visible style found for: ${c.missing.map(esc).join(', ')}</em>` : ''}</p>` : ''}`, true).replace('<figure class="frame wide">', `<figure class="frame wide" id="c${i}">`).replace('<div class="board">', `<div class="board site" style="background:${surface};color:${text}">`)).join('');
  const families = doc.typography.families.map(f => f.replace(/[^\w -]/g, '')).filter(Boolean);
  const count = doc.colors.groups.reduce((n, g) => n + g.swatches.length, 0);
  return `<title>${esc(doc.name)} design system</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: a Figma library file. Page list on the left, a quiet canvas, each foundation and component in a labelled frame. */
:root { --canvas: #eceef1; --frame: #ffffff; --fg: #1d2129; --muted: #5d6573; --line: #d6dae0; --accent: #3b5bdb; --sidebar: #f7f8fa;
  --ui: 'Hanken Grotesk', system-ui, sans-serif; --mono: 'JetBrains Mono', ui-monospace, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --canvas: #1b1d21; --frame: #25282e; --fg: #e8eaee; --muted: #a0a7b3; --line: #3a3f47; --accent: #8ea6ff; --sidebar: #202328; color-scheme: dark } }
:root[data-theme="dark"] { --canvas: #1b1d21; --frame: #25282e; --fg: #e8eaee; --muted: #a0a7b3; --line: #3a3f47; --accent: #8ea6ff; --sidebar: #202328; color-scheme: dark }
* { box-sizing: border-box }
body { background: var(--canvas); color: var(--fg); font: 14px/1.5 var(--ui); margin: 0 }
.app { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100vh }
nav { background: var(--sidebar); border-right: 1px solid var(--line); padding: 20px 14px; position: sticky; top: env(safe-area-inset-top, 0px); align-self: start; height: 100vh; overflow: auto }
nav .file { font-weight: 600; margin: 0 0 2px } nav .src { color: var(--muted); font-size: 12px; word-break: break-all; margin: 0 0 18px }
nav h2 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 16px 0 6px; font-weight: 600 }
nav a { display: block; color: var(--fg); text-decoration: none; padding: 5px 8px; border-radius: 6px; font-size: 13px }
nav a:hover, nav a:focus-visible { background: var(--line); outline: none }
nav a.export { color: var(--accent); font-weight: 600 }
main { padding-block: 32px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); min-width: 0 }
.page { max-width: 1180px; margin: 0 auto; display: grid; gap: 40px }
.cover { background: var(--frame); border: 1px solid var(--line); border-radius: 4px; padding: 36px; display: grid; gap: 8px }
.cover h1 { margin: 0; font-size: clamp(28px, 4vw, 44px); line-height: 1.1; text-wrap: balance; font-family: ${typeface} }
.cover p { margin: 0; color: var(--muted); max-width: 65ch } .facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 12px; font-variant-numeric: tabular-nums }
.facts b { font-size: 20px; display: block } .facts span { color: var(--muted); font-size: 12px }
section { display: grid; gap: 20px; scroll-margin-top: 16px } section > h2 { margin: 0; font-size: 20px; font-weight: 600 }
.frames { display: flex; flex-wrap: wrap; gap: 28px 24px; align-items: flex-start }
.frame { margin: 0; min-width: 0; flex: 0 1 auto; max-width: 100%; scroll-margin-top: 16px } .frame.wide { flex-basis: 100% }
figcaption { font-size: 12px; color: var(--muted); margin: 0 0 6px; font-family: var(--mono) }
.board { background: var(--frame); border: 1px solid var(--line); border-radius: 2px; padding: 20px; overflow-x: auto }
code { font-family: var(--mono); font-size: 11.5px; color: var(--muted) }
.ramp { display: flex; flex-wrap: wrap; gap: 12px } .swatch { width: 112px; display: grid; gap: 6px }
.chip { height: 72px; border-radius: 6px; display: flex; align-items: flex-end; padding: 6px 8px; font-size: 11px; font-family: var(--mono); box-shadow: inset 0 0 0 1px rgba(127,127,127,.18) }
.meta { display: grid; gap: 1px; min-width: 0 } .meta b { font-size: 12.5px } .meta code { overflow-wrap: anywhere } .var { opacity: .8 }
.roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px } .role { display: flex; gap: 10px; align-items: flex-start }
.role i { width: 40px; height: 40px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 1px rgba(127,127,127,.25) } .role div { display: grid; min-width: 0 } .role span { color: var(--muted); font-size: 12px }
.types { display: grid; gap: 4px } .type { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line) }
.type:last-child { border: 0 } .sample { overflow: hidden; text-overflow: ellipsis; white-space: nowrap } .tmeta { display: grid } .tmeta span { color: var(--muted); font-size: 12px }
.spaces { display: grid; gap: 8px; min-width: 260px } .space { display: flex; align-items: center; gap: 12px } .space i { height: 16px; background: var(--accent); opacity: .75; border-radius: 2px; flex: none }
.radii { display: flex; flex-wrap: wrap; gap: 20px } .radius { display: grid; gap: 4px; justify-items: start; max-width: 200px } .radius i { width: 72px; height: 72px; background: var(--canvas); border: 1px solid var(--line) }
.variants, .sizes { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-end } .sizes { margin-top: 20px; padding-top: 16px; border-top: 1px dashed var(--line) }
.variant { display: grid; gap: 6px; justify-items: start } .variant span { color: var(--muted); font-size: 12px }
.site .variant span, .site .states, .site .label { color: inherit; opacity: .65 } .site .states em { color: inherit; opacity: 1 } .site .sizes { border-top-color: currentColor } .label { width: 100%; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted) }
.variant-rows { display: grid; gap: 18px } .variant-row { display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: flex-end }
.variant-row > .variant { width: 140px } .shot { margin: 0; display: grid; gap: 6px; justify-items: start } .shot img { max-width: 240px; height: auto; display: block; image-rendering: auto }
.shot figcaption { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: inherit; opacity: .6; font-family: var(--ui) }
.specimen.bounds { outline: 1px dashed rgba(127,127,127,.55); outline-offset: 0 }
.specimen { display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; max-width: 320px; overflow: hidden }
.states { margin: 16px 0 0; color: var(--muted); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 4px 16px } .states em { font-style: normal; color: var(--fg) }
.notes { color: var(--muted); font-size: 12.5px; max-width: 75ch; display: grid; gap: 4px } .empty { color: var(--muted); margin: 0 }
@media (max-width: 760px) { .app { grid-template-columns: 1fr } nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)) } .type { grid-template-columns: 1fr } }
</style>
<div class="app">
<nav aria-label="Pages">
  <p class="file">${esc(doc.name)}</p><p class="src">${esc(doc.source)}</p>
  <h2>Foundations</h2><a href="#colours">Colours</a><a href="#typography">Typography</a><a href="#spacing">Spacing &amp; radius</a><a href="#effects">Effects</a>
  <h2>Components</h2>${doc.components.map((c, i) => `<a href="#c${i}">${esc(c.name)}</a>`).join('')}
  ${links.figmaExport ? `<h2>Figma</h2><a class="export" href="${esc(links.figmaExport)}" download>Export to Figma</a>${links.reviewHref ? `<a href="${esc(links.reviewHref)}">How to import</a>` : ''}` : ''}
</nav>
<main><div class="page">
  <header class="cover"><h1>${esc(doc.name)}</h1><p>Design system extracted from ${esc(doc.source)} by GapScan. Values come from the site's own stylesheets and the styles its pages render.</p>
    <div class="facts"><div><b>${count}</b><span>colours</span></div><div><b>${doc.typography.styles.length}</b><span>text styles</span></div><div><b>${doc.spacing.steps.length}</b><span>spacing steps</span></div><div><b>${doc.components.length}</b><span>components</span></div><div><b>${esc(families.join(', ') || '—')}</b><span>typefaces</span></div></div></header>
  <section id="colours"><h2>Colours</h2><div class="frames">${roles}${colorFrames}</div></section>
  <section id="typography"><h2>Typography</h2><div class="frames">${type}</div></section>
  <section id="spacing"><h2>Spacing &amp; radius</h2><div class="frames">${spacing}${radius}</div></section>
  <section id="effects"><h2>Effects</h2><div class="frames">${effects}</div></section>
  <section id="components"><h2>Components</h2><div class="frames">${components || '<p class="empty">No components with visible variants were found.</p>'}${doc.alsoFound.length ? frame('Also found', `<p class="empty">These have no visual style of their own (transparent, no border), so there is nothing to draw: ${doc.alsoFound.map(c => esc(c.name)).join(', ')}.</p>`, true) : ''}</div></section>
  <div class="notes">${doc.notes.map(n => `<p class="empty">${esc(n)}</p>`).join('')}<p class="empty">Generated ${esc(doc.generatedAt.slice(0, 10))}. Typefaces the site licenses${families.length ? ` (${esc(families.join(', '))})` : ''} are not embedded; text falls back to a similar sans.</p></div>
</div></main>
</div>`;
}
