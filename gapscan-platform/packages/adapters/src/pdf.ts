// PDF brand-guideline adapter (architecture Part 1 §1.3). Reads text with pdf.js,
// never runs embedded scripts, and collects: colour values written next to
// swatches (hex, RGB, CMYK, Pantone), vector fill colours, embedded font names,
// type sizes, and prose under voice/principle/accessibility headings.
import {getDocument, OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {toHex, cmykToRgb} from '@gapscan/normalize';
import {AdapterError} from './types.ts';
import type {Adapter, Observation} from './types.ts';

export const PDF_LIMITS = Object.freeze({pages: 80, bytes: 40_000_000});
const GUIDANCE_HEADING = /voice|tone|principle|mission|vision|values|accessib|writing|content|personality/i;
const channel = 'pdf_guideline' as const;

type Line = {text: string; size: number; y: number};
const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const RGB = /\bRGB\s*:?\s*(\d{1,3})[\s,/]+(\d{1,3})[\s,/]+(\d{1,3})\b|\bR\s*(\d{1,3})\s*G\s*(\d{1,3})\s*B\s*(\d{1,3})\b/i;
const CMYK = /\bCMYK\s*:?\s*(\d{1,3})[\s,/]+(\d{1,3})[\s,/]+(\d{1,3})[\s,/]+(\d{1,3})\b|\bC\s*(\d{1,3})\s*M\s*(\d{1,3})\s*Y\s*(\d{1,3})\s*K\s*(\d{1,3})\b/i;
const PANTONE = /\b(?:PMS|Pantone)\s*([0-9]{2,4}\s*[A-Z]{0,2}|[A-Za-z]+(?:\s[A-Za-z]+)?\s*C)\b/i;
const isLabel = (text: string) => /^[A-Za-z][A-Za-z &'-]{1,40}$/.test(text) && !/^(RGB|CMYK|HEX|PMS|Pantone)\b/i.test(text);

function linesOf(items: {str: string; transform: number[]}[]): Line[] {
  const rows = new Map<number, {parts: {x: number; str: string}[]; size: number}>();
  for (const item of items) {
    if (!item.str.trim()) continue;
    const [a = 0, b = 0, , , x = 0, y = 0] = item.transform, size = Math.round(Math.hypot(a, b) * 10) / 10, key = Math.round(y);
    const row = rows.get(key) ?? {parts: [], size: 0};
    row.parts.push({x, str: item.str}); row.size = Math.max(row.size, size); rows.set(key, row);
  }
  return [...rows].sort((p, q) => q[0] - p[0]).map(([y, row]) => ({y, size: row.size, text: row.parts.sort((p, q) => p.x - q.x).map(p => p.str).join(' ').replace(/\s+/g, ' ').trim()}));
}

// Colour specs on guideline pages sit in small blocks: a label, then HEX / RGB / CMYK / Pantone lines.
function colourSpecs(lines: Line[], page: number): Observation[] {
  const out: Observation[] = [];
  lines.forEach((line, index) => {
    const window = lines.slice(Math.max(0, index - 3), index + 4);
    const label = [...lines.slice(Math.max(0, index - 3), index + 1)].reverse().find(l => isLabel(l.text))?.text;
    const print = [window.map(l => l.text.match(CMYK)?.[0]).find(Boolean), window.map(l => l.text.match(PANTONE)?.[0]).find(Boolean)].filter(Boolean).join('; ');
    for (const match of line.text.matchAll(HEX)) {
      out.push({type: 'color', channel, value: '#' + match[1]!.toUpperCase(), ...(label ? {name: label} : {}), locator: `page ${page}`, raw: [line.text, print].filter(Boolean).join(' | ')});
    }
    const rgb = line.text.match(RGB);
    if (rgb && !HEX.test(line.text)) {
      const [r, g, b] = (rgb[1] ? rgb.slice(1, 4) : rgb.slice(4, 7)).map(Number) as [number, number, number];
      if ([r, g, b].every(v => v <= 255)) out.push({type: 'color', channel, value: toHex({r: r / 255, g: g / 255, b: b / 255, alpha: 1}).toUpperCase(), ...(label ? {name: label} : {}), locator: `page ${page}`, raw: [line.text, print].filter(Boolean).join(' | ')});
    }
    HEX.lastIndex = 0;
  });
  // CMYK-only specs (common in print guides) become approximate screen colours, flagged in raw.
  if (!out.length) for (const [index, line] of lines.entries()) {
    const cmyk = line.text.match(CMYK);
    if (!cmyk) continue;
    const [c, m, y, k] = (cmyk[1] ? cmyk.slice(1, 5) : cmyk.slice(5, 9)).map(n => Number(n) / 100) as [number, number, number, number];
    const label = lines.slice(Math.max(0, index - 3), index + 1).reverse().find(l => isLabel(l.text))?.text;
    out.push({type: 'color', channel, value: toHex(cmykToRgb(c, m, y, k)).toUpperCase(), ...(label ? {name: label} : {}), locator: `page ${page}`, raw: `${line.text} | approximate screen value from CMYK`});
  }
  return out;
}

const fillHex = (args: unknown): string | null => {
  if (typeof args === 'string' && /^#[0-9a-f]{6}$/i.test(args)) return args.toUpperCase();
  if (Array.isArray(args)) {
    const first = args[0];
    if (typeof first === 'string' && /^#[0-9a-f]{6}$/i.test(first)) return first.toUpperCase();
    const nums = args.flat().filter((n): n is number => typeof n === 'number');
    if (nums.length >= 3) return toHex({r: nums[0]! / (nums[0]! > 1 ? 255 : 1), g: nums[1]! / (nums[1]! > 1 ? 255 : 1), b: nums[2]! / (nums[2]! > 1 ? 255 : 1), alpha: 1}).toUpperCase();
  }
  return null;
};

export const pdfAdapter: Adapter = async ({bytes}, {signal}) => {
  if (bytes.byteLength > PDF_LIMITS.bytes) throw new AdapterError('Use a PDF smaller than 40 MB.');
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new AdapterError('This file is not a PDF.');
  // pdf.js 6 tears documents down through the loading task.
  let pdf, task: ReturnType<typeof getDocument> | undefined;
  try {
    task = getDocument({data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0});
    pdf = await task.promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AdapterError(/password/i.test(message) ? 'This PDF is password-protected. Remove the password and upload it again.' : `This PDF could not be read: ${message}`);
  }
  const observations: Observation[] = [], failed: {locator: string; reason: string}[] = [], fontNames = new Set<string>();
  const sizes = new Map<number, number>(), fills = new Map<string, number>(), pages = Math.min(pdf.numPages, PDF_LIMITS.pages);
  let section: string | null = null, bodySize = 0;
  try {
    for (let n = 1; n <= pages; n++) {
      signal.throwIfAborted();
      try {
        const page = await pdf.getPage(n), content = await page.getTextContent();
        const lines = linesOf(content.items.filter((i): i is typeof i & {str: string; transform: number[]} => 'str' in i));
        for (const line of lines) sizes.set(line.size, (sizes.get(line.size) ?? 0) + 1);
        bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
        observations.push(...colourSpecs(lines, n));
        for (const line of lines) {
          if (bodySize && line.size >= bodySize * 1.3) { section = line.text; observations.push({type: 'text', channel, kind: 'heading', text: line.text.slice(0, 400), locator: `page ${n}`}); continue; }
          if (section && GUIDANCE_HEADING.test(section) && line.text.length > 20)
            observations.push({type: 'text', channel, kind: /voice|tone|personality/i.test(section) ? 'voice' : 'rule', text: line.text.slice(0, 400), locator: `page ${n} · ${section}`});
        }
        const ops = await page.getOperatorList();
        ops.fnArray.forEach((fn: number, i: number) => {
          if (fn === OPS.setFillRGBColor || fn === OPS.setFillColor) { const hex = fillHex(ops.argsArray[i]); if (hex) fills.set(hex, (fills.get(hex) ?? 0) + 1); }
          if (fn === OPS.setFont) {
            // pdf.js 5 exposes the font's PostScript name as `name`; pdf.js 6 as `loadedName`.
            const font = page.commonObjs.has(ops.argsArray[i]?.[0]) ? page.commonObjs.get(ops.argsArray[i][0]) as {name?: string; loadedName?: string} : undefined;
            const name = [font?.name, font?.loadedName].find(n => n && !/^g_d\d/.test(n))?.replace(/^[A-Z]{6}\+/, '');
            if (name) fontNames.add(name);
          }
        });
        page.cleanup();
      } catch (error) {
        if (signal.aborted) throw error;
        failed.push({locator: `page ${n}`, reason: error instanceof Error ? error.message : 'Unreadable page.'});
      }
    }
  } finally { await task.destroy(); }
  for (const [value, count] of fills) if (value !== '#000000' && value !== '#FFFFFF') observations.push({type: 'color', channel, value, property: 'fill', count, locator: 'vector fills'});
  const families = [...fontNames].map(name => name.replace(/[-,](Bold|Regular|Medium|Light|Italic|Semibold|SemiBold|Black|Book|Heavy|Thin)+$/i, ''));
  const family = [...new Set(families)];
  for (const [size, count] of sizes) observations.push({type: 'font', channel, family: family[0] ?? '', size: `${size}pt`, count, locator: 'text runs'});
  for (const name of family) observations.push({type: 'font', channel, family: name, locator: 'embedded fonts'});
  return {observations, fetched: pages - failed.length, failed, budgetHit: pdf.numPages > PDF_LIMITS.pages};
};
