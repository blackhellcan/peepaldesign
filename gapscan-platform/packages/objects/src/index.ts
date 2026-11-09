// Missing architectural objects (architecture Part 3 §3.1). Facts come straight
// from the extraction; patterns GapScan infers say so; everything else is a
// drafted starting point that counts for nothing until a person approves it.
// Deterministic: no language model is called here; drafts requested from Claude
// (@gapscan/drafting) are stored separately and laid over the generated text.
import {createHash} from 'node:crypto';
import {contrastRatio, parseColor, toHex, toOklch} from '@gapscan/normalize';
import {exportTokens} from '@gapscan/exports';
import type {ArchitecturalObject, ComponentObservation, ExtractedDesignSystem, ObjectKind, ObjectSection, Token} from '@gapscan/schema';

export const OBJECT_TITLES: Record<ObjectKind, string> = {
  accessibility: 'Accessibility standard', guidelines: 'Guidelines and documentation', principles: 'Design principles',
  tooling: 'Tools and technologies', content: 'Content guidelines', brand: 'Brand identity',
};
const STATUS_WEIGHT = {present: 1, partial: 0.5, missing: 0};
const INTERACTIVE = new Set(['Actions', 'Forms and input', 'Navigation']);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const role = (eds: ExtractedDesignSystem, name: string) => eds.tokens.find(t => t.path === `color.${name}`);
const evidenceOf = (...tokens: (Token | undefined)[]) => tokens.flatMap(t => t?.evidence.slice(0, 3) ?? []);
const section = (s: Omit<ObjectSection, 'id'> & {id: string}): ObjectSection => s;
// Approvals are keyed to the content they approved; changed content becomes stale.
export const contentHash = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 16);

// Nearest foreground that passes: walk OKLCH lightness away from the background, keeping hue and chroma.
export function suggestPassingColor(foreground: string, background: string, target = 4.5): string | null {
  const fg = parseColor(foreground), bg = parseColor(background);
  if (!fg || !bg) return null;
  const {l, c, h} = toOklch(fg), bgL = toOklch(bg).l, direction = l > bgL ? 1 : -1;
  for (let step = 1; step <= 100; step++) {
    const lightness = Math.min(1, Math.max(0, l + direction * step * 0.01)), rad = h * Math.PI / 180;
    const candidate = parseColor(`oklab(${lightness} ${c * Math.cos(rad)} ${c * Math.sin(rad)})`);
    if (candidate && (contrastRatio(candidate, bg) ?? 0) >= target) return toHex(candidate);
  }
  return null;
}

