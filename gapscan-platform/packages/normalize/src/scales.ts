// Turns raw observations into scales: colour clusters and roles, spacing grid,
// type scale, radii and elevation (architecture Part 1 §1.4). Every inference
// reports how well it fits so the review screen can label it honestly.
import {deltaE2000, isNeutral, parseColor, toHex, toLab, toOklch} from './color.ts';
import type {Lab, Oklch, Rgb} from './color.ts';

export const THRESHOLDS = Object.freeze({mergeDeltaE: 2, nearDuplicateDeltaE: 5, gridShare: 0.8, gridTolerancePx: 0.5, typeResidual: 0.06, rootFontPx: 16});

// ── Units ───────────────────────────────────────────────────────────────────
export function toPx(value: string, rootPx: number = THRESHOLDS.rootFontPx): number | null {
  const match = value.trim().match(/^(-?[\d.]+)(px|rem|pt|em)?$/i);
  if (!match) return null;
  const n = parseFloat(match[1]!), unit = (match[2] ?? 'px').toLowerCase();
  if (!Number.isFinite(n)) return null;
  // `em` depends on the element's font size, which a static parse cannot know; rem is assumed relative to 16px.
  return unit === 'px' ? n : unit === 'rem' ? n * rootPx : unit === 'pt' ? n * 4 / 3 : null;
}
const roundPx = (value: number) => Math.round(value * 100) / 100;

// ── Colour ──────────────────────────────────────────────────────────────────
export type ColorObservation = {value: string; count?: number; property?: string; selector?: string; evidenceId?: string};
export type ColorCluster = {
  hex: string; oklch: Oklch; count: number; members: string[]; evidence: string[];
  properties: Record<string, number>; selectors: string[]; neutral: boolean;
};
type Working = ColorCluster & {lab: Lab; rgb: Rgb};

// Greedy clustering by usage: frequent colours become representatives and
// anything within ΔE 2 of one joins it.
export function clusterColors(observations: readonly ColorObservation[]): ColorCluster[] {
  const parsed = observations.map(o => ({o, rgb: parseColor(o.value)})).filter((p): p is {o: ColorObservation; rgb: Rgb} => p.rgb !== null && p.rgb.alpha > 0);
  const byHex = new Map<string, {rgb: Rgb; observations: ColorObservation[]; count: number}>();
  for (const {o, rgb} of parsed) {
    const hex = toHex({...rgb, alpha: 1}), entry = byHex.get(hex) ?? {rgb: {...rgb, alpha: 1}, observations: [], count: 0};
    entry.observations.push(o); entry.count += o.count ?? 1; byHex.set(hex, entry);
  }
  const clusters: Working[] = [];
  for (const [hex, entry] of [...byHex].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
    const lab = toLab(entry.rgb), home = clusters.find(c => deltaE2000(c.lab, lab) < THRESHOLDS.mergeDeltaE);
    const target = home ?? (() => {
      const created: Working = {hex, oklch: toOklch(entry.rgb), count: 0, members: [], evidence: [], properties: {}, selectors: [], neutral: isNeutral(entry.rgb), lab, rgb: entry.rgb};
      clusters.push(created); return created;
    })();
    target.count += entry.count;
    for (const o of entry.observations) {
      if (!target.members.includes(o.value)) target.members.push(o.value);
      if (o.evidenceId) target.evidence.push(o.evidenceId);
      if (o.property) target.properties[o.property] = (target.properties[o.property] ?? 0) + (o.count ?? 1);
      if (o.selector && !target.selectors.includes(o.selector)) target.selectors.push(o.selector);
    }
  }
  return clusters.map(({lab: _lab, rgb: _rgb, ...cluster}) => cluster);
}

export type NearDuplicate = {a: string; b: string; deltaE: number};
export function nearDuplicates(clusters: readonly ColorCluster[]): NearDuplicate[] {
  const pairs: NearDuplicate[] = [];
  for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
    const a = clusters[i]!, b = clusters[j]!, d = deltaE2000(toLab(parseColor(a.hex)!), toLab(parseColor(b.hex)!));
    if (d >= THRESHOLDS.mergeDeltaE && d < THRESHOLDS.nearDuplicateDeltaE) pairs.push({a: a.hex, b: b.hex, deltaE: Math.round(d * 100) / 100});
  }
  return pairs;
}

