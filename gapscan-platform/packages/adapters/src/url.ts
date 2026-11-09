// Rendered-website adapter (architecture Part 1 §1.3) using headless Chromium.
// Reads *computed* styles of visible elements at several viewports and in dark
// mode, CSS custom properties, and repeated interactive structures. Every
// request is checked against the public-URL policy; downloads are blocked.
import type {Adapter, Observation, VariantStates, VariantStyle} from './types.ts';
import {AdapterError} from './types.ts';
import {EGRESS_CHROMIUM_ARGS, startEgressProxy} from './egress.ts';
import type {EgressResolver} from './egress.ts';
import type {PageRecord, SavedStyle, SiteMemory} from './site-memory.ts';

export type UrlAdapterOptions = {
  maxPages?: number; viewports?: number[]; timeoutMs?: number;
  // Decides which hosts the browser may contact. The API passes its public-URL check.
  allowUrl: (url: URL) => boolean | Promise<boolean>;
  // Resolves and vets each host for the egress proxy, which pins the browser to those addresses.
  // Without it the browser resolves names itself and only the per-request check applies.
  egress?: EgressResolver;
  // Saved websites: reuse pages already read and continue an unfinished crawl.
  memory?: SiteMemory;
  // Most pages kept for one site across imports. Once reached, imports reuse the saved pages
  // without reading more (sites with hundreds of similar pages would otherwise never settle).
  maxSitePages?: number;
};

// Runs inside the page. Kept as a string so the server build needs no DOM types.
// Reads how one element looks. Shared by the collecting pass and the forced-state pass so the
// two always measure the same properties.
const STYLE_OF = String.raw`(el => {
  const cs = getComputedStyle(el), box = el.getBoundingClientRect();
  const clear = v => !v || v === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(v);
  const bordered = parseFloat(cs.borderTopWidth) > 0 && !clear(cs.borderTopColor);
  return {background: clear(cs.backgroundColor) ? 'transparent' : cs.backgroundColor, color: cs.color, border: bordered ? cs.borderTopWidth + ' ' + cs.borderTopColor : 'none',
    radius: cs.borderTopLeftRadius, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
    paddingY: cs.paddingTop, paddingX: cs.paddingLeft, height: Math.round(box.height) + 'px', width: Math.round(box.width) + 'px', shadow: cs.boxShadow,
    outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? cs.outlineWidth + ' ' + cs.outlineColor + ' ' + cs.outlineOffset : 'none',
    opacity: cs.opacity, textDecoration: cs.textDecorationLine};
})`;

