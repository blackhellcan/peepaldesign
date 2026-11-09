// Colour parsing and comparison for extraction (architecture Part 1 §1.4).
// Every input format is converted to sRGB, compared in CIE Lab with CIEDE2000,
// and reported in OKLCH. The original string is always kept by the caller.

export type Rgb = {r: number; g: number; b: number; alpha: number};   // r, g, b in 0–1
export type Lab = {L: number; a: number; b: number};
export type Oklch = {l: number; c: number; h: number};

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  navy: '#000080', teal: '#008080', olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff',
  fuchsia: '#ff00ff', magenta: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', crimson: '#dc143c', tomato: '#ff6347', coral: '#ff7f50', salmon: '#fa8072', khaki: '#f0e68c',
  beige: '#f5f5dc', ivory: '#fffff0', lavender: '#e6e6fa', turquoise: '#40e0d0', tan: '#d2b48c', chocolate: '#d2691e',
  firebrick: '#b22222', darkred: '#8b0000', darkblue: '#00008b', darkgreen: '#006400', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', dimgray: '#696969', dimgrey: '#696969', gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5',
  slategray: '#708090', steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff', skyblue: '#87ceeb', seagreen: '#2e8b57',
  forestgreen: '#228b22', orangered: '#ff4500', goldenrod: '#daa520', rebeccapurple: '#663399', transparent: '#00000000',
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const channel = (value: string, scale: number) => value.trim().endsWith('%') ? parseFloat(value) / 100 : parseFloat(value) / scale;
const hue = (value: string) => {
  const v = value.trim(), n = parseFloat(v);
  return v.endsWith('turn') ? n * 360 : v.endsWith('rad') ? n * 180 / Math.PI : v.endsWith('grad') ? n * 0.9 : n;
};
const args = (body: string) => body.replace(/\s*\/\s*/, ' / ').split(/[\s,]+/).filter(Boolean);

function fromHex(hex: string): Rgb | null {
  let h = hex.replace('#', '');
  if (![3, 4, 6, 8].includes(h.length) || /[^0-9a-f]/i.test(h)) return null;
  if (h.length <= 4) h = [...h].map(c => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return {r: n(0), g: n(2), b: n(4), alpha: h.length === 8 ? n(6) : 1};
}

function fromHsl(h: number, s: number, l: number, alpha: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return {r: f(0), g: f(8), b: f(4), alpha};
}

function fromOklab(L: number, a: number, b: number, alpha: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = {r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s};
  const gamma = (v: number) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return {r: gamma(lin.r), g: gamma(lin.g), b: gamma(lin.b), alpha};
}

export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  // Naive device conversion, used only to compare print values with screen values.
  return {r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k), alpha: 1};
}

// Returns null for anything that is not a concrete colour (var(), currentColor, gradients…).
export function parseColor(input: string): Rgb | null {
  const value = input.trim().toLowerCase();
  if (value.startsWith('#')) return fromHex(value);
  if (NAMED[value]) return fromHex(NAMED[value]!);
  const fn = value.match(/^(rgba?|hsla?|oklch|oklab|cmyk|device-cmyk)\((.*)\)$/);
  if (!fn) return null;
  const [, name, body] = fn, parts = args(body!), slash = parts.indexOf('/');
  const values = slash >= 0 ? parts.slice(0, slash) : parts, alphaText = slash >= 0 ? parts[slash + 1] : parts[3];
  const alpha = alphaText === undefined ? 1 : clamp01(channel(alphaText, 1));
  if (values.length < 3 || values.some(v => v === 'none' || Number.isNaN(parseFloat(v)))) return null;
  const [x, y, z] = values as [string, string, string];
  switch (name) {
    case 'rgb': case 'rgba': return {r: clamp01(channel(x, 255)), g: clamp01(channel(y, 255)), b: clamp01(channel(z, 255)), alpha};
    case 'hsl': case 'hsla': return fromHsl(((hue(x) % 360) + 360) % 360, clamp01(channel(y, 100)), clamp01(channel(z, 100)), alpha);
    case 'oklab': return fromOklab(channel(x, 1), channel(y, 1) * (y.endsWith('%') ? 0.4 : 1), channel(z, 1) * (z.endsWith('%') ? 0.4 : 1), alpha);
    case 'oklch': {
      const L = channel(x, 1), C = channel(y, 1) * (y.endsWith('%') ? 0.4 : 1), H = hue(z) * Math.PI / 180;
      return fromOklab(L, C * Math.cos(H), C * Math.sin(H), alpha);
    }
    default: {
      const k = values[3];
      if (k === undefined) return null;
      return cmykToRgb(channel(x, 100), channel(y, 100), channel(z, 100), channel(k, 100));
    }
  }
}

