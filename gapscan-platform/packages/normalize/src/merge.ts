// Multi-source merging (architecture Part 1 §1.6): every source keeps its value,
// the most trusted one wins, and a disagreement becomes a drift finding instead
// of a silent overwrite.
import {colorDistance} from './color.ts';
import {toPx} from './scales.ts';

export type SourceChannel = 'code_tokens' | 'figma_variables' | 'observed_css' | 'figma_styles' | 'pdf_guideline' | 'pptx_theme' | 'docx_styles' | 'image_sampling';

// Highest precedence first; weights feed the confidence formula.
export const SOURCE_PRECEDENCE: readonly SourceChannel[] = ['code_tokens', 'figma_variables', 'observed_css', 'figma_styles', 'pdf_guideline', 'pptx_theme', 'docx_styles', 'image_sampling'];
export const SOURCE_WEIGHT: Readonly<Record<SourceChannel, number>> = {
  code_tokens: 1, figma_variables: 0.95, observed_css: 0.85, figma_styles: 0.8, pdf_guideline: 0.7, pptx_theme: 0.65, docx_styles: 0.55, image_sampling: 0.4,
};

const DECLARED: ReadonlySet<SourceChannel> = new Set(['code_tokens', 'figma_variables', 'figma_styles', 'pdf_guideline', 'pptx_theme', 'docx_styles']);

// Heuristic 0–1 label, not measured accuracy. Shown only as Confirmed / Likely / Inferred.
// Usage only discounts values GapScan observed or inferred; a declared token is declared even if defined once.
export function confidence(channel: SourceChannel, agreement: number, instances: number): number {
  const usage = DECLARED.has(channel) ? 1 : Math.min(1, Math.log10(instances + 1) / 2);
  return Math.round(Math.min(1, SOURCE_WEIGHT[channel] * (0.5 + 0.5 * Math.min(1, Math.max(0, agreement))) * usage) * 100) / 100;
}
export const confidenceBand = (value: number) => value >= 0.8 ? 'Confirmed' : value >= 0.5 ? 'Likely' : 'Inferred';

export type Candidate = {channel: SourceChannel; value: string; instances?: number; evidence?: string[]; label?: string};
export type MergeResult = {
  value: string; winner: SourceChannel; confidence: number; agreement: number;
  candidates: Candidate[]; drift: {declared: Candidate; observed: Candidate; distance: number}[];
};

// Values agree when colours are within ΔE 3 or lengths within 1px; anything else compares as text.
export function valuesAgree(a: string, b: string): {agree: boolean; distance: number} {
  const color = colorDistance(a, b);
  if (color !== null) return {agree: color <= 3, distance: Math.round(color * 100) / 100};
  const pa = toPx(a), pb = toPx(b);
  if (pa !== null && pb !== null) return {agree: Math.abs(pa - pb) <= 1, distance: Math.abs(pa - pb)};
  const same = a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
  return {agree: same, distance: same ? 0 : 1};
}

export function mergeCandidates(candidates: readonly Candidate[]): MergeResult | null {
  if (!candidates.length) return null;
  const ordered = [...candidates].sort((a, b) => SOURCE_PRECEDENCE.indexOf(a.channel) - SOURCE_PRECEDENCE.indexOf(b.channel));
  const winner = ordered[0]!, channels = new Set(ordered.map(c => c.channel));
  const agreeing = ordered.filter(c => valuesAgree(c.value, winner.value).agree);
  const agreement = channels.size > 1 ? new Set(agreeing.map(c => c.channel)).size / channels.size : 1;
  const instances = ordered.reduce((sum, c) => sum + (c.instances ?? 1), 0);
  // Drift: what a guideline or design file declares differs from what production shows.
  const drift: MergeResult['drift'] = [];
  const observed = ordered.find(c => c.channel === 'observed_css');
  if (observed) for (const declared of ordered.filter(c => DECLARED.has(c.channel))) {
    const {agree, distance} = valuesAgree(declared.value, observed.value);
    if (!agree) drift.push({declared, observed, distance});
  }
  return {value: winner.value, winner: winner.channel, confidence: confidence(winner.channel, agreement, instances), agreement: Math.round(agreement * 100) / 100, candidates: ordered, drift};
}