export type ColorRole = 'primary' | 'text' | 'surface' | 'border' | 'success' | 'warning' | 'danger' | 'info';
export type RoleGuess = {role: ColorRole; hex: string; reason: string};
const SEMANTIC: [ColorRole, RegExp, [number, number][]][] = [
  ['danger', /danger|error|critical|destructive|negative/, [[0, 40], [340, 360]]],
  ['warning', /warn|caution|attention/, [[40, 100]]],
  ['success', /success|positive|valid|ok\b|confirm/, [[120, 175]]],
  ['info', /info|notice|highlight/, [[200, 270]]],
];
const inHue = (h: number, ranges: [number, number][]) => ranges.some(([lo, hi]) => h >= lo && h <= hi);
const share = (c: ColorCluster, property: RegExp) => Object.entries(c.properties).filter(([p]) => property.test(p)).reduce((s, [, n]) => s + n, 0);

// Usage-based guesses only; each carries its reason and is labelled inferred downstream.
export function inferRoles(clusters: readonly ColorCluster[]): RoleGuess[] {
  const guesses: RoleGuess[] = [], taken = new Set<string>();
  const pick = (role: ColorRole, candidates: ColorCluster[], reason: string) => {
    const chosen = candidates.find(c => !taken.has(c.hex));
    if (chosen) { guesses.push({role, hex: chosen.hex, reason}); taken.add(chosen.hex); }
  };
  const chromatic = clusters.filter(c => !c.neutral), neutrals = clusters.filter(c => c.neutral);
  // Resting states define a role; a darker :hover shade must not win over the colour it modifies.
  const actionish = (c: ColorCluster) => c.selectors.filter(s => /btn|button|cta|primary|link|action/i.test(s) && !/:(hover|active|focus|focus-visible|visited|disabled)\b/i.test(s)).length;
  pick('primary', [...chromatic].sort((a, b) => actionish(b) - actionish(a) || share(b, /background|fill/) - share(a, /background|fill/) || b.count - a.count),
    'Most-used non-neutral colour on buttons, links or calls to action');
  pick('text', [...neutrals].filter(c => c.oklch.l < 0.5).sort((a, b) => share(b, /^color$/) - share(a, /^color$/) || b.count - a.count), 'Most-used dark neutral on text');
  pick('surface', [...neutrals].filter(c => c.oklch.l > 0.85).sort((a, b) => share(b, /background/) - share(a, /background/) || b.count - a.count), 'Most-used light neutral background');
  pick('border', [...neutrals].filter(c => share(c, /border|outline|divider/) > 0).sort((a, b) => share(b, /border|outline/) - share(a, /border|outline/)), 'Most-used neutral on borders');
  for (const [role, names, hues] of SEMANTIC) {
    // A named selector must also have a plausible hue: `.alert-warning` yellow is not a danger colour.
    const named = chromatic.filter(c => c.selectors.some(s => names.test(s.toLowerCase())) && inHue(c.oklch.h, hues));
    pick(role, named.length ? named : chromatic.filter(c => inHue(c.oklch.h, hues) && c.oklch.c > 0.08), named.length ? 'Used by selectors named for this status' : 'Hue typical for this status; not confirmed by naming');
  }
  return guesses;
}

// Tonal ramp in OKLCH lightness. Steps matching an observed colour are marked observed.
export type RampStep = {step: number; hex: string; status: 'observed' | 'synthesized'};
const RAMP_LIGHTNESS: [number, number][] = [[50, 0.97], [100, 0.93], [200, 0.86], [300, 0.77], [400, 0.67], [500, 0.58], [600, 0.5], [700, 0.42], [800, 0.33], [900, 0.25]];
export function buildRamp(seed: ColorCluster, observed: readonly ColorCluster[] = [seed]): RampStep[] {
  return RAMP_LIGHTNESS.map(([step, l]) => {
    const c = Math.min(seed.oklch.c, 0.37 * (1 - Math.abs(l - 0.6) * 1.1)), h = seed.oklch.h * Math.PI / 180;
    const candidate = parseColor(`oklab(${l} ${c * Math.cos(h)} ${c * Math.sin(h)})`)!;
    const match = observed.find(o => deltaE2000(toLab(parseColor(o.hex)!), toLab(candidate)) < THRESHOLDS.mergeDeltaE);
    return match ? {step, hex: match.hex, status: 'observed'} : {step, hex: toHex(candidate), status: 'synthesized'};
  });
}

