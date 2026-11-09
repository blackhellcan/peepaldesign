// PPTX and DOCX adapters (Office Open XML). Both carry a DrawingML theme with
// colour slots and heading/body fonts; slides and documents add usage counts,
// text styles and the prose Part 3 needs for voice and guidelines.
import {openZip} from './zip.ts';
import type {ZipArchive} from './zip.ts';
import {attr, child, find, findAll, parseXml, textOf} from './xml.ts';
import type {XmlNode} from './xml.ts';
import {AdapterError} from './types.ts';
import type {Adapter, Observation} from './types.ts';

const SLOT_ROLES: Record<string, string> = {
  dk1: 'text', lt1: 'surface', dk2: 'text-secondary', lt2: 'surface-secondary',
  accent1: 'accent-1', accent2: 'accent-2', accent3: 'accent-3', accent4: 'accent-4', accent5: 'accent-5', accent6: 'accent-6',
  hlink: 'link', folHlink: 'link-visited',
};
const GUIDANCE_HEADING = /voice|tone|principle|mission|vision|values|accessib|writing|content|personality|brand/i;
const MAX_TEXT = 400;

function colorOf(node: XmlNode | undefined): string | undefined {
  const srgb = child(node, 'srgbClr'), sys = child(node, 'sysClr');
  const hex = attr(srgb, 'val') ?? attr(sys, 'lastClr');
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : undefined;
}

function themeObservations(xml: string, part: string, channel: Observation['channel']): Observation[] {
  const theme = parseXml(xml), out: Observation[] = [];
  const scheme = find(theme, 'clrScheme');
  for (const slot of scheme?.children ?? []) {
    const name = slot.name.slice(slot.name.indexOf(':') + 1), value = colorOf(slot);
    if (value) out.push({type: 'color', channel, value, name: `theme.${name}`, role: SLOT_ROLES[name] ?? name, locator: `${part}#clrScheme/${name}`});
  }
  for (const [kind, role] of [['majorFont', 'heading'], ['minorFont', 'body']] as const) {
    const family = attr(child(find(theme, kind), 'latin'), 'typeface');
    if (family) out.push({type: 'font', channel, family, role, locator: `${part}#fontScheme/${kind}`});
  }
  return out;
}

const naturalSort = (a: string, b: string) => a.localeCompare(b, undefined, {numeric: true});
const parts = (zip: ZipArchive, pattern: RegExp) => zip.entries.map(e => e.name).filter(n => pattern.test(n)).sort(naturalSort);
function open(bytes: Uint8Array, kind: string, marker: string): ZipArchive {
  const zip = openZip(bytes);
  if (!zip.has(marker)) throw new AdapterError(`This file is not a ${kind} document.`);
  return zip;
}
const pushText = (out: Observation[], channel: Observation['channel'], kind: 'voice' | 'heading' | 'microcopy' | 'rule', text: string, locator: string) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length >= 3) out.push({type: 'text', channel, kind, text: clean.slice(0, MAX_TEXT), locator});
};