function accessibility(eds: ExtractedDesignSystem): ObjectSection[] {
  const text = role(eds, 'text'), surface = role(eds, 'surface'), primary = role(eds, 'primary'), danger = role(eds, 'danger');
  const declaredTarget = eds.brandSignals.voiceSnippets.find(s => /WCAG\s*2\.\d|accessibility/i.test(s));
  const pairs = [[text, surface, 'Body text on surface'], [{value: '#FFFFFF'} as Token, primary, 'White text on primary'], [danger, surface, 'Error text on surface']] as const;
  const rows = pairs.flatMap(([fg, bg, label]) => {
    if (!fg || !bg) return [];
    const ratio = contrastRatio(String(fg.value), String(bg.value));
    if (ratio === null) return [];
    // Fix the text colour when it can move; white or black text on a brand colour means changing the background instead.
    const textFix = ratio < 4.5 ? suggestPassingColor(String(fg.value), String(bg.value)) : null;
    const backgroundFix = ratio < 4.5 && !textFix ? suggestPassingColor(String(bg.value), String(fg.value)) : null;
    const fix = textFix ? `Text \`${textFix}\`` : backgroundFix ? `Background \`${backgroundFix}\`` : '—';
    return [`| ${label} | \`${fg.value}\` on \`${bg.value}\` | ${ratio}:1 | ${ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large text only' : 'Fails'} | ${fix} |`];
  });
  const failures = eds.quirks.filter(q => q.kind === 'contrast_fail');
  const interactive = eds.components.filter(c => INTERACTIVE.has(c.category));
  const noFocus = interactive.filter(c => c.statesMissing.some(s => s.startsWith('focus')));
  return [
    section({id: 'target', title: 'Conformance target', status: declaredTarget ? 'present' : 'missing', provenance: declaredTarget ? 'extracted' : 'drafted', evidence: [],
      content: declaredTarget ? `From your guidelines: “${declaredTarget}”` : 'Draft: the product meets **WCAG 2.1 level AA** for every new and changed screen, verified before release. Choose AA or AAA and approve.'}),
    section({id: 'contrast', title: 'Colour contrast', status: rows.length ? (failures.length ? 'partial' : 'present') : 'missing', provenance: rows.length ? 'extracted' : 'drafted', evidence: [...evidenceOf(text, surface, primary, danger), ...failures.flatMap(f => f.evidence.slice(0, 2))],
      content: rows.length ? [`Body text needs 4.5:1 and large text (24px, or 18.66px bold) needs 3:1 (WCAG 1.4.3). Pairs from your colour roles:`, '', '| Pair | Colours | Ratio | Level | Fix |', '| --- | --- | --- | --- | --- |', ...rows,
        ...(failures.length ? ['', `${plural(failures.length, 'other place')} in your product currently fail${failures.length === 1 ? 's' : ''}:`, ...failures.slice(0, 8).map(f => `- ${f.summary}`)] : [])].join('\n')
        : 'No colour roles were found, so contrast could not be checked. Add your brand colours or a website source.'}),
    section({id: 'focus', title: 'Keyboard focus', status: !interactive.length ? 'missing' : noFocus.length ? 'partial' : 'present', provenance: interactive.length ? 'extracted' : 'drafted', evidence: noFocus.flatMap(c => c.evidence.slice(0, 2)),
      content: [`Every interactive element shows a visible focus indicator with at least 3:1 contrast against its surroundings (WCAG 2.4.7, 1.4.11).`, '',
        interactive.length ? (noFocus.length ? `Missing today on: ${noFocus.map(c => c.canonical).join(', ')}.` : `All ${plural(interactive.length, 'interactive component')} found have a focus style.`) : 'No interactive components were found to check.'].join('\n')}),
    section({id: 'keyboard', title: 'Keyboard behaviour', status: 'missing', provenance: 'drafted', evidence: [],
      content: ['Draft, based on the WAI-ARIA Authoring Practices for the components you have. Needs manual testing; automated checks cannot confirm this.', '',
        ...[...new Set(eds.components.map(c => c.category))].flatMap(category => ({
          'Actions': ['- **Buttons**: Enter and Space activate; disabled buttons stay focusable only when they explain why.'],
          'Forms and input': ['- **Fields**: Tab moves between fields; errors are announced and linked with `aria-describedby`.'],
          'Navigation': ['- **Tabs and menus**: arrow keys move within the group, Tab leaves it; the current item is marked with `aria-current` or `aria-selected`.'],
          'Overlays': ['- **Dialogs**: focus moves into the dialog, stays there, Escape closes it, and focus returns to the trigger.'],
        } as Record<string, string[]>)[category] ?? [])].join('\n')}),
    section({id: 'targets', title: 'Target size', status: 'missing', provenance: 'drafted', evidence: [],
      content: 'Draft: pointer targets are at least **24×24 px** (WCAG 2.2 AA, 2.5.8) and **44×44 px** where possible (WCAG 2.1 AAA, 2.5.5).'}),
    section({id: 'testing', title: 'How we test', status: 'missing', provenance: 'drafted', evidence: [],
      content: 'Draft: automated checks (axe) in CI on every change; a keyboard-only and screen-reader pass (VoiceOver and NVDA) before each release; contrast checked when tokens change. Automated checks do not certify conformance.'}),
  ];
}