const COLLECT = String.raw`(() => {
  const STYLE_OF = ${STYLE_OF};
  const MAX = 4000, out = {colors: {}, fonts: {}, spacing: {}, radius: {}, shadow: {}, vars: {}, components: {}, selectors: [], pairs: {}};
  const bump = (bucket, key, extra) => { const e = bucket[key] || (bucket[key] = {count: 0, ...extra}); e.count++; return e; };
  const label = el => el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '') + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '');
  const visible = (el, cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && el.getClientRects().length > 0;
  const transparent = v => !v || v === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(v);
  // The colour actually behind an element's text: the nearest ancestor with an opaque background.
  // Returns null when an image, gradient or translucent layer sits behind the text: those cannot be
  // measured from computed colours, so they are left for a manual or screenshot-based check.
  // Text whose centre sits over an image, video or canvas (e.g. card overlays) is likewise unmeasurable.
  const media = [...document.querySelectorAll('img, video, canvas, picture, iframe, svg')].filter(m => m.tagName !== 'svg' || m.getBoundingClientRect().width >= 48).map(m => m.getBoundingClientRect()).filter(r => r.width > 8 && r.height > 8);
  const overMedia = el => { const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return media.some(m => x >= m.left && x <= m.right && y >= m.top && y <= m.bottom); };
  const behind = el => { if (overMedia(el)) return null; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e), bg = s.backgroundColor;
    if (s.backgroundImage && s.backgroundImage !== 'none') return null;
    for (const pseudo of ['::before', '::after']) { const ps = getComputedStyle(e, pseudo);
      if (ps.content !== 'none' && ps.content !== 'normal' && ((ps.backgroundImage && ps.backgroundImage !== 'none') || !transparent(ps.backgroundColor))) return null; }
    if (transparent(bg)) continue;
    if (/rgba\([^)]*,\s*0?\.\d+\)$/.test(bg)) return null;
    return bg; } return 'rgb(255, 255, 255)'; };
  let n = 0;
  for (const el of document.body ? [document.body, ...document.body.querySelectorAll('*')] : []) {
    if (n++ > MAX) break;
    const cs = getComputedStyle(el);
    if (!visible(el, cs) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|path)$/i.test(el.tagName)) continue;
    const sel = label(el), hasText = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
    if (hasText) {
      bump(out.colors, cs.color + '|color|' + sel, {value: cs.color, property: 'color', selector: sel});
      bump(out.fonts, [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.lineHeight].join('|'), {family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, selector: sel});
      const bg = behind(el), size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700), box = el.getBoundingClientRect();
      // Screen-reader-only text (1px boxes, clipped) is not visible, so it has no contrast to check.
      const clipped = box.width <= 2 || box.height <= 2 || (cs.clip && cs.clip !== 'auto') || /inset\(50%\)/.test(cs.clipPath);
      if (+cs.opacity === 1 && !clipped && bg) bump(out.pairs, cs.color + '|' + bg + '|' + sel, {foreground: cs.color, background: bg, selector: sel, large});
    }
    if (!transparent(cs.backgroundColor)) bump(out.colors, cs.backgroundColor + '|background-color|' + sel, {value: cs.backgroundColor, property: 'background-color', selector: sel});
    if (parseFloat(cs.borderTopWidth) > 0 && !transparent(cs.borderTopColor)) bump(out.colors, cs.borderTopColor + '|border-color|' + sel, {value: cs.borderTopColor, property: 'border-color', selector: sel});
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) { const v = cs[p]; if (v && v !== '0px' && v !== 'normal' && !v.startsWith('-')) bump(out.spacing, v); }
    if (cs.borderTopLeftRadius !== '0px') bump(out.radius, cs.borderTopLeftRadius);
    if (cs.boxShadow !== 'none') bump(out.shadow, cs.boxShadow);
    const role = el.getAttribute('role'), tag = el.tagName.toLowerCase();
    const kind = tag === 'button' || role === 'button' || (tag === 'a' && /btn|button/i.test(el.className)) ? 'Button'
      : tag === 'input' && !/hidden|submit|button|checkbox|radio/.test(el.type) ? 'Text field' : tag === 'textarea' ? 'Text area' : tag === 'select' ? 'Select'
      : tag === 'input' && el.type === 'checkbox' ? 'Checkbox' : tag === 'input' && el.type === 'radio' ? 'Radio'
      : role === 'tab' ? 'Tabs' : tag === 'nav' ? 'Navigation' : tag === 'dialog' || role === 'dialog' ? 'Dialog' : tag === 'table' ? 'Table'
      : /\bcard\b/i.test(el.className) ? 'Card' : /\b(alert|banner)\b/i.test(el.className) || role === 'alert' ? 'Alert' : /\bbadge\b/i.test(el.className) ? 'Badge' : null;
    // Component names that builds leave in class names: styled-components (ArtistTile__Label-sc-1w4yhde-4),
    // CSS modules (Button_root__a1B2c) and Emotion labels (css-1x2y3z-Card). Only a component's root counts.
    let named = null;
    for (const cls of el.classList) {
      const m = cls.match(/^([A-Z][A-Za-z0-9]+)(?:__([A-Za-z0-9]+))?-sc-[a-z0-9]+-\d+$/) || cls.match(/^([A-Za-z][A-Za-z0-9-]*?)(?:-module)?_+([a-zA-Z0-9]+)__[\w-]{5,}$/) || cls.match(/^css-[a-z0-9]+-([A-Z][A-Za-z0-9]+)$/);
      // CSS-module file names are often lowercase or kebab-case (button_base__BjwbK, nav-bar_root__x1y2z).
      if (m && (!m[2] || /^(root|Root|container|Container|wrapper|Wrapper|base|Base)$/.test(m[2]))) { named = m[1].replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase()); break; }
    }
    for (const name of [kind, named && named !== kind ? named : null]) {
      if (!name) continue;
      const c = out.components[name] || (out.components[name] = {count: 0, classes: [], html: el.outerHTML.slice(0, 2000), named: name === named, styles: {}});
      c.count++; for (const cls of el.classList) if (c.classes.length < 30 && !c.classes.includes(cls)) c.classes.push(cls);
      // Visual signature: instances that look the same are one variant.
      const style = STYLE_OF(el), disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      // Disabled instances are a state of a variant, not a variant of their own.
      const key = (disabled ? 'disabled|' : '') + [style.background, style.color, style.border, style.radius, style.fontSize, style.fontWeight, style.paddingY, style.paddingX].join('|');
      let v = c.styles[key];
      if (!v && Object.keys(c.styles).length < 12) {
        // The representative element is tagged so states and a screenshot can be taken of it after this pass.
        const ref = 'gs' + (window.__gapscanRef = (window.__gapscanRef || 0) + 1);
        el.setAttribute('data-gapscan-ref', ref);
        v = c.styles[key] = {count: 0, style, disabled, ref, html: el.outerHTML.slice(0, 1500), text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 40)};
      }
      if (v) v.count++;
    }
  }
  const root = getComputedStyle(document.documentElement);
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = list => { for (const r of list) {
      if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
      if (!r.selectorText) continue;
      if (out.selectors.length < 20000) out.selectors.push(r.selectorText);
      for (let i = 0; i < (r.style ? r.style.length : 0); i++) { const name = r.style[i]; if (name.startsWith('--') && !(name in out.vars)) out.vars[name] = (root.getPropertyValue(name) || r.style.getPropertyValue(name)).trim(); }
    } };
    walk(rules);
  }
  const links = [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h.startsWith(location.origin)).map(h => h.split('#')[0]);
  return {...out, links: [...new Set(links)].slice(0, 200), title: document.title};
})()`;

