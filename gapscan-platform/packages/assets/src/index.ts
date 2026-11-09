// Asset engine (architecture Part 3 §3.2): BrandKit → template → renderer → checks.
// Templates read token slots, never raw values; every output carries the checks
// it passed or failed so nothing ships with unreadable text by accident.
import {contrastRatio, parseColor, toHex, toOklch} from '@gapscan/normalize';
import type {ExtractedDesignSystem} from '@gapscan/schema';
import {buildDeck, officeFont} from './deck.ts';
export {buildDeck} from './deck.ts';
export type {DeckContent} from './deck.ts';

export type BrandKit = {
  edsId: string; name: string;
  colors: {primary: string; onPrimary: string; text: string; surface: string; accent: string};
  fonts: {heading: string; body: string};
  radius: string;
  inferred: string[];               // slots filled by fallback rather than from the extraction
};

const FALLBACK = {primary: '#1F2937', text: '#111111', surface: '#FFFFFF', font: 'system-ui'};
const hexOf = (value: unknown) => { const c = parseColor(String(value ?? '')); return c ? toHex({...c, alpha: 1}) : null; };
// Black or white, whichever reads better on the colour.
export const onColor = (background: string) => (contrastRatio('#FFFFFF', background) ?? 0) >= (contrastRatio('#111111', background) ?? 0) ? '#FFFFFF' : '#111111';

export function buildBrandKit(eds: ExtractedDesignSystem, name = 'Your brand'): BrandKit {
  const inferred: string[] = [];
  const pick = (paths: string[], fallback: string, slot: string) => {
    for (const path of paths) { const hex = hexOf(eds.tokens.find(t => t.path === path)?.value); if (hex) return hex; }
    inferred.push(slot); return fallback;
  };
  const primary = pick(['color.primary'], FALLBACK.primary, 'primary colour');
  const text = pick(['color.text'], FALLBACK.text, 'text colour');
  const surface = pick(['color.surface'], FALLBACK.surface, 'surface colour');
  const accent = pick(['color.success', 'color.info', 'color.warning'], primary, 'accent colour');
  const font = (paths: string[], slot: string) => { const value = eds.tokens.find(t => paths.includes(t.path))?.value; if (value) return String(value); inferred.push(slot); return FALLBACK.font; };
  const body = font(['font.family.body'], 'body font'), heading = eds.tokens.find(t => t.path === 'font.family.heading')?.value ? String(eds.tokens.find(t => t.path === 'font.family.heading')!.value) : body;
  const radius = String(eds.tokens.find(t => t.path === 'radius.md' || t.path === 'radius.sm')?.value ?? '6px');
  return {edsId: eds.id, name, colors: {primary, onPrimary: onColor(primary), text, surface, accent}, fonts: {heading, body}, radius, inferred};
}