function componentPage(c: ComponentObservation): string {
  return [`### ${c.canonical}`, `*${c.category}*${c.rawNames.length > 1 ? ` · also called ${c.rawNames.slice(1, 4).join(', ')}` : ''}`, '',
    c.variants.length ? `**Styles:** ${c.variants.map(v => v.name).join(', ')}` : '', c.sizes.length ? `**Sizes:** ${c.sizes.join(', ')}` : '',
    c.statesObserved.length ? `**States:** ${c.statesObserved.join(', ')}` : '', c.statesMissing.length ? `**Missing states:** ${c.statesMissing.join(', ')}` : '', '',
    '**When to use:** _Needs your input._', '**Do / don’t:** _Needs your input._'].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

function guidelines(eds: ExtractedDesignSystem): ObjectSection[] {
  const documented = new Set(eds.brandSignals.voiceSnippets.flatMap(s => eds.components.filter(c => s.toLowerCase().includes(c.canonical.toLowerCase())).map(c => c.id)));
  const rules = eds.quirks.filter(q => q.kind === 'implicit_rule');
  return [
    ...eds.components.slice(0, 60).map(c => section({id: `component-${c.id}`, title: c.canonical, status: documented.has(c.id) ? 'partial' : 'missing', provenance: 'extracted', evidence: c.evidence.slice(0, 3), content: componentPage(c)})),
    section({id: 'rules', title: 'Patterns we found', status: rules.length ? 'partial' : 'missing', provenance: rules.length ? 'inferred' : 'drafted', evidence: rules.flatMap(r => r.evidence.slice(0, 2)),
      content: rules.length ? rules.map(r => `- ${r.summary}`).join('\n') : 'No repeated patterns were strong enough to propose as rules yet.'}),
  ];
}

function principles(eds: ExtractedDesignSystem): ObjectSection[] {
  const candidates: {title: string; text: string; evidence: string[]}[] = [];
  const spacing = eds.tokens.filter(t => t.path.startsWith('space.'));
  const offScale = eds.quirks.find(q => q.kind === 'off_scale' && /spacing grid/.test(q.summary));
  if (spacing.length >= 3) candidates.push({title: 'Consistent rhythm', text: `Spacing comes from one scale (${spacing.slice(0, 6).map(t => t.value).join(', ')}).${offScale ? ' A few values still fall outside it.' : ''}`, evidence: []});
  const sizes = eds.tokens.filter(t => t.path.startsWith('font.size.'));
  if (sizes.length >= 3 && !eds.quirks.some(q => q.kind === 'off_scale' && /Font sizes/.test(q.summary))) candidates.push({title: 'Clear hierarchy', text: `Type sizes step evenly from ${sizes.map(t => String(t.value)).sort((a, b) => parseFloat(a) - parseFloat(b))[0]} up, so importance reads at a glance.`, evidence: []});
  const palette = eds.tokens.filter(t => t.path.startsWith('color.palette.'));
  const neutral = palette.filter(t => { const c = parseColor(String(t.value)); return c && toOklch(c).c < 0.03; });
  if (palette.length >= 4 && neutral.length / palette.length >= 0.5) candidates.push({title: 'Calm surfaces, purposeful colour', text: `${Math.round(neutral.length / palette.length * 100)}% of colours are neutrals; colour is kept for actions and status.`, evidence: []});
  if (eds.components.filter(c => INTERACTIVE.has(c.category)).every(c => !c.statesMissing.length) && eds.components.length) candidates.push({title: 'Every state considered', text: 'Interactive components define their hover, focus and disabled states.', evidence: []});
  return candidates.length
    ? candidates.map((c, i) => section({id: `candidate-${i + 1}`, title: c.title, status: 'missing', provenance: 'inferred', evidence: c.evidence, content: `Candidate principle, inferred from your system: ${c.text} Rename, reword or reject it.`}))
    : [section({id: 'workshop', title: 'Principles workshop', status: 'missing', provenance: 'drafted', evidence: [], content: 'Not enough patterns to suggest principles. Draft prompt for a team session: what should every screen feel like, and what will you never trade away?'})];
}

function tooling(eds: ExtractedDesignSystem): ObjectSection[] {
  const kinds = new Set(eds.sources.map(s => s.kind)), declared = eds.tokens.filter(t => t.confidence >= 0.8 && !t.path.startsWith('color.palette.'));
  const hardcoded = eds.quirks.filter(q => q.kind === 'hardcoded_value'), offScale = eds.quirks.filter(q => q.kind === 'off_scale');
  const stylelint = {extends: ['stylelint-config-standard'], plugins: ['stylelint-declaration-strict-value'], rules: {'scale-unlimited/declaration-strict-value': [['/color$/', 'fill', 'stroke', ...(offScale.length ? ['/^(margin|padding|gap)/'] : [])], {ignoreValues: ['transparent', 'inherit', 'currentColor', '0']}]}};
  return [
    section({id: 'detected', title: 'What you use today', status: declared.length ? 'partial' : 'missing', provenance: 'extracted', evidence: [],
      content: [`Sources read: ${[...kinds].join(', ') || 'none'}.`, `Declared tokens: ${declared.length}.`, kinds.has('figma') ? 'A Figma file is part of the system.' : 'No Figma file was supplied.'].join('\n')}),
    section({id: 'pipeline', title: 'Recommended token pipeline', status: 'missing', provenance: 'drafted', evidence: [],
      content: 'Draft: keep tokens in **W3C DTCG** JSON (`tokens.json`, generated below), build platform outputs with **Style Dictionary** (CSS variables, Tailwind theme, iOS, Android), and sync design-side values to **Figma Variables**. Version token releases with Changesets.'}),
    section({id: 'lint', title: 'Lint rules from your findings', status: 'missing', provenance: 'inferred', evidence: [...hardcoded, ...offScale].flatMap(q => q.evidence.slice(0, 2)),
      content: [`Seeded by ${plural(hardcoded.length, 'hard-coded value finding')} and ${plural(offScale.length, 'off-scale finding')}: raw colours${offScale.length ? ' and off-grid spacing' : ''} are rejected where a token exists.`, '', '```json', JSON.stringify(stylelint, null, 2), '```'].join('\n')}),
    section({id: 'tokens', title: 'tokens.json (DTCG)', status: declared.length ? 'partial' : 'missing', provenance: 'extracted', evidence: [],
      content: ['Generated from this extraction. Values marked inferred in `$extensions` were derived from usage.', '', '```json', exportTokens(eds, 'dtcg').slice(0, 4000), '```'].join('\n')}),
  ];
}

function content(eds: ExtractedDesignSystem): ObjectSection[] {
  const voice = eds.brandSignals.voiceSnippets;
  return [
    section({id: 'voice', title: 'Voice and tone', status: voice.length ? 'partial' : 'missing', provenance: voice.length ? 'extracted' : 'drafted', evidence: [],
      content: voice.length ? ['From your sources:', ...voice.slice(0, 12).map(v => `- “${v}”`)].join('\n') : 'No writing guidance was found. Draft questions: how formal are you, how playful, and what words do you avoid?'}),
    section({id: 'messages', title: 'Message patterns', status: 'missing', provenance: 'drafted', evidence: [],
      content: ['Draft templates:', '- **Error:** what happened, then how to fix it. “Your card was declined. Try another card or contact your bank.”', '- **Empty state:** what this is, then the first action. “No invoices yet. Create your first invoice.”', '- **Confirmation:** the consequence, with buttons named for the action. “Delete 3 files? This can’t be undone.” [Delete files] [Cancel]'].join('\n')}),
    section({id: 'mechanics', title: 'Writing mechanics', status: 'missing', provenance: 'drafted', evidence: [],
      content: 'Draft: sentence case for headings and buttons; buttons start with a verb; dates as “2 Nov 2026”; numbers as digits. Approve or adjust.'}),
  ];
}

function brand(eds: ExtractedDesignSystem): ObjectSection[] {
  const primary = role(eds, 'primary'), heading = eds.tokens.find(t => t.path === 'font.family.heading'), body = eds.tokens.find(t => t.path === 'font.family.body');
  const radius = eds.tokens.filter(t => t.path.startsWith('radius.'));
  const pillars = [
    primary && `**Colour:** led by ${primary.value}${toOklch(parseColor(String(primary.value)) ?? {r: 0, g: 0, b: 0, alpha: 1}).h > 180 && toOklch(parseColor(String(primary.value)) ?? {r: 0, g: 0, b: 0, alpha: 1}).h < 300 ? ', a cool, trustworthy tone' : ''}.`,
    (heading || body) && `**Type:** ${[heading && `${heading.value} for headings`, body && `${body.value} for text`].filter(Boolean).join(', ')}.`,
    radius.length && `**Shape:** ${radius.some(r => parseFloat(String(r.value)) >= 12) ? 'soft, rounded corners' : 'crisp, lightly rounded corners'} (${radius.map(r => r.value).join(', ')}).`,
  ].filter(Boolean);
  return [
    section({id: 'mission', title: 'Mission and positioning', status: 'missing', provenance: 'drafted', evidence: [],
      content: 'GapScan does not invent strategy. Questions for your team: who is this for, what do they get that they cannot get elsewhere, and how should they feel afterwards?'}),
    section({id: 'pillars', title: 'Visual pillars', status: pillars.length ? 'partial' : 'missing', provenance: pillars.length ? 'inferred' : 'drafted', evidence: evidenceOf(primary, heading, body),
      content: pillars.length ? ['Inferred from your tokens:', ...pillars.map(p => `- ${p}`)].join('\n') : 'No brand colour or type was found.'}),
    section({id: 'logo', title: 'Logo', status: eds.brandSignals.logoAssets.length ? 'partial' : 'missing', provenance: eds.brandSignals.logoAssets.length ? 'extracted' : 'drafted', evidence: [],
      content: eds.brandSignals.logoAssets.length ? `Logo files found: ${eds.brandSignals.logoAssets.join(', ')}. Clear space and minimum size still need writing down.` : 'No logo files were found. Upload your brand guide or deck to include them.'}),
  ];
}

const BUILDERS: Record<ObjectKind, (eds: ExtractedDesignSystem) => ObjectSection[]> = {accessibility, guidelines, principles, tooling, content, brand};

export type StoredApproval = {by: string; at: string; hash: string};
// A draft written on request (by Claude) replaces the generated text and is always marked drafted.
export type StoredDraft = {content: string; evidence: string[]; model: string; at: string; openQuestions: string[]; missing?: string[]};
// Facts read straight from the extraction are never rewritten; component pages are, since their usage notes need writing.
export const isDraftable = (section: ObjectSection) => section.provenance !== 'extracted' || section.id.startsWith('component-');

export function buildObjects(eds: ExtractedDesignSystem, approvals: Record<string, StoredApproval> = {}, drafts: Record<string, StoredDraft> = {}): ArchitecturalObject[] {
  return (Object.keys(BUILDERS) as ObjectKind[]).map(kind => {
    const sections = BUILDERS[kind](eds).map((s): ObjectSection => {
      const draft = drafts[`${kind}:${s.id}`];
      if (!draft || !isDraftable(s)) return s;
      // A whole-document draft says what's missing; with nothing missing the section is written.
      const status = draft.missing ? (draft.missing.length ? 'partial' as const : 'present' as const) : s.status;
      return {...s, status, content: draft.content, provenance: 'drafted', evidence: [...new Set([...s.evidence, ...draft.evidence])],
        draftedBy: {model: draft.model, at: draft.at, openQuestions: draft.openQuestions, original: s.content, ...(draft.missing ? {missing: draft.missing} : {})}};
    }).map(s => {
      const approval = approvals[`${kind}:${s.id}`];
      if (!approval) return s;
      return approval.hash === contentHash(s.content) ? {...s, approval: {by: approval.by, at: approval.at}} : {...s, stale: true};
    });
    // Whole documents written from the extraction count as they stand (half while gaps remain); other drafts count once approved.
    const score = sections.reduce((sum, s) => sum + (s.approval ? 1 : s.draftedBy?.missing ? STATUS_WEIGHT[s.status] : s.provenance === 'drafted' ? 0 : STATUS_WEIGHT[s.status]), 0);
    return {kind, title: OBJECT_TITLES[kind], edsId: eds.id, sections, completeness: sections.length ? Math.round(score / sections.length * 100) / 100 : 0};
  });
}