export function toHex({r, g, b, alpha}: Rgb): string {
  const h = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b) + (alpha < 1 ? h(alpha) : '');
}

const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

export function toOklch({r, g, b}: Rgb): Oklch {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb), h = c < 1e-4 ? 0 : (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360;
  return {l: L, c, h};
}

export function toLab({r, g, b}: Rgb): Lab {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const X = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047, Y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb, Z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  return {L: 116 * f(Y) - 16, a: 500 * (f(X) - f(Y)), b: 200 * (f(Y) - f(Z))};
}

// CIEDE2000 (Sharma, Wu & Dalal 2005). Below ~2 most people cannot tell two colours apart.
export function deltaE2000(x: Lab, y: Lab): number {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(x.a, x.b), C2 = Math.hypot(y.a, y.b), Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1 = (1 + G) * x.a, a2 = (1 + G) * y.a, c1 = Math.hypot(a1, x.b), c2 = Math.hypot(a2, y.b);
  const h1 = (Math.atan2(x.b, a1) * deg + 360) % 360, h2 = (Math.atan2(y.b, a2) * deg + 360) % 360;
  const dL = y.L - x.L, dC = c2 - c1;
  let dh = 0;
  if (c1 * c2 !== 0) dh = Math.abs(h2 - h1) <= 180 ? h2 - h1 : h2 - h1 > 180 ? h2 - h1 - 360 : h2 - h1 + 360;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(dh / 2 * rad);
  const Lbar = (x.L + y.L) / 2, cbar = (c1 + c2) / 2;
  let hbar = h1 + h2;
  if (c1 * c2 !== 0) hbar = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbar - 30) * rad) + 0.24 * Math.cos(2 * hbar * rad) + 0.32 * Math.cos((3 * hbar + 6) * rad) - 0.2 * Math.cos((4 * hbar - 63) * rad);
  const Sl = 1 + 0.015 * (Lbar - 50) ** 2 / Math.sqrt(20 + (Lbar - 50) ** 2), Sc = 1 + 0.045 * cbar, Sh = 1 + 0.015 * cbar * T;
  const Rt = -2 * Math.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hbar - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

export function colorDistance(a: string | Rgb, b: string | Rgb): number | null {
  const x = typeof a === 'string' ? parseColor(a) : a, y = typeof b === 'string' ? parseColor(b) : b;
  return x && y ? deltaE2000(toLab(x), toLab(y)) : null;
}

// WCAG 2.x relative luminance and contrast ratio.
export function contrastRatio(foreground: string | Rgb, background: string | Rgb): number | null {
  const fg = typeof foreground === 'string' ? parseColor(foreground) : foreground, bg = typeof background === 'string' ? parseColor(background) : background;
  if (!fg || !bg) return null;
  const lum = ({r, g, b}: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const [hi, lo] = [lum(fg), lum(bg)].sort((p, q) => q - p) as [number, number];
  return Math.round((hi + 0.05) / (lo + 0.05) * 100) / 100;
}

export const isNeutral = (color: Rgb) => toOklch(color).c < 0.03;