type Collected = {
  pairs: Record<string, {count: number; foreground: string; background: string; selector: string; large: boolean}>;
  colors: Record<string, {count: number; value: string; property: string; selector: string}>;
  fonts: Record<string, {count: number; family: string; size: string; weight: string; lineHeight: string; selector: string}>;
  spacing: Record<string, {count: number}>; radius: Record<string, {count: number}>; shadow: Record<string, {count: number}>;
  vars: Record<string, string>; selectors: string[]; links: string[]; title: string;
  components: Record<string, {count: number; classes: string[]; html: string; named: boolean; styles: Record<string, CollectedStyle>}>;
};

const STRUCTURAL = /(Wrapper|Container|Layout|Inner|Outer|Content|Section|Box|Flex|Spacer|Row|Column|Col|Grid|Page|Root|Main|Body|Holder|Area)s?$/;
const title = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ' ' + c.toLowerCase());

// Names a component's looks the way a design library would: filled (by use: primary first), neutral,
// outline and plain appearances, and sm/md/lg sizes when instances come in distinct heights.
function rgb(value: string): [number, number, number] | null {
  const m = value.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const saturation = (value: string) => { const c = rgb(value); if (!c) return 0; const max = Math.max(...c), min = Math.min(...c); return max === 0 ? 0 : (max - min) / max; };
const hueOf = (value: string) => { const c = rgb(value); if (!c) return 0; const [r, g, b] = c.map(x => x / 255) as [number, number, number], max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 0; const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
type Look = {count: number; style: VariantStyle; html: string; text: string; disabled?: boolean; states?: VariantStates; screenshot?: string};
export function describeVariants(kind: string, styles: Look[]) {
  const ranked = [...styles].filter(s => !s.disabled).sort((a, b) => b.count - a.count), disabledLooks = styles.filter(s => s.disabled);
  const appearance = (s: VariantStyle) => s.background === 'transparent' ? (s.border !== 'none' ? 'outline' : kind === 'Button' ? 'ghost' : 'plain')
    : saturation(s.background) > 0.25 ? 'filled' : 'neutral';
  const named = new Map<string, (typeof ranked)[number]>();
  let filled = 0;
  for (const v of ranked) {
    let name = appearance(v.style);
    if (name === 'filled') { const hue = hueOf(v.style.background); name = filled++ === 0 ? 'primary' : hue < 20 || hue > 335 ? 'danger' : hue > 80 && hue < 170 ? 'success' : hue > 30 && hue < 60 ? 'warning' : `filled ${filled}`; }
    else if (name === 'neutral') name = 'secondary';
    if (!named.has(name)) named.set(name, v);
  }
  const heights = [...new Set(ranked.filter(v => v.count >= 2 || ranked.length === 1).map(v => Math.round(parseFloat(v.style.height) / 4) * 4))].filter(h => h > 0).sort((a, b) => a - b);
  const SIZE_NAMES = heights.length === 2 ? ['sm', 'md'] : ['sm', 'md', 'lg', 'xl'];
  const sizes = heights.length >= 2 && heights.length <= 4 ? heights.map((h, i) => ({name: SIZE_NAMES[i]!, height: h})) : [];
  const sizeStyles = sizes.map(size => { const v = ranked.find(r => Math.round(parseFloat(r.style.height) / 4) * 4 === size.height)!; return {name: `size=${size.name}`, style: v.style, count: v.count, html: v.html, text: v.text}; });
  const appearances = [...named].slice(0, 6).map(([name, v]) => ({name, style: v.style, count: v.count, html: v.html, text: v.text,
    states: {...(v.states ?? {})} as VariantStates, ...(v.screenshot ? {screenshot: v.screenshot} : {})}));
  // A disabled instance is the disabled state of the appearance it shares a shape with (same radius and height).
  for (const d of disabledLooks) {
    const owner = appearances.find(a => a.style.radius === d.style.radius && a.style.height === d.style.height) ?? appearances[0];
    const changes = owner ? styleChanges(owner.style, d.style) : {};
    if (owner && Object.keys(changes).length && !owner.states.disabled) owner.states.disabled = changes;
  }
  const variantStyles = [...appearances.map(a => Object.keys(a.states).length ? a : (({states: _s, ...rest}) => rest)(a)), ...sizeStyles];
  return {variants: variantStyles.map(v => v.name), variantStyles};
}

type CollectedStyle = SavedStyle;
// At most this many variants per extraction get forced states and a screenshot (each takes a few round trips).
export const CAPTURE_LIMIT = 48;
const STATE_FIELDS = ['background', 'color', 'border', 'radius', 'shadow', 'outline', 'opacity', 'textDecoration'] as const;
export function styleChanges(base: VariantStyle, after: VariantStyle): Partial<VariantStyle> {
  return Object.fromEntries(STATE_FIELDS.filter(f => after[f] !== undefined && after[f] !== base[f]).map(f => [f, after[f]]));
}
// Forces :hover, :focus-visible and :active on each tagged element (Chromium DevTools protocol), keeps
// only what changes, then screenshots the element at rest. Large elements (panels, cards) get no screenshot.
async function captureVariants(page: import('playwright').Page, looks: CollectedStyle[]) {
  const out = new Map<string, {states: VariantStates; screenshot?: string}>();
  if (!looks.length) return out;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const {root} = await cdp.send('DOM.getDocument', {depth: 0});
    for (const look of looks) {
      if (!/^gs\d+$/.test(look.ref)) continue;
      const selector = `[data-gapscan-ref="${look.ref}"]`;
      const {nodeId} = await cdp.send('DOM.querySelector', {nodeId: root.nodeId, selector});
      if (!nodeId) continue;
      const states: VariantStates = {};
      // Focus only means something on elements that can take keyboard focus; forcing it on a card
      // or header just draws the browser's own ring, which says nothing about the site's styling.
      const focusable = await page.evaluate(`(el => !!el && el.matches('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'))(document.querySelector('${selector}'))`) as boolean;
      for (const state of (focusable ? ['hover', 'focus-visible', 'active'] : ['hover', 'active']) as ('hover' | 'focus-visible' | 'active')[]) {
        await cdp.send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: state === 'focus-visible' ? ['focus', 'focus-visible'] : [state]});
        const after = await page.evaluate(`(${STYLE_OF})(document.querySelector('${selector}'))`) as VariantStyle;
        const changes = styleChanges(look.style, after);
        if (Object.keys(changes).length) states[state] = changes;
      }
      await cdp.send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: []});
      const width = parseFloat(look.style.width), height = parseFloat(look.style.height);
      let screenshot: string | undefined;
      // Images inside the element must have loaded (lazy images otherwise shoot as black boxes).
      const imagesReady = await page.evaluate(`(async el => { const imgs = el ? [...el.querySelectorAll('img')] : [];
        el?.scrollIntoView({block: 'center'});
        await Promise.all(imgs.map(i => i.complete && i.naturalWidth ? 0 : new Promise(r => { i.loading = 'eager'; i.addEventListener('load', r, {once: true}); i.addEventListener('error', r, {once: true}); setTimeout(r, 1500); })));
        return imgs.every(i => i.complete && i.naturalWidth > 0); })(document.querySelector('${selector}'))`).catch(() => false) as boolean;
      if (imagesReady && width > 0 && height > 0 && width <= 480 && height <= 240)
        screenshot = 'data:image/png;base64,' + (await page.locator(selector).first().screenshot({timeout: 3000, animations: 'disabled'}).catch(() => null))?.toString('base64');
      out.set(look.ref, {states, ...(screenshot && !screenshot.endsWith('undefined') ? {screenshot} : {})});
    }
  } finally { await cdp.detach().catch(() => undefined); }
  return out;
}