// ── Spacing ─────────────────────────────────────────────────────────────────
export type SpacingObservation = {value: string; count?: number; evidenceId?: string};
export type SpacingScale = {baseUnit: 4 | 8 | null; coverage: number; steps: number[]; offScale: {px: number; count: number; evidence: string[]}[]};
export const SPACING_MAX_PX = 128;
export function detectSpacing(observations: readonly SpacingObservation[]): SpacingScale {
  const values = new Map<number, {count: number; evidence: string[]}>();
  for (const o of observations) for (const part of o.value.trim().split(/\s+/)) {
    const px = toPx(part);
    // Above 128px a value is layout (column widths, section offsets), not spacing.
    if (px === null || px <= 0 || px > SPACING_MAX_PX) continue;
    const key = roundPx(Math.abs(px)), entry = values.get(key) ?? {count: 0, evidence: []};
    entry.count += o.count ?? 1; if (o.evidenceId) entry.evidence.push(o.evidenceId); values.set(key, entry);
  }
  const total = [...values.values()].reduce((s, v) => s + v.count, 0);
  const fits = (px: number, base: number) => { const r = px % base; return Math.min(r, base - r) <= THRESHOLDS.gridTolerancePx; };
  const coverageFor = (base: number) => total ? [...values].filter(([px]) => fits(px, base)).reduce((s, [, v]) => s + v.count, 0) / total : 0;
  // Prefer the larger grid when it explains enough: an 8px system also fits a 4px grid.
  const baseUnit = ([8, 4] as const).find(base => coverageFor(base) >= THRESHOLDS.gridShare) ?? null;
  // With a grid, steps are the grid multiples actually used (7.8px and 8px are both the 8px step).
  // Without a grid, steps are whole pixels that carry real use: em-derived fractions (16.59px) join
  // their nearest pixel, and values under 1% of all spacing are one-offs, not steps.
  const whole = new Map<number, number>();
  for (const [px, v] of values) whole.set(Math.round(px), (whole.get(Math.round(px)) ?? 0) + v.count);
  const steps = baseUnit
    ? [...new Set([...values.keys()].filter(px => fits(px, baseUnit)).map(px => Math.round(px / baseUnit) * baseUnit).filter(px => px > 0))].sort((a, b) => a - b)
    : [...whole].filter(([px, count]) => px > 0 && (count / total >= 0.01 || whole.size <= 6)).map(([px]) => px).sort((a, b) => a - b);
  const offScale = baseUnit ? [...values].filter(([px]) => !fits(px, baseUnit)).map(([px, v]) => ({px, count: v.count, evidence: v.evidence})).sort((a, b) => b.count - a.count) : [];
  return {baseUnit, coverage: Math.round((baseUnit ? coverageFor(baseUnit) : 0) * 100) / 100, steps, offScale};
}

