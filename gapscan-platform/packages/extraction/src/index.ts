// Assembles adapter observations into one ExtractedDesignSystem body
// (architecture Part 1 stages 4–7: normalize, infer, classify, audit).
// Every token and finding points back to evidence; inferred values say so.
import {createHash} from 'node:crypto';
import type {AdapterResult, Observation} from '@gapscan/adapters';
import {
  buildRamp, clusterColors, colorDistance, confidence, contrastRatio, detectSpacing, elevationScale, fitTypeScale, inferRoles,
  mergeCandidates, nearDuplicates, parseColor, radiusScale, toHex, toPx, SOURCE_WEIGHT,
} from '@gapscan/normalize';
import type {Candidate, SourceChannel} from '@gapscan/normalize';
import {classifyItem} from '@gapscan/taxonomy';
import type {ComponentObservation, CoverageReport, EvidenceRecord, QuirkRecord, SourceAsset, Specimen, Token, TokenType, Trust} from '@gapscan/schema';

export type AssetResult = {asset: SourceAsset; result: AdapterResult | null; error?: string};
export type ExternalComponent = {component: ComponentObservation; specimen?: Specimen; evidence: EvidenceRecord[]; quirks?: QuirkRecord[]};
export type TextStyle = {px: number; weight: number; lineHeightPx: number | null; family: string; count: number};
export type Scales = {
  colors: {hex: string; count: number; neutral: boolean; members: string[]}[];
  roles: {role: string; hex: string; reason: string}[];
  spacing: ReturnType<typeof detectSpacing>;
  type: ReturnType<typeof fitTypeScale>;
  // Text styles as used: the common size + weight + line-height + family combinations (most used first).
  textStyles?: TextStyle[];
  radius: ReturnType<typeof radiusScale>;
  elevation: ReturnType<typeof elevationScale>;
};
export type AssembledSystem = {
  evidence: EvidenceRecord[]; tokens: Token[]; components: ComponentObservation[]; specimens: Specimen[];
  quirks: QuirkRecord[]; coverage: CoverageReport; brandSignals: {voiceSnippets: string[]; logoAssets: string[]}; scales: Scales;
};

const TRUST: Record<SourceChannel, Trust> = {
  code_tokens: 'declared', figma_variables: 'declared', figma_styles: 'declared', pdf_guideline: 'declared', pptx_theme: 'declared', docx_styles: 'declared',
  observed_css: 'observed', image_sampling: 'inferred',
};
const DECLARED_CHANNELS = new Set<SourceChannel>(['code_tokens', 'figma_variables', 'figma_styles', 'pdf_guideline', 'pptx_theme', 'docx_styles']);
const INTERACTIVE = new Set(['Actions', 'Forms and input', 'Navigation']);
// States a component of each category is expected to show; navigation has no disabled requirement.
const REQUIRED_STATES: Record<string, string[]> = {'Actions': ['focus-visible', 'disabled'], 'Forms and input': ['focus-visible', 'disabled'], 'Navigation': ['focus-visible']};
const PRIMARY_NAME = /primary|brand|accent[-_ ]?1\b|theme\.accent1/i;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortId = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 10);

function describe(o: Observation): string {
  switch (o.type) {
    case 'color': return [o.name, o.selector && `${o.selector} { ${o.property ?? 'color'}: ${o.value} }`, !o.selector && o.value].filter(Boolean).join(' · ');
    case 'font': return [o.role, o.family, o.size, o.weight].filter(Boolean).join(' · ');
    case 'token': return `${o.path}: ${o.value}`;
    case 'component': return o.name;
    case 'text': return o.text;
    case 'asset': return o.name;
    case 'contrast': return `${o.selector}: ${o.foreground} on ${o.background}`;
    default: return o.value;
  }
}