const STATES = ['hover', 'focus-visible', 'focus', 'active', 'disabled'] as const;
const statesFor = (kind: string, classes: string[], selectors: string[]) => {
  const subjects = [...classes.map(c => '.' + c.replace(/[^\w-]/g, '')), ...(kind === 'Button' ? ['button'] : kind === 'Text field' ? ['input'] : kind === 'Select' ? ['select'] : [])];
  return STATES.filter(state => selectors.some(sel => subjects.some(subject => sel.includes(subject) && new RegExp(`:${state}(?![\\w-])`).test(sel))
    || (state === 'disabled' && subjects.some(subject => sel.includes(subject) && /\[disabled\]|\[aria-disabled/.test(sel)))));
};

// Crawl near the start page: same-origin links that share its path prefix come first,
// and links into a different version (/docs/5.2/ vs /docs/5.3/) are skipped.
const segments = (url: URL) => url.pathname.split('/').filter(Boolean);
const VERSION = /^v?\d+(\.\d+)+$/;
export function sharedPrefix(start: URL, link: URL): number {
  const a = segments(start), b = segments(link);
  let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
export function sameSection(start: URL, link: URL): boolean {
  if (link.origin !== start.origin) return false;
  const a = segments(start), b = segments(link);
  return a.every((segment, i) => !VERSION.test(segment) || b[i] === undefined || b[i] === segment);
}

export function createUrlAdapter(options: UrlAdapterOptions): Adapter {
  const {maxPages = 8, maxSitePages = 24, viewports = [1440, 768, 375], timeoutMs = 20_000, allowUrl, egress, memory} = options;
  return async ({uri}, {signal, progress, refresh}) => {
    const start = new URL(uri);
    if (!(await allowUrl(start))) throw new AdapterError('Only public HTTPS websites can be rendered.');

    // A saved site is reused and its crawl continued, unless a fresh read was asked for.
    const saved = memory && !refresh ? await memory.load(start.href) : null;
    const records: PageRecord[] = [...(saved?.pages ?? [])], reused = records.length;
    const queue = saved ? [...saved.state.queue] : [start.href], seen = new Set<string>(saved?.state.seen ?? []);
    const failed: {locator: string; reason: string}[] = saved ? [...saved.state.failed] : [];
    const startedAt = saved?.state.startedAt ?? new Date().toISOString();
    const full = records.length >= maxSitePages;
    if (saved && records.length) await progress?.(`reusing ${records.length} saved page${records.length === 1 ? '' : 's'} (first read ${saved.state.startedAt.slice(0, 10)})` +
      (full ? `; that is the most kept for one site, so no more are read` : queue.length ? `; continuing with ${queue.length} page${queue.length === 1 ? '' : 's'} not read yet` : '; nothing left to read'));

    const observations: Observation[] = [], themes = new Set<string>(['light']), selectors = new Set<string>();
    const components = new Map<string, {count: number; classes: Set<string>; html: string; locator: string; named: boolean; styles: Map<string, CollectedStyle>}>();
    const apply = (record: PageRecord) => {
      observations.push(...record.observations);
      if (record.dark) themes.add('dark');
      for (const selector of record.selectors) selectors.add(selector);
      for (const [kind, c] of Object.entries(record.components)) {
        const entry = components.get(kind) ?? {count: 0, classes: new Set<string>(), html: c.html, locator: record.landed, named: c.named, styles: new Map()};
        entry.count += c.count; c.classes.forEach(cls => entry.classes.add(cls)); components.set(kind, entry);
        for (const [key, v] of Object.entries(c.styles)) { const seenStyle = entry.styles.get(key); if (seenStyle) seenStyle.count += v.count; else entry.styles.set(key, {...v}); }
      }
    };
    records.forEach(apply);
    const enqueue = async (links: string[]) => {
      for (const link of links) if (!seen.has(link) && !queue.includes(link) && sameSection(start, new URL(link)) && await allowUrl(new URL(link))) queue.push(link);
      queue.sort((a, b) => sharedPrefix(start, new URL(b)) - sharedPrefix(start, new URL(a)));
    };
    const remember = async () => memory?.saveState(start.href, {version: '', start: '', startedAt, updatedAt: '', done: records.map(r => r.url), seen: [...seen], queue, failed});

    let browser: import('playwright').Browser | null = null, proxy: Awaited<ReturnType<typeof startEgressProxy>> | null = null, context: import('playwright').BrowserContext | null = null;
    const abort = () => { void browser?.close(); };
    signal.addEventListener('abort', abort, {once: true});
    let readNow = 0;
    const captureBudget = {left: CAPTURE_LIMIT};
    try {
      // Pages are read in queue order; the page being read stays queued until it is saved, so a stop
      // at any moment loses nothing. The page budget applies to new pages in this run.
      while (queue.length && readNow < maxPages && records.length < maxSitePages) {
        signal.throwIfAborted();
        const href = queue[0]!;
        if (seen.has(href)) { queue.shift(); continue; }
        if (!context) {
          let playwright: typeof import('playwright');
          try { playwright = await import('playwright'); }
          catch { throw new AdapterError('Website rendering needs Playwright on the server (npm install playwright && npx playwright install chromium).'); }
          proxy = egress ? await startEgressProxy({resolve: egress}) : null;
          browser = await playwright.chromium.launch({headless: true, args: ['--disable-dev-shm-usage', ...(proxy ? EGRESS_CHROMIUM_ARGS : [])], ...(proxy ? {proxy: proxy.launchProxy} : {})});
          context = await browser.newContext({acceptDownloads: false, javaScriptEnabled: true, serviceWorkers: 'block', userAgent: 'GapScan/1.0 (design-system extraction)'});
          await context.route('**/*', async route => {
            let url: URL;
            try { url = new URL(route.request().url()); } catch { return route.abort(); }
            if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
            if (['media', 'websocket', 'eventsource'].includes(route.request().resourceType()) || !(await allowUrl(url))) return route.abort();
            return route.continue();
          });
        }
        const page = await context.newPage();
        let record: PageRecord | null = null;
        try {
          record = await readPage(page, href, records.length === 0);
          if (record) {
            seen.add(href); seen.add(record.landed);
            records.push(record); apply(record); readNow++;
            await memory?.savePage(start.href, record);
            await enqueue(record.links);
            await progress?.(`rendered ${record.landed} (${readNow}/${maxPages} new${records.length > readNow ? `, ${records.length} in all` : ''})`);
          } else seen.add(href);   // a redirect landed on a page already read
        } catch (error) {
          if (signal.aborted) throw error;
          seen.add(href);
          failed.push({locator: href, reason: error instanceof Error ? error.message.split('\n')[0]! : 'Page failed to render.'});
        } finally { await page.close().catch(() => undefined); }
        if (queue[0] === href) queue.shift();
        await remember();
      }
      if (!readNow && memory) await remember();
    } finally {
      signal.removeEventListener('abort', abort);
      await browser?.close().catch(() => undefined);
      await proxy?.close();
    }

    // Renders one page (every viewport and dark mode for the first page, desktop for the rest) into a record.
    async function readPage(page: import('playwright').Page, href: string, first: boolean): Promise<PageRecord | null> {
      const passes = first ? [...viewports.map(width => ({width, scheme: 'light' as const})), {width: viewports[0]!, scheme: 'dark' as const}] : [{width: viewports[0]!, scheme: 'light' as const}];
      const record: PageRecord = {url: href, landed: href, readAt: new Date().toISOString(), dark: false, observations: [], components: {}, selectors: [], links: []};
      for (const pass of passes) {
        await page.setViewportSize({width: pass.width, height: 900});
        await page.emulateMedia({colorScheme: pass.scheme});
        if (pass === passes[0]) {
          const response = await page.goto(href, {waitUntil: 'domcontentloaded', timeout: timeoutMs});
          if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status() ?? 'error'}`);
          if (!(await allowUrl(new URL(page.url())))) throw new Error('Redirected to a non-public address.');
          record.landed = page.url().split('#')[0]!;
          if (record.landed !== href && seen.has(record.landed)) return null;
          await page.waitForLoadState('networkidle', {timeout: 5000}).catch(() => undefined);
          // Freeze transitions so a theme or viewport switch is measured at its end state, not mid-fade.
          await page.addStyleTag({content: '*,*::before,*::after{transition:none!important;animation:none!important}'}).catch(() => undefined);
        } else await page.waitForTimeout(300);
        const data = await page.evaluate(COLLECT) as Collected, locator = `${page.url()} @${pass.width}px${pass.scheme === 'dark' ? ' dark' : ''}`;
        if (pass.scheme === 'dark') {
          // Only record dark mode when the page actually changes colours for it.
          const lightValues = new Set(record.observations.flatMap(o => o.type === 'color' ? [o.value] : []));
          if (Object.values(data.colors).some(c => !lightValues.has(c.value))) record.dark = true; else continue;
        }
        const channel = 'observed_css' as const, rendered = true, out = record.observations;
        for (const c of Object.values(data.colors)) out.push({type: 'color', channel, rendered, value: c.value, property: c.property, selector: c.selector, count: c.count, locator});
        for (const f of Object.values(data.fonts)) out.push({type: 'font', channel, rendered, family: f.family, size: f.size, weight: f.weight, lineHeight: f.lineHeight, selector: f.selector, count: f.count, locator});
        for (const [value, {count}] of Object.entries(data.spacing)) out.push({type: 'spacing', channel, value, count, locator});
        for (const [value, {count}] of Object.entries(data.radius)) out.push({type: 'radius', channel, value, count, locator});
        for (const [value, {count}] of Object.entries(data.shadow)) out.push({type: 'shadow', channel, value, count, locator});
        for (const p of Object.values(data.pairs)) out.push({type: 'contrast', channel, rendered, foreground: p.foreground, background: p.background, selector: p.selector, large: p.large, count: p.count, locator});
        if (pass === passes[0]) {
          for (const [name, value] of Object.entries(data.vars)) if (value) out.push({type: 'token', channel, path: name, value, locator: `${page.url()} :root`});
          record.selectors = data.selectors;
          record.links = data.links;
          // States and screenshots for looks no earlier page (saved or new) already has.
          if (captureBudget.left > 0) {
            const fresh = Object.entries(data.components).flatMap(([kind, c]) => Object.entries(c.styles).filter(([key]) => !components.get(kind)?.styles.has(key)).map(([, v]) => v));
            const captured = await captureVariants(page, fresh.filter(v => !v.disabled).slice(0, captureBudget.left)).catch(() => new Map<string, {states: VariantStates; screenshot?: string}>());
            captureBudget.left -= captured.size;
            for (const v of fresh) { const got = captured.get(v.ref); if (got) Object.assign(v, got, {captured: true}); }
          }
          record.components = data.components;
        }
      }
      return record;
    }

    for (const [kind, c] of components) {
      // Structural wrappers (PageWrapper, ContentContainer…) are layout plumbing, not components.
      if (c.named && STRUCTURAL.test(kind)) continue;
      const looks = [...c.styles.values()], {variants, variantStyles} = describeVariants(kind, looks);
      // Captured states are evidence of a visible change; without a capture, matching stylesheet rules are the fallback.
      const seenStates = new Set(variantStyles.flatMap(v => Object.keys(('states' in v && v.states) || {})));
      // Disabled can't be forced, so a :disabled rule stays evidence for it.
      const ruled = statesFor(kind, [...c.classes], [...selectors]);
      const states = looks.some(l => l.captured) ? [...new Set([...seenStates, ...ruled.filter(st => st === 'disabled')])] : [...new Set([...ruled, ...seenStates])];
      observations.push({type: 'component', channel: 'observed_css', name: c.named ? title(kind) : kind, html: c.html, states,
        variants, variantStyles, locator: c.locator, raw: `${c.count} instances; classes ${[...c.classes].slice(0, 8).join(' ')}`});
    }
    if (!records.length) throw new AdapterError(`The website could not be rendered: ${failed[0]?.reason ?? 'no pages loaded'}.`);
    return {observations, fetched: records.length, failed, budgetHit: queue.length > 0, viewports: [...viewports].sort((a, b) => a - b), themes: [...themes],
      ...(reused ? {reused} : {})};
  };
}