// ── Typography ──────────────────────────────────────────────────────────────
export type TypeObservation = {size: string; family?: string; weight?: string | number; lineHeight?: string; selector?: string; count?: number};
export type TypeScale = {basePx: number; ratio: number; residual: number; irregular: boolean; sizes: {px: number; step: number; role: string; count: number}[]; families: string[]; bodyFamily?: string};
const RATIOS = [1.067, 1.125, 1.2, 1.25, 1.333, 1.414, 1.5, 1.618];
const ROLE_BY_STEP = (step: number) => step >= 5 ? 'display' : step >= 3 ? 'headline' : step >= 1 ? 'title' : step === 0 ? 'body' : step === -1 ? 'label' : 'caption';
// The family most used at the body size (code blocks and headings use other sizes).
function bodyFamily(observations: readonly TypeObservation[], basePx: number): string | undefined {
  const counts = new Map<string, number>();
  for (const o of observations) {
    const px = toPx(o.size), family = o.family?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
    if (family && px !== null && roundPx(px) === basePx) counts.set(family, (counts.get(family) ?? 0) + (o.count ?? 1));
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function fitTypeScale(observations: readonly TypeObservation[]): TypeScale | null {
  const sizes = new Map<number, number>(), families = new Map<string, number>(), bodySizes = new Map<number, number>();
  const BODY = /^(body|p)$/;   // unclassed body and paragraph text; `p.lead` and friends are display sizes
  for (const o of observations) {
    const px = toPx(o.size); if (px === null || px <= 0) continue;
    sizes.set(roundPx(px), (sizes.get(roundPx(px)) ?? 0) + (o.count ?? 1));
    if (o.selector && BODY.test(o.selector)) bodySizes.set(roundPx(px), (bodySizes.get(roundPx(px)) ?? 0) + (o.count ?? 1));
    const family = o.family?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
    if (family) families.set(family, (families.get(family) ?? 0) + (o.count ?? 1));
  }
  if (!sizes.size) return null;
  // Body text is the most-used size on body/paragraph elements when known, else the most-used size between 12 and 20px.
  const ranked = [...(bodySizes.size ? bodySizes : sizes)].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const basePx = (ranked.find(([px]) => px >= 12 && px <= 20) ?? ranked[0]!)[0];
  // A finer ratio always fits better, so penalise empty steps (too fine) and two
  // sizes sharing a step (too coarse) alongside the fit residual.
  let best = {ratio: RATIOS[0]!, residual: Infinity, score: Infinity};
  for (const ratio of RATIOS) {
    const steps = [...sizes.keys()].map(px => Math.round(Math.log(px / basePx) / Math.log(ratio)));
    const residual = [...sizes.keys()].reduce((sum, px, i) => sum + Math.abs(px - basePx * ratio ** steps[i]!) / px, 0) / sizes.size;
    const used = new Set(steps), collisions = steps.length - used.size, gaps = Math.max(...steps) - Math.min(...steps) + 1 - used.size;
    const score = residual + (0.05 * collisions + 0.01 * gaps) / sizes.size;
    if (score < best.score - 1e-9) best = {ratio, residual, score};
  }
  const stepOf = (px: number) => Math.round(Math.log(px / basePx) / Math.log(best.ratio));
  return {
    basePx, ratio: best.ratio, residual: Math.round(best.residual * 1000) / 1000, irregular: best.residual > THRESHOLDS.typeResidual,
    sizes: [...sizes].sort((a, b) => b[0] - a[0]).map(([px, count]) => ({px, step: stepOf(px), role: ROLE_BY_STEP(stepOf(px)), count})),
    families: [...families].sort((a, b) => b[1] - a[1]).map(([family]) => family),
    ...(bodyFamily(observations, basePx) ? {bodyFamily: bodyFamily(observations, basePx)!} : {}),
  };
}

// ── Shape and elevation ─────────────────────────────────────────────────────
export function radiusScale(values: readonly string[]): {name: string; px: number | 'full'}[] {
  const px = [...new Set(values.flatMap(v => {
    if (/^(50%|9999px|999px|100vmax)$/.test(v.trim())) return ['full' as const];
    // Anything from ~100px up behaves as a pill/circle (Bootstrap's 50rem, Tailwind's 9999px).
    const n = toPx(v.trim().split(/\s+/)[0] ?? ''); return n === null ? [] : [n >= 100 ? 'full' as const : roundPx(n)];
  }))];
  const numeric = px.filter((p): p is number => p !== 'full').sort((a, b) => a - b);
  const names = numeric.includes(0) ? ['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'] : ['sm', 'md', 'lg', 'xl', '2xl', '3xl'];
  return [...numeric.map((p, i) => ({name: names[i] ?? `r${i}`, px: p as number | 'full'})), ...(px.includes('full') ? [{name: 'full', px: 'full' as const}] : [])];
}

export type ShadowLevel = {level: number; value: string; blurPx: number; offsetYPx: number};
// A shadow layer that draws nothing: zero offsets, blur and spread, or a fully transparent colour
// (often a transition's resting state, like `0 0 0 0 rgba(0,0,0,0)`).
function invisibleLayer(layer: string): boolean {
  const color = layer.match(/(rgba?|hsla?|oklch)\([^)]*\)|#[0-9a-f]{3,8}\b|transparent/i)?.[0] ?? '';
  const lengths = layer.replace(/(rgba?|hsla?|oklch)\([^)]*\)|#[0-9a-f]+|inset|transparent/gi, ' ').trim().split(/\s+/).map(part => toPx(part)).filter((n): n is number => n !== null);
  return color === 'transparent' || (parseColor(color)?.alpha ?? 1) === 0 || lengths.every(n => n === 0);
}
export function elevationScale(values: readonly string[]): ShadowLevel[] {
  // Invisible layers are dropped from each value; a value with nothing left is not a shadow.
  const visible = values.map(v => v.split(/,(?![^(]*\))/).map(l => l.trim()).filter(l => l && l !== 'none' && !invisibleLayer(l)).join(', ')).filter(Boolean);
  const parsed = [...new Set(visible)].map(value => {
    const first = value.split(/,(?![^(]*\))/)[0] ?? '', lengths = first.replace(/(rgba?|hsla?|oklch)\([^)]*\)|#[0-9a-f]+|inset/gi, ' ').trim().split(/\s+/).map(part => toPx(part)).filter((n): n is number => n !== null);
    return {value, offsetYPx: lengths[1] ?? 0, blurPx: lengths[2] ?? 0};
  });
  return parsed.sort((a, b) => a.blurPx - b.blurPx || a.offsetYPx - b.offsetYPx).map((s, i) => ({level: i + 1, ...s}));
}