export const pptxAdapter: Adapter = async ({bytes}, {signal}) => {
  const zip = open(bytes, 'PowerPoint (.pptx)', 'ppt/presentation.xml'), channel = 'pptx_theme' as const;
  const observations: Observation[] = [], failed: {locator: string; reason: string}[] = [];
  for (const part of parts(zip, /^ppt\/theme\/theme\d+\.xml$/).slice(0, 1)) observations.push(...themeObservations(zip.text(part)!, part, channel));

  const colorUse = new Map<string, number>(), sizes = new Map<string, {count: number; family?: string}>();
  const slides = parts(zip, /^ppt\/slides\/slide\d+\.xml$/);
  for (const part of slides) {
    signal.throwIfAborted();
    try {
      const slide = parseXml(zip.text(part)!);
      for (const node of findAll(slide, 'srgbClr')) { const v = attr(node, 'val'); if (v && /^[0-9a-f]{6}$/i.test(v)) colorUse.set('#' + v.toUpperCase(), (colorUse.get('#' + v.toUpperCase()) ?? 0) + 1); }
      for (const run of findAll(slide, 'rPr')) {
        const sz = attr(run, 'sz');   // hundredths of a point
        if (sz) { const key = `${Number(sz) / 100}pt`, entry = sizes.get(key) ?? {count: 0}; entry.count++; entry.family ??= attr(child(run, 'latin'), 'typeface'); sizes.set(key, entry); }
      }
      const titles = findAll(slide, 'sp').filter(sp => /title/i.test(attr(find(sp, 'ph'), 'type') ?? ''));
      for (const title of titles) pushText(observations, channel, 'heading', findAll(title, 't').map(textOf).join(' '), part);
      for (const paragraph of findAll(slide, 'p').slice(0, 40)) pushText(observations, channel, 'microcopy', findAll(paragraph, 't').map(textOf).join(''), part);
    } catch (error) { failed.push({locator: part, reason: error instanceof Error ? error.message : 'Unreadable slide.'}); }
  }
  for (const [value, count] of colorUse) observations.push({type: 'color', channel, value, property: 'fill', count, locator: 'ppt/slides'});
  for (const [size, {count, family}] of sizes) observations.push({type: 'font', channel, family: family ?? '', size, count, locator: 'ppt/slides'});
  for (const name of parts(zip, /^ppt\/media\//)) observations.push({type: 'asset', channel, kind: /logo/i.test(name) ? 'logo' : 'image', name, locator: name});
  for (const part of parts(zip, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/)) {
    const name = attr(find(parseXml(zip.text(part)!), 'cSld'), 'name');
    if (name) observations.push({type: 'text', channel, kind: 'rule', text: `Slide layout: ${name}`, locator: part});
  }
  return {observations, fetched: slides.length - failed.length, failed, budgetHit: false};
};

export const docxAdapter: Adapter = async ({bytes}, {signal}) => {
  const zip = open(bytes, 'Word (.docx)', 'word/document.xml'), channel = 'docx_styles' as const, observations: Observation[] = [];
  for (const part of parts(zip, /^word\/theme\/theme\d+\.xml$/).slice(0, 1)) observations.push(...themeObservations(zip.text(part)!, part, channel));
  const styles = zip.text('word/styles.xml');
  if (styles) for (const style of findAll(parseXml(styles), 'style')) {
    const name = attr(child(style, 'name'), 'val'), rPr = child(style, 'rPr');
    if (!name || !rPr) continue;
    const family = attr(child(rPr, 'rFonts'), 'ascii'), sz = attr(child(rPr, 'sz'), 'val'), color = attr(child(rPr, 'color'), 'val'), bold = child(rPr, 'b');
    const role = /^heading\s*1$|^title$/i.test(name) ? 'display' : /^heading/i.test(name) ? 'headline' : /^normal$|body/i.test(name) ? 'body' : /caption/i.test(name) ? 'caption' : name;
    if (family || sz) observations.push({type: 'font', channel, family: family ?? '', ...(sz ? {size: `${Number(sz) / 2}pt`} : {}), ...(bold ? {weight: '700'} : {}), role, locator: `word/styles.xml#${name}`});
    if (color && /^[0-9a-f]{6}$/i.test(color)) observations.push({type: 'color', channel, value: '#' + color.toUpperCase(), name: `style.${name}`, property: 'color', locator: `word/styles.xml#${name}`});
  }
  signal.throwIfAborted();
  // Paragraphs under a heading about voice, principles or accessibility are kept as guidance prose.
  let section: string | null = null, paragraphs = 0;
  for (const paragraph of findAll(parseXml(zip.text('word/document.xml')!), 'p')) {
    const style = attr(child(child(paragraph, 'pPr'), 'pStyle'), 'val') ?? '', text = findAll(paragraph, 't').map(textOf).join('').trim();
    if (!text) continue;
    paragraphs++;
    if (/^(heading|title)/i.test(style)) { section = text; pushText(observations, channel, 'heading', text, `word/document.xml#p${paragraphs}`); continue; }
    if (section && GUIDANCE_HEADING.test(section)) pushText(observations, channel, /voice|tone|personality/i.test(section) ? 'voice' : 'rule', text, `word/document.xml#${section}`);
  }
  return {observations, fetched: 1, failed: [], budgetHit: false};
};