export type Check = {rule: string; pass: boolean; message: string};
export type Template = {id: string; label: string; format: {width: string; height: string; bleed?: string; dpi?: number; pixels?: {width: number; height: number}}; output: 'pdf' | 'png' | 'pptx' | 'html'; fields: string[]};
// The PDF page actually printed: trim size, plus bleed, plus room for crop marks where the template has them.
export const PDF_PAGES: Record<string, {width: string; height: string}> = {
  'business-card': {width: '91mm', height: '61mm'}, 'business-card-print': {width: '103mm', height: '73mm'},
  'letterhead-a4': {width: '210mm', height: '297mm'}, 'letterhead-letter': {width: '8.5in', height: '11in'},
};
export const TEMPLATES: Record<string, Template> = {
  'business-card': {id: 'business-card', label: 'Business card (85 × 55 mm, 3 mm bleed)', format: {width: '85mm', height: '55mm', bleed: '3mm', dpi: 300}, output: 'pdf', fields: ['name', 'role', 'email', 'phone', 'website']},
  'og-image': {id: 'og-image', label: 'OpenGraph image (1200 × 630)', format: {width: '1200px', height: '630px', pixels: {width: 1200, height: 630}}, output: 'png', fields: ['title', 'subtitle']},
  'slide-deck': {id: 'slide-deck', label: 'Slide deck template (PowerPoint, 16:9)', format: {width: '13.333in', height: '7.5in'}, output: 'pptx', fields: ['title', 'subtitle', 'points']},
  'email': {id: 'email', label: 'Email newsletter (600 px, HTML)', format: {width: '600px', height: 'auto'}, output: 'html', fields: ['title', 'body', 'cta', 'url']},
  'social-banner': {id: 'social-banner', label: 'LinkedIn banner (1584 × 396)', format: {width: '1584px', height: '396px', pixels: {width: 1584, height: 396}}, output: 'png', fields: ['title', 'subtitle']},
  'business-card-print': {id: 'business-card-print', label: 'Business card for print shops (85 × 55 mm, 3 mm bleed, crop marks)', format: {width: '85mm', height: '55mm', bleed: '3mm', dpi: 300}, output: 'pdf', fields: ['name', 'role', 'email', 'phone', 'website']},
  'letterhead-a4': {id: 'letterhead-a4', label: 'Letterhead (A4, PDF)', format: {width: '210mm', height: '297mm'}, output: 'pdf', fields: ['address', 'email', 'phone', 'website', 'body']},
  'letterhead-letter': {id: 'letterhead-letter', label: 'Letterhead (US Letter, PDF)', format: {width: '8.5in', height: '11in'}, output: 'pdf', fields: ['address', 'email', 'phone', 'website', 'body']},
  'email-signature': {id: 'email-signature', label: 'Email signature (Gmail, Outlook, Apple Mail)', format: {width: '480px', height: 'auto'}, output: 'html', fields: ['name', 'role', 'email', 'phone', 'website']},
};

// Printers work in CMYK. Without the printer's colour profile this is a plain conversion: a starting
// point to ask for, never a match. Pantone references need Pantone's licensed library, so none are given.
export function approximateCmyk(hex: string): [number, number, number, number] {
  const c = parseColor(hex)!, k = 1 - Math.max(c.r, c.g, c.b);
  if (k >= 0.999) return [0, 0, 0, 100];
  const part = (v: number) => Math.round((1 - v - k) / (1 - k) * 100);
  return [part(c.r), part(c.g), part(c.b), Math.round(k * 100)];
}
function printColourCheck(kit: BrandKit): Check {
  const list = (['primary', 'text', 'accent'] as const).map(slot => { const [c, m, y, k] = approximateCmyk(kit.colors[slot]); return `${slot} ${kit.colors[slot]} ≈ C${c} M${m} Y${y} K${k}`; });
  return {rule: 'print-colours', pass: false, message: `Screen colours (RGB) print differently. Approximate CMYK: ${list.join('; ')}. Ask your printer for a proof before a full run.`};
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);
const fontStack = (family: string) => `${/[\s,]/.test(family) && !family.includes(',') ? JSON.stringify(family) : family}, system-ui, -apple-system, "Segoe UI", sans-serif`;

function check(rule: string, foreground: string, background: string, needed: number, label: string): Check {
  const ratio = contrastRatio(foreground, background) ?? 0;
  return {rule, pass: ratio >= needed, message: `${label}: ${ratio}:1 (needs ${needed}:1)`};
}