function mapTokenType(declared: string | undefined, value: string): TokenType {
  const t = (declared ?? '').toLowerCase();
  if (t === 'color' || parseColor(value)) return 'color';
  if (['dimension', 'spacing', 'sizing', 'float', 'number'].includes(t) || /^-?[\d.]+(px|rem|em|pt)?$/.test(value)) return /radius/.test(t) ? 'radius' : 'dimension';
  if (t === 'radius' || t === 'borderradius') return 'radius';
  if (t === 'fontfamily' || t === 'fontfamilies') return 'fontFamily';
  if (t === 'fontweight' || t === 'fontweights') return 'fontWeight';
  if (t === 'shadow' || t === 'boxshadow') return 'shadow';
  if (t === 'duration') return 'duration';
  if (t === 'cubicbezier') return 'cubicBezier';
  if (t === 'typography') return 'typography';
  return 'other';
}

// `{color.brand}` (DTCG) and `var(--brand)` (CSS) are references, resolved against declared paths.
const aliasTarget = (value: string) => value.match(/^\{([^}]+)\}$/)?.[1] ?? value.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/)?.[1];

// References inside expressions (`calc(var(--a) - 1px)`, `rgba(var(--x-rgb), .5)`) resolve when every
// referenced token exists (or has a fallback) and no reference chain loops back on itself.
function referencesOf(value: string): {name: string; hasFallback: boolean}[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g), ...value.matchAll(/\{([\w.-]+)\}/g)].map(m => ({name: m[1]!, hasFallback: m[2] === ','}));
}