export type RenderPlan = {template: Template; html: string; checks: Check[]; page?: {width: string; height: string}};
// Produces self-contained HTML (no external requests) for the renderer, plus its checks.
export function planAsset(templateId: string, kit: BrandKit, data: Record<string, string>): RenderPlan {
  const template = TEMPLATES[templateId];
  if (!template) throw new Error(`Unknown template ${templateId}.`);
  const field = (name: string, fallback = '') => escape((data[name] ?? fallback).slice(0, 160));
  const {colors, fonts} = kit, checks: Check[] = [];
  if (kit.inferred.length) checks.push({rule: 'brand-slots', pass: false, message: `Filled with defaults because they were not found: ${kit.inferred.join(', ')}.`});
  const darkPrimary = toOklch(parseColor(colors.primary)!).l < 0.55;
  if (templateId === 'email') {
    // Email clients ignore most CSS: tables, inline styles and a VML-free bulletproof button.
    const font = `${fontStack(fonts.body).replace(/"/g, "'")}`, heading = `${fontStack(fonts.heading).replace(/"/g, "'")}`;
    const url = /^https:\/\//.test(data.url ?? '') ? field('url') : '#';
    checks.push(check('button-contrast', colors.onPrimary, colors.primary, 4.5, 'Button text'), check('body-contrast', colors.text, colors.surface, 4.5, 'Body text'));
    if (url === '#') checks.push({rule: 'link', pass: false, message: 'Add an https:// link for the button.'});
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${field('title', kit.name)}</title>
<style>@media (prefers-color-scheme: dark) { .bg { background: #111111 !important; } .card { background: #1c1c1c !important; } .text { color: #eeeeee !important; } }</style></head>
<body style="margin:0;padding:0;background:#f4f4f5" class="bg"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5" class="bg"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${colors.surface};border-radius:${kit.radius}" class="card">
<tr><td style="background:${colors.primary};padding:20px 32px;border-radius:${kit.radius} ${kit.radius} 0 0;font-family:${heading};font-size:18px;font-weight:700;color:${colors.onPrimary}">${escape(kit.name)}</td></tr>
<tr><td class="text" style="padding:32px;font-family:${font};color:${colors.text}">
<h1 style="margin:0 0 16px;font-family:${heading};font-size:26px;line-height:1.25">${field('title', 'Newsletter title')}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6">${escape((data.body ?? 'Write your update here.').slice(0, 1200)).replace(/\n/g, '<br>')}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${colors.primary};border-radius:${kit.radius}"><a href="${url}" style="display:inline-block;padding:12px 24px;font-family:${font};font-size:16px;font-weight:600;color:${colors.onPrimary};text-decoration:none">${field('cta', 'Read more')}</a></td></tr></table>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-family:${font};font-size:12px;color:#6b7280" class="text">You are receiving this because you subscribed to ${escape(kit.name)} updates.</td></tr>
</table></td></tr></table></body></html>`;
    return {template, html, checks};
  }
  if (templateId === 'slide-deck') {
    // A .pptx names fonts but cannot carry a fallback stack: presenters need them installed or embedded.
    const fonts = [...new Set([kit.fonts.heading, kit.fonts.body].map(officeFont))], substituted = [kit.fonts.heading, kit.fonts.body].some(f => officeFont(f) !== f.split(',')[0]!.replace(/['"]/g, '').trim());
    checks.push(check('title-contrast', colors.onPrimary, colors.primary, 3, 'Title slide text'), check('body-contrast', colors.text, colors.surface, 4.5, 'Body text on slides'),
      {rule: 'fonts', pass: fonts.every(f => /^(arial|helvetica|calibri|segoe ui|georgia|verdana)$/i.test(f)), message: `Theme fonts: ${fonts.join(', ')}.${substituted ? ' Your CSS uses a system font keyword, so Arial stands in.' : ''} Install or embed them on every machine that presents this deck.`});
    return {template, html: '', checks};
  }
  if (templateId === 'business-card' || templateId === 'business-card-print') {
    // Trim size plus bleed on every side; content stays inside a 4 mm safe zone. The print-shop version
    // adds 6 mm round the bleed for crop marks at the trim lines.
    checks.push(check('name-contrast', colors.text, colors.surface, 4.5, 'Name on card'), check('band-contrast', colors.onPrimary, colors.primary, 3, 'Brand band text'));
    const marks = templateId === 'business-card-print', slug = marks ? 6 : 0, page = PDF_PAGES[templateId]!;
    const card = `<div class="card"><div class="band"></div><div class="mark"></div><div class="safe">
<div><h1>${field('name', 'Your Name')}</h1><div class="role">${field('role', 'Role')}</div></div>
<div class="contact">${[field('email'), field('phone'), field('website')].filter(Boolean).join('<br>')}</div>
<div class="brand">${escape(kit.name)}</div></div></div>`;
    // Crop marks: hairlines in the slug on the trim lines (3 mm bleed + 6 mm slug from the page edge), stopping 1 mm short of the bleed.
    const trim = [slug + 3, slug + 3 + 85], trimY = [slug + 3, slug + 3 + 55];
    const cropMarks = marks ? [...trim.flatMap(x => [`<i style="left:${x}mm;top:0;width:0;height:${slug - 1}mm;border-left:.25pt solid #000"></i>`, `<i style="left:${x}mm;bottom:0;width:0;height:${slug - 1}mm;border-left:.25pt solid #000"></i>`]),
      ...trimY.flatMap(y => [`<i style="top:${y}mm;left:0;height:0;width:${slug - 1}mm;border-top:.25pt solid #000"></i>`, `<i style="top:${y}mm;right:0;height:0;width:${slug - 1}mm;border-top:.25pt solid #000"></i>`])].join('') : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${page.width} ${page.height}; margin: 0 }
html, body { margin: 0; width: ${page.width}; height: ${page.height}; }
body { background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; position: relative; overflow: hidden; }
.card { position: absolute; left: ${slug}mm; top: ${slug}mm; width: 91mm; height: 61mm; background: ${colors.surface}; color: ${colors.text}; font-family: ${fontStack(fonts.body)}; overflow: hidden; }
.band { position: absolute; left: 0; top: 0; bottom: 0; width: 17mm; background: ${colors.primary}; }
.mark { position: absolute; left: 7mm; top: 7mm; width: 10mm; height: 10mm; border-radius: ${kit.radius}; background: ${colors.onPrimary}; opacity: .92; }
.safe { position: absolute; left: 24mm; top: 7mm; right: 7mm; bottom: 7mm; display: flex; flex-direction: column; justify-content: space-between; }
h1 { font-family: ${fontStack(fonts.heading)}; font-size: 11pt; margin: 0; letter-spacing: -0.01em; }
.role { font-size: 7.5pt; color: ${colors.primary === colors.surface ? colors.text : colors.primary}; margin-top: 1mm; }
.contact { font-size: 7pt; line-height: 1.5; }
.brand { font-family: ${fontStack(fonts.heading)}; font-weight: 700; font-size: 8pt; }
i { position: absolute; display: block; }
</style></head><body>${card}${cropMarks}</body></html>`;
    if (contrastRatio(colors.primary, colors.surface)! < 3) checks.push({rule: 'role-contrast', pass: false, message: 'The role line uses the brand colour, which is low-contrast on the card background.'});
    if (marks) checks.push({rule: 'print-setup', pass: true, message: 'Page is 103 × 73 mm: the 85 × 55 mm card, 3 mm bleed on each side and crop marks at the trim lines.'});
    checks.push(printColourCheck(kit));
    return {template, html, checks, page};
  }
  if (templateId === 'letterhead-a4' || templateId === 'letterhead-letter') {
    // Office-printer friendly: no bleed, everything inside 15 mm of the edge. The letter body is optional.
    checks.push(check('body-contrast', colors.text, colors.surface, 4.5, 'Letter text'), check('accent-contrast', colors.primary, colors.surface, 3, 'Brand name on paper'));
    const page = PDF_PAGES[templateId]!, body = escape((data.body ?? '').slice(0, 4000));
    const contact = [field('address'), field('email'), field('phone'), field('website')].filter(Boolean);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${page.width} ${page.height}; margin: 0 }
html, body { margin: 0; width: ${page.width}; height: ${page.height}; }
body { background: ${colors.surface}; color: ${colors.text}; font-family: ${fontStack(fonts.body)}; -webkit-print-color-adjust: exact; print-color-adjust: exact; position: relative; overflow: hidden; }
.bar { position: absolute; left: 0; right: 0; top: 0; height: 4mm; background: ${colors.primary}; }
header { position: absolute; left: 20mm; right: 20mm; top: 18mm; display: flex; align-items: center; gap: 4mm; }
header i { width: 9mm; height: 9mm; border-radius: ${kit.radius}; background: ${colors.primary}; display: block; }
header b { font-family: ${fontStack(fonts.heading)}; font-size: 15pt; letter-spacing: -0.01em; color: ${contrastRatio(colors.primary, colors.surface)! >= 3 ? colors.primary : colors.text}; }
main { position: absolute; left: 20mm; right: 20mm; top: 50mm; bottom: 35mm; font-size: 10.5pt; line-height: 1.55; white-space: pre-wrap; overflow: hidden; }
footer { position: absolute; left: 20mm; right: 20mm; bottom: 15mm; border-top: .5pt solid ${colors.primary}; padding-top: 3mm; font-size: 8pt; display: flex; flex-wrap: wrap; gap: 2mm 8mm; opacity: .9; }
</style></head><body><div class="bar"></div><header><i></i><b>${escape(kit.name)}</b></header><main>${body}</main>
<footer>${contact.map(c => `<span>${c}</span>`).join('') || `<span>${escape(kit.name)}</span>`}</footer></body></html>`;
    if (!contact.length) checks.push({rule: 'contact', pass: false, message: 'Add an address, email, phone or website for the footer.'});
    checks.push(printColourCheck(kit));
    return {template, html, checks, page};
  }
  if (templateId === 'email-signature') {
    // Signatures are pasted into mail clients: one table, inline styles, web-safe fonts, no images, under Gmail's 10,000-character limit.
    const font = `${fontStack(fonts.body).replace(/"/g, "'")}, Arial, Helvetica, sans-serif`, accent = contrastRatio(colors.primary, '#ffffff')! >= 4.5 ? colors.primary : colors.text;
    const email = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(data.email ?? '') ? field('email') : '';
    const website = /^https:\/\/[^\s<>"']+$/.test(data.website ?? '') ? field('website') : '';
    const phone = field('phone').replace(/[^\d+() .-]/g, '');
    const initial = escape((kit.name.trim()[0] ?? 'B').toUpperCase());
    const row = (label: string, value: string, href?: string) => value ? `<tr><td style="padding:1px 8px 1px 0;font:12px ${font};color:#6b7280">${label}</td><td style="padding:1px 0;font:12px ${font}">${href ? `<a href="${href}" style="color:${accent};text-decoration:none">${value}</a>` : value}</td></tr>` : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${field('name', 'Email signature')}</title></head><body style="margin:16px;background:#ffffff">
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;color:#111111"><tr>
<td valign="top" style="padding:0 14px 0 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="44" height="44" align="center" valign="middle" style="width:44px;height:44px;background:${colors.primary};border-radius:${kit.radius};font:700 20px ${font};color:${colors.onPrimary}">${initial}</td></tr></table></td>
<td valign="top" style="border-left:2px solid ${colors.primary};padding:0 0 0 14px">
<div style="font:700 15px ${font};color:#111111">${field('name', 'Your Name')}</div>
<div style="font:13px ${font};color:${accent};padding:1px 0 6px">${[field('role'), escape(kit.name)].filter(Boolean).join(' · ')}</div>
<table role="presentation" cellpadding="0" cellspacing="0">${row('Email', email, email ? `mailto:${email}` : undefined)}${row('Phone', phone, phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : undefined)}${row('Web', website.replace(/^https:\/\//, ''), website || undefined)}</table>
</td></tr></table></body></html>`;
    checks.push(check('name-contrast', '#111111', '#ffffff', 4.5, 'Name on a white email'), check('accent-contrast', accent, '#ffffff', 4.5, 'Role and links on a white email'),
      {rule: 'size', pass: html.length < 10_000, message: `${html.length.toLocaleString('en')} characters (Gmail allows 10,000).`},
      {rule: 'install', pass: true, message: 'Open the file in a browser, select all, copy, and paste it into the signature setting of Gmail, Outlook or Apple Mail.'});
    if (data.email && !email) checks.push({rule: 'email', pass: false, message: 'The email address doesn’t look valid, so it was left out.'});
    if (data.website && !website) checks.push({rule: 'website', pass: false, message: 'Use a full https:// address for the website.'});
    return {template, html, checks};
  }
  const {width, height} = template.format.pixels!;
  const background = darkPrimary ? colors.primary : colors.surface, foreground = darkPrimary ? colors.onPrimary : colors.text;
  checks.push(check('title-contrast', foreground, background, templateId === 'og-image' ? 3 : 4.5, 'Title on background'));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: ${width}px; height: ${height}px; }
body { background: ${background}; color: ${foreground}; font-family: ${fontStack(fonts.body)}; display: flex; flex-direction: column; justify-content: center; padding: 0 ${Math.round(width * 0.07)}px; box-sizing: border-box; position: relative; overflow: hidden; }
.accent { position: absolute; right: -${Math.round(height * 0.25)}px; bottom: -${Math.round(height * 0.25)}px; width: ${Math.round(height * 0.9)}px; height: ${Math.round(height * 0.9)}px; border-radius: 50%; background: ${darkPrimary ? colors.accent : colors.primary}; opacity: .18; }
h1 { font-family: ${fontStack(fonts.heading)}; font-size: ${Math.round(height * (templateId === 'og-image' ? 0.1 : 0.16))}px; line-height: 1.1; margin: 0 0 ${Math.round(height * 0.04)}px; max-width: 80%; letter-spacing: -0.02em; }
p { font-size: ${Math.round(height * (templateId === 'og-image' ? 0.045 : 0.07))}px; margin: 0; opacity: .85; max-width: 75%; }
.brand { position: absolute; left: ${Math.round(width * 0.07)}px; bottom: ${Math.round(height * 0.08)}px; font-weight: 700; font-size: ${Math.round(height * 0.04)}px; display: flex; align-items: center; gap: 10px; }
.brand i { width: ${Math.round(height * 0.05)}px; height: ${Math.round(height * 0.05)}px; border-radius: ${kit.radius}; background: ${darkPrimary ? colors.onPrimary : colors.primary}; }
</style></head><body><div class="accent"></div><h1>${field('title', kit.name)}</h1><p>${field('subtitle')}</p><div class="brand"><i></i>${escape(kit.name)}</div></body></html>`;
  return {template, html, checks};
}

export type RenderOutput = {file: string; contentType: string; bytes: Uint8Array};
export type BrowserPage = {
  setContent(html: string, options?: {waitUntil?: 'load'}): Promise<void>;
  pdf(options: {width: string; height: string; printBackground: boolean; pageRanges?: string}): Promise<Uint8Array>;
  screenshot(options: {type: 'png'; fullPage?: boolean}): Promise<Uint8Array>;
  setViewportSize(size: {width: number; height: number}): Promise<void>;
  route?(url: string, handler: (route: {abort(): Promise<void>}) => Promise<void>): Promise<unknown>;
};

// Renders in a page with no network access: templates are self-contained by construction.
// Decks need no browser: the file is built directly from the brand kit.
export function renderDeck(kit: BrandKit, data: Record<string, string>): RenderOutput {
  const points = (data.points ?? '').split(/\n|;/).map(p => p.trim()).filter(Boolean).slice(0, 8);
  return {file: 'slide-deck.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: buildDeck(kit, {...(data.title ? {title: data.title.slice(0, 120)} : {}), ...(data.subtitle ? {subtitle: data.subtitle.slice(0, 160)} : {}), ...(points.length ? {points} : {})})};
}

export async function renderAsset(page: BrowserPage, plan: RenderPlan): Promise<RenderOutput> {
  await page.route?.('**/*', route => route.abort());
  if (plan.template.output === 'pdf') {
    await page.setContent(plan.html, {waitUntil: 'load'});
    const size = plan.page ?? PDF_PAGES[plan.template.id] ?? {width: '91mm', height: '61mm'};
    return {file: `${plan.template.id}.pdf`, contentType: 'application/pdf', bytes: await page.pdf({...size, printBackground: true, pageRanges: '1'})};
  }
  const {width, height} = plan.template.format.pixels!;
  await page.setViewportSize({width, height});
  await page.setContent(plan.html, {waitUntil: 'load'});
  return {file: `${plan.template.id}.png`, contentType: 'image/png', bytes: await page.screenshot({type: 'png'})};
}