export function assembleSystem(inputs: readonly AssetResult[], external: readonly ExternalComponent[] = []): AssembledSystem {
  const evidence: EvidenceRecord[] = [], quirks: QuirkRecord[] = [], tokens: Token[] = [];
  const observations: {o: Observation; evidenceId: string}[] = [];
  const coverage: CoverageReport = {perAsset: [], viewports: [], themes: []};

  for (const {asset, result, error} of inputs) {
    coverage.perAsset.push({assetId: asset.id, fetched: result?.fetched ?? 0, skipped: 0, failed: result?.failed ?? (error ? [{locator: asset.uri, reason: error}] : []), budgetHit: result?.budgetHit ?? false});
    for (const v of result?.viewports ?? []) if (!coverage.viewports.includes(v)) coverage.viewports.push(v);
    for (const t of result?.themes ?? []) if (!coverage.themes.includes(t)) coverage.themes.push(t);
    if (error) quirks.push({id: `q:coverage:${asset.id}`, kind: 'coverage_gap', severity: 'major', subjectIds: [asset.id], summary: `${asset.label ?? asset.uri} was not read: ${error}`, evidence: []});
    else if (result?.budgetHit) quirks.push({id: `q:budget:${asset.id}`, kind: 'coverage_gap', severity: 'minor', subjectIds: [asset.id], summary: `${asset.label ?? asset.uri} hit its scan budget; some of it was not read.`, evidence: []});
    else if (result?.failed.length) quirks.push({id: `q:partial:${asset.id}`, kind: 'coverage_gap', severity: 'minor', subjectIds: [asset.id], summary: `${plural(result.failed.length, 'part')} of ${asset.label ?? asset.uri} could not be read.`, detail: result.failed, evidence: []});
    (result?.observations ?? []).forEach((o, index) => {
      const id = `ev:${asset.id}:${index}`;
      evidence.push({id, assetId: asset.id, trust: TRUST[o.channel], locator: o.locator, raw: (o.raw ?? describe(o)).slice(0, 500)});
      observations.push({o, evidenceId: id});
    });
  }
  for (const item of external) evidence.push(...item.evidence);
  const pick = <T extends Observation['type']>(type: T) => observations.filter((x): x is {o: Extract<Observation, {type: T}>; evidenceId: string} => x.o.type === type);

  // ── Declared tokens, merged across sources ────────────────────────────────
  const byPath = new Map<string, {o: Extract<Observation, {type: 'token'}>; evidenceId: string}[]>();
  for (const entry of pick('token')) byPath.set(entry.o.path, [...(byPath.get(entry.o.path) ?? []), entry]);
  const winningValue = new Map([...byPath].map(([path, entries]) => [path, mergeCandidates(entries.map(e => ({channel: e.o.channel, value: e.o.value})))!.value]));
  const resolvable = (path: string, value: string, trail = new Set<string>()): boolean => {
    if (trail.has(path)) return false;                       // circular reference
    if (/env\(|attr\(/.test(value)) return false;            // depends on the runtime environment
    trail.add(path);
    return referencesOf(value).every(ref => ref.hasFallback || (winningValue.has(ref.name) && resolvable(ref.name, winningValue.get(ref.name)!, new Set(trail))));
  };
  for (const [path, entries] of byPath) {
    const merged = mergeCandidates(entries.map(e => ({channel: e.o.channel, value: e.o.value, evidence: [e.evidenceId]})))!;
    const first = entries.find(e => e.o.channel === merged.winner)!, target = aliasTarget(merged.value);
    const unresolved = !resolvable(path, merged.value);
    // Theme modes come from whichever source declares them (Figma variables), even when another source wins the value.
    const modeSource = entries.find(e => e.o.raw && /^[^=;]+=[^;]+(; [^=;]+=[^;]+)*$/.test(e.o.raw));
    const modes = modeSource ? Object.fromEntries(modeSource.o.raw!.split('; ').map(pair => pair.split('=') as [string, string])) : undefined;
    tokens.push({
      id: `tok:${shortId(path)}`, tier: target ? 'semantic' : 'global', path, type: mapTokenType(first.o.tokenType, merged.value), value: merged.value,
      ...(target && byPath.has(target) ? {aliasOf: target} : {}), status: unresolved ? 'unresolved' : 'resolved', ...(modes ? {modes} : {}),
      evidence: entries.map(e => e.evidenceId), confidence: merged.confidence, usageCount: entries.length,
    });
    if (unresolved) quirks.push({id: `q:unresolved:${shortId(path)}`, kind: 'unresolved_value', severity: 'minor', subjectIds: [`tok:${shortId(path)}`],
      summary: `${path} depends on a value we could not resolve (${merged.value}). It is kept, and anything using it stays unestimated.`, evidence: entries.map(e => e.evidenceId)});
    const distinct = new Set(entries.map(e => e.o.channel));
    if (distinct.size > 1) for (const other of merged.candidates.filter(c => c.channel !== merged.winner)) {
      const winnerValue = merged.value, d = colorDistance(winnerValue, other.value);
      if (d !== null ? d > 3 : winnerValue.trim() !== other.value.trim())
        quirks.push({id: `q:drift:${shortId(path + other.channel)}`, kind: 'declared_observed_drift', severity: 'major', subjectIds: [`tok:${shortId(path)}`],
          summary: `${path} is ${winnerValue} in one source but ${other.value} in another. Pick the source of truth.`, detail: merged.candidates, evidence: [...(other.evidence ?? []), ...(entries.find(e => e.o.channel === merged.winner) ? [first.evidenceId] : [])]});
    }
  }

  // ── Colour: clusters, roles, near-duplicates, hard-coded literals, drift ──
  const colorObs = pick('color');
  const clusters = clusterColors(colorObs.map(({o, evidenceId}) => ({value: o.value, count: o.count ?? 1, ...(o.property ? {property: o.property} : {}), ...(o.selector ? {selector: o.selector} : {}), evidenceId})));
  const observedClusters = clusterColors(colorObs.filter(x => x.o.channel === 'observed_css' || x.o.property === 'fill').map(({o, evidenceId}) => ({value: o.value, count: o.count ?? 1, ...(o.property ? {property: o.property} : {}), ...(o.selector ? {selector: o.selector} : {}), evidenceId})));
  // Few pairs read best one by one; many are summarised as one finding with the full list in detail.
  const pairs = nearDuplicates(clusters), pairEvidence = (hex: string) => clusters.find(c => c.hex === hex)?.evidence ?? [];
  if (pairs.length && pairs.length <= 5) for (const pair of pairs) quirks.push({id: `q:near:${pair.a}${pair.b}`, kind: 'near_duplicate_token', severity: 'minor', subjectIds: [pair.a, pair.b],
    summary: `${pair.a} and ${pair.b} are nearly identical (ΔE ${pair.deltaE}). Consider using one.`, evidence: [...pairEvidence(pair.a), ...pairEvidence(pair.b)].slice(0, 20)});
  else if (pairs.length) quirks.push({id: 'q:near:all', kind: 'near_duplicate_token', severity: 'minor', subjectIds: [...new Set(pairs.flatMap(p => [p.a, p.b]))],
    summary: `${plural(pairs.length, 'pair')} of colours are nearly identical (for example ${pairs.slice(0, 3).map(p => `${p.a}/${p.b}`).join(', ')}). Consolidating them would shrink the palette.`, detail: pairs, evidence: pairs.slice(0, 5).flatMap(p => [...pairEvidence(p.a).slice(0, 2), ...pairEvidence(p.b).slice(0, 2)])});
  const roles = inferRoles(observedClusters.length ? observedClusters : clusters);
  const declaredColorPaths = new Set(tokens.filter(t => t.type === 'color').map(t => String(t.value).toLowerCase()));
  clusters.forEach((cluster, index) => {
    if (cluster.members.some(m => declaredColorPaths.has(m.toLowerCase()))) return;
    tokens.push({id: `tok:palette:${cluster.hex}`, tier: 'global', path: `color.palette.${index + 1}`, type: 'color', value: cluster.hex, status: 'resolved',
      evidence: cluster.evidence.slice(0, 50), confidence: confidence('observed_css', 1, cluster.count), usageCount: cluster.count});
  });
  for (const role of roles) {
    const cluster = clusters.find(c => colorDistance(c.hex, role.hex)! < 2);
    tokens.push({id: `tok:role:${role.role}`, tier: 'semantic', path: `color.${role.role}`, type: 'color', value: role.hex, status: 'resolved',
      evidence: cluster?.evidence.slice(0, 50) ?? [], confidence: Math.min(0.49, confidence('observed_css', 0.5, cluster?.count ?? 1)), usageCount: cluster?.count ?? 0});
  }
  const primaryObserved = roles.find(r => r.role === 'primary');
  const declaredPrimary = colorObs.filter(x => DECLARED_CHANNELS.has(x.o.channel) && PRIMARY_NAME.test(`${x.o.name ?? ''} ${x.o.role ?? ''}`));
  if (primaryObserved && declaredPrimary.length) {
    const merged = mergeCandidates([...declaredPrimary.map(x => ({channel: x.o.channel, value: x.o.value, evidence: [x.evidenceId], label: x.o.name} as Candidate)), {channel: 'observed_css', value: primaryObserved.hex, evidence: []}])!;
    for (const d of merged.drift) quirks.push({id: `q:drift:primary:${d.declared.channel}`, kind: 'declared_observed_drift', severity: 'major', subjectIds: ['tok:role:primary'],
      summary: `The ${d.declared.label ?? 'brand primary'} is ${d.declared.value.toUpperCase()} in the ${d.declared.channel.replace(/_/g, ' ')}, but the product mostly uses ${d.observed.value.toUpperCase()}.`, detail: d, evidence: d.declared.evidence ?? []});
  }
  const literal = colorObs.filter(x => x.o.channel === 'observed_css'), sourceLiterals = literal.filter(x => !x.o.rendered);
  const declaredColors = tokens.filter(t => t.type === 'color' && t.tier !== 'semantic' && !t.path.startsWith('color.palette') && parseColor(String(t.value)));
  const hardcoded = new Map<string, {count: number; evidence: string[]}>();
  for (const {o, evidenceId} of sourceLiterals) {
    const match = declaredColors.find(t => colorDistance(String(t.value), o.value)! < 1);
    if (match) { const entry = hardcoded.get(match.path) ?? {count: 0, evidence: []}; entry.count++; entry.evidence.push(evidenceId); hardcoded.set(match.path, entry); }
  }
  for (const [path, {count, evidence: ev}] of hardcoded) quirks.push({id: `q:hardcoded:${shortId(path)}`, kind: 'hardcoded_value', severity: 'minor', subjectIds: [path],
    summary: `${plural(count, 'style rule')} write the value of ${path} directly instead of using the token.`, evidence: ev.slice(0, 20)});

  // ── Contrast from rules that set both text and background colour ─────────
  const bySelector = new Map<string, {fg?: string; bg?: string; evidence: string[]}>();
  for (const {o, evidenceId} of literal) {
    if (!o.selector) continue;
    const entry = bySelector.get(o.selector) ?? {evidence: []};
    if (o.property === 'color') entry.fg = o.value; else if (/^background/.test(o.property ?? '')) entry.bg = o.value;
    entry.evidence.push(evidenceId); bySelector.set(o.selector, entry);
  }
  // Rendered pages give real per-element pairs (text colour over the background actually behind it);
  // source CSS only lets us pair the colour and background set by the same rule.
  const measured = pick('contrast');
  const pairsToCheck = measured.length
    ? measured.map(({o, evidenceId}) => ({selector: / dark$/.test(o.locator) ? `${o.selector} (dark mode)` : o.selector, fg: o.foreground, bg: o.background, large: o.large, evidence: [evidenceId]}))
    : [...bySelector].filter(([, v]) => v.fg && v.bg).map(([selector, v]) => ({selector, fg: v.fg!, bg: v.bg!, large: false, evidence: v.evidence}));
  const worst = new Map<string, {ratio: number; fg: string; bg: string; large: boolean; evidence: string[]}>();
  for (const pair of pairsToCheck) {
    const ratio = contrastRatio(pair.fg, pair.bg), needed = pair.large ? 3 : 4.5;
    if (ratio === null || ratio >= needed) continue;
    const previous = worst.get(pair.selector);
    if (!previous || ratio < previous.ratio) worst.set(pair.selector, {ratio, fg: pair.fg, bg: pair.bg, large: pair.large, evidence: [...(previous?.evidence ?? []), ...pair.evidence].slice(0, 10)});
  }
  for (const [selector, w] of worst) quirks.push({id: `q:contrast:${shortId(selector)}`, kind: 'contrast_fail', severity: w.ratio < 3 ? 'major' : 'minor', subjectIds: [selector],
    summary: `${selector} text has ${w.ratio}:1 contrast against its background; WCAG AA needs ${w.large ? '3:1 for large text' : '4.5:1 for body text'}.`, detail: {foreground: w.fg, background: w.bg, ratio: w.ratio}, evidence: w.evidence});

  // ── Spacing, type, radius, elevation ─────────────────────────────────────
  const spacing = detectSpacing(pick('spacing').map(({o, evidenceId}) => ({value: o.value, count: o.count ?? 1, evidenceId})));
  spacing.steps.forEach((px, i) => tokens.push({id: `tok:space:${px}`, tier: 'global', path: `space.${i + 1}`, type: 'dimension', value: `${px}px`, status: 'resolved', evidence: [], confidence: spacing.baseUnit ? 0.6 : 0.4, usageCount: 0}));
  if (spacing.baseUnit && spacing.offScale.length) quirks.push({id: 'q:offscale:spacing', kind: 'off_scale', severity: 'minor', subjectIds: spacing.offScale.map(v => `${v.px}px`),
    summary: `${spacing.offScale.map(v => `${v.px}px`).slice(0, 6).join(', ')} fall outside the ${spacing.baseUnit}px spacing grid (${Math.round(spacing.coverage * 100)}% of values fit).`, detail: spacing.offScale, evidence: spacing.offScale.flatMap(v => v.evidence).slice(0, 20)});

  const fonts = pick('font');
  const textStyles = textStylesFrom(fonts.map(f => f.o));
  const type = fitTypeScale(fonts.filter(f => f.o.size).map(({o}) => ({size: o.size!, family: o.family, ...(o.weight ? {weight: o.weight} : {}), ...(o.selector ? {selector: o.selector} : {}), count: o.count ?? 1})));
  if (type) {
    for (const size of type.sizes) tokens.push({id: `tok:type:${size.px}`, tier: 'global', path: `font.size.${size.role}${type.sizes.filter(s => s.role === size.role).length > 1 ? '.' + size.step : ''}`, type: 'dimension', value: `${size.px}px`, status: 'resolved', evidence: [], confidence: type.irregular ? 0.4 : 0.6, usageCount: size.count});
    if (type.irregular) quirks.push({id: 'q:offscale:type', kind: 'off_scale', severity: 'minor', subjectIds: type.sizes.map(s => `${s.px}px`),
      summary: `Font sizes do not follow a consistent scale (closest ratio ${type.ratio}, average miss ${Math.round(type.residual * 100)}%).`, detail: type, evidence: []});
  }
  const customProperties = new Map(pick('token').filter(t => t.o.path.startsWith('--')).map(t => [t.o.path, t.o.value]));
  const resolveVar = (value: string, depth = 0): string => {
    const name = aliasTarget(value.trim());
    if (!name || depth > 8) return value;
    const next = customProperties.get(name) ?? value.match(/^var\(\s*--[\w-]+\s*,\s*(.+)\)$/)?.[1];
    return next ? resolveVar(next, depth + 1) : value;
  };
  for (const role of ['heading', 'body', 'display'] as const) {
    const declared = fonts.find(f => f.o.role === role && f.o.family && DECLARED_CHANNELS.has(f.o.channel));
    // A typeface set on the page itself or on top-level headings, even in a rule with no size.
    const BY_SELECTOR = {body: /(^|,)\s*(html|body|:root)\s*(,|$)/, heading: /(^|,)\s*h[1-3]\s*(,|$)/, display: null}[role];
    const styled = BY_SELECTOR ? fonts.find(f => f.o.family && f.o.selector && BY_SELECTOR.test(f.o.selector)) : undefined;
    // `var(--heading-font)` is looked up through the stylesheet's own custom properties (and fallbacks);
    // a typeface that still can't be resolved is left out rather than shown as code.
    const clean = (value: string | undefined) => { const first = value ? resolveVar(value).split(',')[0]?.replace(/['"]/g, '').trim() : undefined; return first && !/^var\(/.test(first) ? first : undefined; };
    // An explicit rule on the page or headings beats the guess from the most-used text size.
    const family = (declared ? clean(declared.o.family) : undefined) ?? (styled ? clean(styled.o.family) : undefined) ?? (role === 'body' ? clean(type?.bodyFamily) ?? clean(type?.families[0]) : undefined);
    const source = declared ?? (family && styled && clean(styled.o.family) === family ? styled : undefined);
    if (family) tokens.push({id: `tok:family:${role}`, tier: 'semantic', path: `font.family.${role}`, type: 'fontFamily', value: family, status: 'resolved',
      evidence: source ? [source.evidenceId] : [], confidence: declared ? confidence(declared.o.channel, 1, 1) : source ? 0.6 : 0.4, usageCount: fonts.filter(f => f.o.family.includes(family)).length});
  }
  const radius = radiusScale(pick('radius').map(x => x.o.value));
  for (const r of radius) tokens.push({id: `tok:radius:${r.name}`, tier: 'global', path: `radius.${r.name}`, type: 'radius', value: r.px === 'full' ? '9999px' : `${r.px}px`, status: 'resolved', evidence: [], confidence: 0.6, usageCount: 0});
  const elevation = elevationScale(pick('shadow').map(x => x.o.value));
  for (const s of elevation) tokens.push({id: `tok:shadow:${s.level}`, tier: 'global', path: `shadow.${s.level}`, type: 'shadow', value: s.value, status: 'resolved', evidence: [], confidence: 0.6, usageCount: 0});

  // ── Components: design-file component sets plus code inventories ─────────
  const components = new Map<string, ComponentObservation>(), specimens: Specimen[] = [];
  const add = (component: ComponentObservation) => {
    const key = component.canonical.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const existing = components.get(key);
    if (!existing) { components.set(key, component); return; }
    existing.rawNames = [...new Set([...existing.rawNames, ...component.rawNames])];
    existing.statesObserved = [...new Set([...existing.statesObserved, ...component.statesObserved])];
    existing.statesMissing = existing.statesMissing.filter(s => !existing.statesObserved.includes(s));
    existing.variants = [...existing.variants, ...component.variants.filter(v => !existing.variants.some(e => e.name === v.name))];
    existing.sizes = [...new Set([...existing.sizes, ...component.sizes])];
    existing.evidence = [...existing.evidence, ...component.evidence];
    existing.instances += component.instances;
    existing.confidence = Math.max(existing.confidence, component.confidence);
    if (existing.a11y.focusVisible !== true && component.a11y.focusVisible !== null) existing.a11y.focusVisible = component.a11y.focusVisible || existing.a11y.focusVisible;
  };
  for (const {o, evidenceId} of pick('component')) {
    const classification = classifyItem({name: o.name, kind: 'component'}), interactive = INTERACTIVE.has(classification.category);
    // Code-derived examples apply real CSS to generated markup, so they are inferred, not captured.
    if (o.html && !specimens.some(s => s.id === `sp:cmp:${shortId(o.name)}`)) specimens.push({id: `sp:cmp:${shortId(o.name)}`, html: o.html, ...(o.css ? {css: o.css} : {}), origin: o.rendered ? 'captured' : 'inferred_probe'});
    const states = [...new Set((o.states ?? []).map(s => s === 'focus' || s === 'focused' ? 'focus-visible' : s))];
    // Props and design files cannot show focus styling; without style evidence focus is unknown, not missing.
    const styleEvidence = Boolean(o.css || o.html || o.channel === 'observed_css' || o.channel === 'figma_styles');
    add({
      id: `cmp:${shortId(o.name)}`, canonical: o.name, rawNames: [o.name], category: classification.category, tier: classification.tier,
      // Rendered sites record how each variant looks (computed styles of a representative instance).
      variants: (o.variants ?? []).filter(v => !v.startsWith('size=')).map(name => {
        const seen = o.variantStyles?.find(v => v.name === name);
        const screenshot = seen?.screenshot && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(seen.screenshot) && seen.screenshot.length <= 400_000 ? seen.screenshot : undefined;
        return {name, tokenRefs: seen ? {...seen.style, ...(seen.text ? {label: seen.text} : {}), instances: String(seen.count)} : {},
          ...(seen?.states && Object.keys(seen.states).length ? {states: Object.fromEntries(Object.entries(seen.states).map(([k, v]) => [k, {...v} as Record<string, string>]))} : {}),
          ...(screenshot ? {screenshot} : {})};
      }),
      sizes: (o.variants ?? []).filter(v => v.startsWith('size=')).map(v => v.slice(5)),
      ...(o.variantStyles?.some(v => v.name.startsWith('size=')) ? {sizeStyles: Object.fromEntries(o.variantStyles.filter(v => v.name.startsWith('size=')).map(v => [v.name.slice(5), {...v.style}]))} : {}),
      statesObserved: states, statesMissing: (REQUIRED_STATES[classification.category] ?? []).filter(s => !states.includes(s) && (styleEvidence || !s.startsWith('focus'))),
      ...(o.props?.length ? {props: o.props} : {}),
      a11y: {focusVisible: interactive && (styleEvidence || states.includes('focus-visible')) ? states.includes('focus-visible') : null}, instances: 1, evidence: [evidenceId], confidence: SOURCE_WEIGHT[o.channel] * 0.9,
    });
  }
  for (const item of external) { add({...item.component, statesMissing: (REQUIRED_STATES[item.component.category] ?? []).filter(s => !item.component.statesObserved.some(o => o === s || (s === 'focus-visible' && o === 'focus')))}); if (item.specimen) specimens.push(item.specimen); quirks.push(...(item.quirks ?? [])); }
  for (const component of components.values()) if (INTERACTIVE.has(component.category) && component.a11y.focusVisible === false && !quirks.some(q => q.kind === 'missing_state' && q.subjectIds.includes(component.id)))
    quirks.push({id: `q:focus:${component.id}`, kind: 'missing_state', severity: 'major', subjectIds: [component.id], summary: `${component.canonical} has no visible keyboard focus style in the supplied sources.`, evidence: component.evidence.slice(0, 10)});

  // ── Brand signals for Part 3 ──────────────────────────────────────────────
  const voiceSnippets = [...new Set(pick('text').filter(x => x.o.kind === 'voice' || x.o.kind === 'rule').map(x => x.o.text))].slice(0, 200);
  const logoAssets = [...new Set(pick('asset').filter(x => x.o.kind === 'logo').map(x => x.o.name))];

  const seen = new Set<string>();
  const dedupedQuirks = quirks.filter(q => !seen.has(q.id) && seen.add(q.id));
  return {
    evidence, tokens, components: [...components.values()], specimens, quirks: dedupedQuirks, coverage, brandSignals: {voiceSnippets, logoAssets},
    scales: {colors: clusters.map(c => ({hex: c.hex, count: c.count, neutral: c.neutral, members: c.members})), roles, spacing, type, textStyles, radius, elevation},
  };
}

export function systemFingerprint(system: Pick<AssembledSystem, 'tokens' | 'components'>): string {
  const canonical = {
    tokens: system.tokens.map(t => [t.path, String(t.value), t.status]).sort(),
    components: system.components.map(c => [c.canonical.toLowerCase(), c.category, [...c.statesObserved].sort()]).sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export {buildRamp, toHex, toPx};

// Rendered text clusters into styles by whole-pixel size and weight; line height and family are the
// most used for that pair. Combinations under 1% of text are one-offs, not styles.
export function textStylesFrom(fonts: readonly {size?: string; weight?: string; lineHeight?: string; family?: string; count?: number}[]): TextStyle[] {
  const groups = new Map<string, {px: number; weight: number; count: number; lines: Map<string, number>; families: Map<string, number>}>();
  let total = 0;
  for (const f of fonts) {
    const px = f.size?.endsWith('px') ? Math.round(parseFloat(f.size)) : NaN, weight = Number(f.weight) || 400, n = f.count ?? 1;
    if (!px) continue;
    total += n;
    const key = `${px}|${weight}`, g = groups.get(key) ?? {px, weight, count: 0, lines: new Map(), families: new Map()};
    g.count += n;
    const line = f.lineHeight?.endsWith('px') ? String(Math.round(parseFloat(f.lineHeight))) : '';
    if (line) g.lines.set(line, (g.lines.get(line) ?? 0) + n);
    const family = f.family?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
    if (family) g.families.set(family, (g.families.get(family) ?? 0) + n);
    groups.set(key, g);
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  return [...groups.values()].filter(g => g.count / total >= 0.01).map(g => ({px: g.px, weight: g.weight, lineHeightPx: top(g.lines) ? Number(top(g.lines)) : null, family: top(g.families) ?? '', count: g.count}))
    .sort((a, b) => b.px - a.px || b.weight - a.weight);
}
