// Image sources (screenshots, mockups, brand boards). Read from pixels: the palette by area,
// flat UI boxes (fill, border, corner radius) and the spacing between and inside them. Text is
// not read (that needs text recognition), so type comes from other sources. Everything here is
// an estimate and is reported on the lowest-trust channel.
import {deltaE2000, toHex, toLab} from '@gapscan/normalize';
import type {Lab} from '@gapscan/normalize';
import type {Adapter, Observation} from './types.ts';
import {AdapterError} from './types.ts';
import {EGRESS_CHROMIUM_ARGS, startEgressProxy} from './egress.ts';

const hexRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
export const IMAGE_LIMITS = Object.freeze({pixels: 60_000_000, sampleEdge: 2000});
export type ImageInfo = {format: 'png' | 'jpeg' | 'gif' | 'webp'; width: number; height: number; density: number; densityBasis: string};

// Format, size and pixel density from the file header, before anything is decoded. The density
// turns screenshot pixels into CSS pixels: a 144 dpi Mac screenshot is @2x.
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  let info: Omit<ImageInfo, 'density' | 'densityBasis'> | null = null, dpi = 0;
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) {
    info = {format: 'png', width: view.getUint32(16), height: view.getUint32(20)};
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = view.getUint32(at), type = ascii(at + 4, 4);
      if (type === 'pHYs' && length >= 9 && bytes[at + 16] === 1) dpi = view.getUint32(at + 8) * 0.0254;
      if (type === 'IDAT' || type === 'IEND') break;
      at += 12 + length;
    }
  } else if (bytes.length > 4 && view.getUint16(0) === 0xffd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1]!, length = view.getUint16(at + 2);
      if (marker === 0xe0 && ascii(at + 4, 4) === 'JFIF') { const units = bytes[at + 11], x = view.getUint16(at + 12); dpi = units === 1 ? x : units === 2 ? x * 2.54 : 0; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { info = {format: 'jpeg', width: view.getUint16(at + 7), height: view.getUint16(at + 5)}; break; }
      at += 2 + length;
    }
  } else if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') info = {format: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true)};
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') info = {format: 'webp', width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff)};
    else if (chunk === 'VP8 ') info = {format: 'webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff};
    else if (chunk === 'VP8L') { const b = view.getUint32(21, true); info = {format: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff)}; }
  }
  if (!info || !info.width || !info.height) return null;
  // 144 dpi → @2x, 216 dpi → @3x. Without a density, very wide images are most likely @2x exports.
  const density = dpi >= 100 ? Math.max(1, Math.round(dpi / 72)) : info.width >= 2400 ? 2 : 1;
  const densityBasis = dpi >= 100 ? `${Math.round(dpi)} dpi in the file` : info.width >= 2400 ? 'assumed @2x (no density in the file, and wider than 2400px)' : 'assumed @1x';
  return {...info, density, densityBasis};
}

export type Pixels = {width: number; height: number; data: Uint8Array | Uint8ClampedArray};
export type ImageBox = {x: number; y: number; width: number; height: number; fill: string; radius: number; ring: boolean; borderWidth: number; border?: string; background: boolean};
export type ImageAnalysis = {palette: {hex: string; share: number; role: 'fill' | 'border' | 'other'}[]; boxes: ImageBox[]; spacing: number[]; radii: number[]};

// `unit` is CSS pixels per sample pixel, so measurements come out in CSS pixels.
export function analyzePixels(img: Pixels, unit = 1): ImageAnalysis {
  const {width: W, height: H, data} = img, N = W * H;
  // 1. Palette: 15-bit buckets, then greedy clustering by area within ΔE 1. UIs separate surfaces by
  //    small steps (a white card on #f4f5f7 is under ΔE 2.5), so the threshold is tight.
  const counts = new Uint32Array(32768), sums = new Float64Array(32768 * 3);
  let total = 0;
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3]! < 128) continue;
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    counts[key]!++; sums[key * 3] = sums[key * 3]! + r; sums[key * 3 + 1] = sums[key * 3 + 1]! + g; sums[key * 3 + 2] = sums[key * 3 + 2]! + b; total++;
  }
  if (!total) return {palette: [], boxes: [], spacing: [], radii: []};
  const buckets = [...counts.keys()].filter(k => counts[k]! > 0).sort((a, b) => counts[b]! - counts[a]!);
  const clusters: {lab: Lab; hex: string; count: number}[] = [];
  const bucketLab = (k: number) => toLab({r: sums[k * 3]! / counts[k]! / 255, g: sums[k * 3 + 1]! / counts[k]! / 255, b: sums[k * 3 + 2]! / counts[k]! / 255, alpha: 1});
  const labelOf = new Int16Array(32768).fill(-1);
  for (const k of buckets) {
    const lab = bucketLab(k);
    let best = -1, bestD = Infinity;
    for (let c = 0; c < clusters.length; c++) { const d = deltaE2000(lab, clusters[c]!.lab); if (d < bestD) { bestD = d; best = c; } }
    if (best >= 0 && bestD < 1) { clusters[best]!.count += counts[k]!; labelOf[k] = best; continue; }
    // New colours only from buckets with real area; the rest (anti-aliasing, photos) join their nearest or stay unlabelled.
    if (counts[k]! >= total * 0.0005 && clusters.length < 64) {
      clusters.push({lab, count: counts[k]!, hex: toHex({r: sums[k * 3]! / counts[k]! / 255, g: sums[k * 3 + 1]! / counts[k]! / 255, b: sums[k * 3 + 2]! / counts[k]! / 255, alpha: 1})});
      labelOf[k] = clusters.length - 1;
    } else if (best >= 0 && bestD < 12) { clusters[best]!.count += counts[k]!; labelOf[k] = best; }   // blends join the colour nearest to them
  }
  const label = new Int16Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3]! < 128) continue;
    label[i] = labelOf[(data[i * 4]! >> 3) << 10 | (data[i * 4 + 1]! >> 3) << 5 | (data[i * 4 + 2]! >> 3)]!;
  }

  // 2. Connected regions of one colour (4-neighbour).
  const region = new Int32Array(N).fill(-1), regions: {label: number; area: number; x0: number; y0: number; x1: number; y1: number}[] = [];
  const stack = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (region[i] !== -1 || label[i] === -1) continue;
    const id = regions.length, l = label[i]!, r = {label: l, area: 0, x0: W, y0: H, x1: 0, y1: 0};
    let top = 0; stack[top++] = i; region[i] = id;
    while (top) {
      const p = stack[--top]!, x = p % W, y = (p - x) / W;
      r.area++; if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1])
        if (q >= 0 && region[q] === -1 && label[q] === l) { region[q] = id; stack[top++] = q; }
    }
    regions.push(r);
  }

  // 3. Boxes: regions whose four edges run straight (≥ 90% present along the middle of each side).
  const at = (x: number, y: number) => region[y * W + x];
  const boxes: ImageBox[] = [];
  const candidates = regions.map((r, id) => ({...r, id})).filter(r => r.x1 - r.x0 >= 9 && r.y1 - r.y0 >= 9 && r.area >= 40).sort((a, b) => b.area - a.area).slice(0, 400);
  for (const r of candidates) {
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    const run = (fixed: number, from: number, to: number, horizontal: boolean) => {
      let hit = 0, n = 0;
      for (let v = Math.round(from); v <= Math.round(to); v++, n++) if ((horizontal ? at(v, fixed) : at(fixed, v)) === r.id) hit++;
      return n ? hit / n : 0;
    };
    // Corner radius: fit a quarter circle to how far each row's first pixel is indented, at all four corners.
    // Corner pixels are judged by their own colour: inside when at least halfway from the colour just
    // outside the corner to the fill (50% coverage), whatever cluster anti-aliasing put them in.
    // Corner radius of a box with edges x0..x1, y0..y1 whose shape colour is `fillHex`.
    const measureRadius = (x0: number, y0: number, x1: number, y1: number, fillHex: string, member: (x: number, y: number) => boolean) => {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fillRgb = hexRgb(fillHex);
      const coverage = (x: number, y: number, outside: [number, number, number]) => {
        const i = (y * W + x) * 4, d = [fillRgb[0] - outside[0], fillRgb[1] - outside[1], fillRgb[2] - outside[2]], len = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
        if (len < 1) return member(x, y) ? 1 : 0;
        return ((data[i]! - outside[0]) * d[0]! + (data[i + 1]! - outside[1]) * d[1]! + (data[i + 2]! - outside[2]) * d[2]!) / len;
      };
      const outsideAt = (x: number, y: number): [number, number, number] => { const i = (y * W + x) * 4; return [data[i]!, data[i + 1]!, data[i + 2]!]; };
      // Corner pixels are judged by their own colour: inside when at least halfway from the colour just
      // outside the corner to the shape's colour (50% coverage), whatever cluster anti-aliasing put them in.
      const corner = (fromTop: boolean, fromLeft: boolean) => {
        const limit = Math.min(Math.floor(Math.min(bw, bh) / 2), 60), profile: number[] = [];
        const cx = fromLeft ? x0 : x1, cy = fromTop ? y0 : y1;
        if (cx < 0 || cy < 0 || cx >= W || cy >= H || member(cx, cy)) return 0;   // a square corner
        const outside = outsideAt(cx, cy);
        for (let k = 0; k < limit; k++) {
          const y = fromTop ? y0 + k : y1 - k;
          let d = 0;
          while (d < bw / 2 && coverage(fromLeft ? x0 + d : x1 - d, y, outside) < 0.5) d++;
          profile.push(d);
        }
        if (profile[0]! <= 0) return 0;
        // With the 50% rule, row k starts at ceil(r − ½ − √(r² − (r − k − ½)²)).
        let best = 0, bestErr = Infinity;
        for (let rad = 0.5; rad <= limit; rad += 0.5) {
          let err = 0;
          for (let k = 0; k < profile.length; k++) {
            const dy = rad - k - 0.5, expect = k < rad ? Math.max(0, Math.ceil(rad - 0.5 - Math.sqrt(Math.max(0, rad * rad - dy * dy)) - 1e-9)) : 0;
            err += (profile[k]! - expect) ** 2;
          }
          if (err < bestErr - 1e-9) { bestErr = err; best = rad; }
        }
        return best;
      };
      const radii = [corner(true, true), corner(true, false), corner(false, true), corner(false, false)].sort((p, q) => p - q);
      return (radii[1]! + radii[2]!) / 2;
    };
    let radiusPx = measureRadius(r.x0, r.y0, r.x1, r.y1, clusters[r.label]!.hex, (x, y) => at(x, y) === r.id);
    // Straight sides are checked between the corners only, so pills and circles (all-curved sides) qualify.
    const R = Math.round(radiusPx), sideX = [r.x0 + R + 1, r.x1 - R - 1], sideY = [r.y0 + R + 1, r.y1 - R - 1];
    const sides = [...(sideX[1]! - sideX[0]! >= 3 ? [run(r.y0, sideX[0]!, sideX[1]!, true), run(r.y1, sideX[0]!, sideX[1]!, true)] : []),
      ...(sideY[1]! - sideY[0]! >= 3 ? [run(r.x0, sideY[0]!, sideY[1]!, false), run(r.x1, sideY[0]!, sideY[1]!, false)] : [])];
    const circle = !sides.length && Math.abs(r.area / (w * h) - Math.PI / 4) < 0.08;
    if (!(sides.length ? sides.every(e => e >= 0.9) : circle)) continue;
    const ring = at(Math.round((r.x0 + r.x1) / 2), Math.round((r.y0 + r.y1) / 2)) !== r.id && r.area < w * h * 0.5;
    let borderWidth = 0, border: string | null = null;
    if (ring) { const cx = Math.round((r.x0 + r.x1) / 2); while (borderWidth < h / 2 && at(cx, r.y0 + borderWidth) === r.id) borderWidth++; border = clusters[r.label]!.hex; }
    else {
      // An outline that anti-aliasing broke into pieces: a thin band of one other colour on all four sides.
      const band = (x: number, y: number, dx: number, dy: number) => {
        const first = label[(y + dy) * W + x + dx];
        if (first === undefined || first === -1 || first === r.label) return null;
        let n = 0;
        while (n < 5 && label[(y + dy * (n + 1)) * W + x + dx * (n + 1)] === first) n++;
        const beyond = label[(y + dy * (n + 1)) * W + x + dx * (n + 1)];
        return n >= 1 && n <= 4 && beyond !== first ? {label: first, n} : null;
      };
      const cx = Math.round((r.x0 + r.x1) / 2), cy = Math.round((r.y0 + r.y1) / 2);
      const probes = r.x0 > 5 && r.y0 > 5 && r.x1 < W - 6 && r.y1 < H - 6 ? [band(cx, r.y0, 0, -1), band(cx, r.y1, 0, 1), band(r.x0, cy, -1, 0), band(r.x1, cy, 1, 0)] : [];
      if (probes.length === 4 && probes.every(p => p && p.label === probes[0]!.label && p.n === probes[0]!.n)) { borderWidth = probes[0]!.n; border = clusters[probes[0]!.label]!.hex; }
    }
    const grow = border && !ring ? borderWidth : 0;   // an outline found outside the fill makes the box that much larger
    // An outlined box's radius is its outer edge: from the colour outside to the border colour.
    if (grow) { const borderLabel = clusters.findIndex(c => c.hex === border); radiusPx = measureRadius(r.x0 - grow, r.y0 - grow, r.x1 + grow, r.y1 + grow, border!, (x, y) => label[y * W + x] === borderLabel) - grow; }
    const outer = (n: number) => n * unit;
    boxes.push({x: outer(r.x0 - grow), y: outer(r.y0 - grow), width: outer(w + 2 * grow), height: outer(h + 2 * grow), fill: clusters[r.label]!.hex,
      radius: radiusPx >= Math.min(w, h) / 2 - 1 ? 9999 : Math.round((radiusPx + grow) * unit), ring: Boolean(border), borderWidth: Math.round(borderWidth * unit),
      ...(border ? {border} : {}), background: w >= W * 0.95 && h >= H * 0.95});
  }

  // One box per shape: an outline found as its own ring and again around its fill is the same box.
  const same = (p: ImageBox, q: ImageBox) => Math.abs(p.x - q.x) <= 2 * unit && Math.abs(p.y - q.y) <= 2 * unit && Math.abs(p.width - q.width) <= 4 * unit && Math.abs(p.height - q.height) <= 4 * unit;
  for (let i = boxes.length - 1; i >= 0; i--) if (boxes.some((q, j) => j < i && same(q, boxes[i]!) || j > i && same(q, boxes[i]!) && boxes[i]!.border === boxes[i]!.fill)) boxes.splice(i, 1);

  // 4. Spacing: insets of a box inside another, and gaps to the nearest aligned neighbour.
  const spacing: number[] = [];
  const parts = boxes.filter(b => !b.background && b.width < W * unit * 0.95);
  const inside = (a: ImageBox, b: ImageBox) => b !== a && b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1, Math.min(a1 - a0, b1 - b0));
  for (const a of parts) {
    const children = parts.filter(b => inside(a, b) && !(a.ring && b.width >= a.width - 2 * a.borderWidth - 2));
    if (children.length) {
      spacing.push(Math.min(...children.map(c => c.x - a.x)), Math.min(...children.map(c => c.y - a.y)));
    }
    const siblings = parts.filter(b => b !== a && !inside(a, b) && !inside(b, a));
    const below = siblings.filter(b => b.y >= a.y + a.height && overlap(a.x, a.x + a.width, b.x, b.x + b.width) >= 0.5).sort((p, q) => p.y - q.y)[0];
    const right = siblings.filter(b => b.x >= a.x + a.width && overlap(a.y, a.y + a.height, b.y, b.y + b.height) >= 0.5).sort((p, q) => p.x - q.x)[0];
    if (below) spacing.push(below.y - (a.y + a.height));
    if (right) spacing.push(right.x - (a.x + a.width));
  }
  const borders = new Set(boxes.flatMap(b => b.border ? [b.border] : [])), fills = new Set(boxes.filter(b => !(b.ring && b.border === b.fill)).map(b => b.fill));
  return {
    palette: clusters.map(c => ({hex: c.hex, share: c.count / total, role: fills.has(c.hex) ? 'fill' as const : borders.has(c.hex) ? 'border' as const : 'other' as const}))
      // Thin borders cover little area but are design colours all the same.
      .filter(c => c.share >= 0.003 || c.role === 'border').sort((a, b) => b.share - a.share).slice(0, 24),
    boxes, spacing: spacing.map(n => Math.round(n)).filter(n => n >= 2 && n <= 128), radii: boxes.filter(b => !b.background).map(b => b.radius),
  };
}

// Decodes in Chromium with every network request refused: the image is only ever drawn to a canvas.
// It is scaled so one sample pixel is one CSS pixel (at most 2000px on the long edge).
export async function decodeImage(bytes: Uint8Array, info: ImageInfo): Promise<Pixels & {unit: number}> {
  let playwright: typeof import('playwright');
  try { playwright = await import('playwright'); } catch { throw new AdapterError('Reading images needs Playwright on the server (npx playwright install chromium).'); }
  const proxy = await startEgressProxy({resolve: async () => null});
  const browser = await playwright.chromium.launch({args: EGRESS_CHROMIUM_ARGS, proxy: proxy.launchProxy});
  try {
    const page = await browser.newPage();
    const cssWidth = info.width / info.density, cssHeight = info.height / info.density;
    const scale = Math.min(1, IMAGE_LIMITS.sampleEdge / Math.max(cssWidth, cssHeight));
    const target = {w: Math.max(1, Math.round(cssWidth * scale)), h: Math.max(1, Math.round(cssHeight * scale))};
    // Runs in the page (kept as a string so the server build needs no DOM types).
    const out = await page.evaluate(`(async ({b64, mime, w, h}) => {
      const blob = await (await fetch('data:' + mime + ';base64,' + b64)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let bin = '';
      for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode(...d.subarray(i, i + 0x8000));
      return btoa(bin);
    })(${JSON.stringify({b64: Buffer.from(bytes).toString('base64'), mime: `image/${info.format}`, ...target})})`) as string;
    return {width: target.w, height: target.h, data: new Uint8Array(Buffer.from(out, 'base64')), unit: 1 / scale};
  } finally { await browser.close().catch(() => undefined); await proxy.close(); }
}

export const imageAdapter: Adapter = async ({name, bytes}, {progress}) => {
  let info = imageInfo(bytes);
  if (!info) throw new AdapterError('This is not a PNG, JPEG, GIF or WebP image.');
  if (info.width * info.height > IMAGE_LIMITS.pixels) throw new AdapterError(`The image is ${info.width}×${info.height}; images up to ${IMAGE_LIMITS.pixels / 1e6} megapixels are read.`);
  // Retina exports are usually named for their scale (hero@2x.png); the file's own dpi still wins.
  const named = name.match(/@([2-4])x\b/i);
  if (named && !/dpi in the file/.test(info.densityBasis)) info = {...info, density: Number(named[1]), densityBasis: `@${named[1]}x from the file name`};
  await progress?.(`reading pixels (${info.width}×${info.height}, ${info.densityBasis})`);
  let pixels = await decodeImage(bytes, info), result = analyzePixels(pixels, pixels.unit);
  // No density in the file: if every outline is exactly 2px, it was captured at @2x (CSS hairlines are 1px).
  const outlines = result.boxes.filter(b => b.ring && b.borderWidth);
  if (info.density === 1 && /^assumed/.test(info.densityBasis) && outlines.length && outlines.every(b => b.borderWidth === 2)) {
    info = {...info, density: 2, densityBasis: 'inferred @2x (every outline is 2px)'};
    pixels = await decodeImage(bytes, info); result = analyzePixels(pixels, pixels.unit);
  }
  const channel = 'image_sampling' as const, locator = `${name} (${info.width}×${info.height}, ${info.densityBasis})`;
  const observations: Observation[] = [
    ...result.palette.map(c => ({type: 'color' as const, channel, value: c.hex, property: c.role === 'fill' ? 'background-color' : c.role === 'border' ? 'border-color' : 'color',
      count: Math.max(1, Math.round(c.share * 1000)), locator, raw: `${(c.share * 100).toFixed(1)}% of the image`})),
    ...result.radii.map(r => ({type: 'radius' as const, channel, value: `${r}px`, count: 1, locator})),
    ...result.spacing.map(s => ({type: 'spacing' as const, channel, value: `${s}px`, count: 1, locator})),
    ...result.boxes.filter(b => b.ring && b.borderWidth).map(b => ({type: 'token' as const, channel, path: 'border.width', value: `${b.borderWidth}px`, locator})).slice(0, 1),
  ];
  await progress?.(`${result.palette.length} colours, ${result.boxes.filter(b => !b.background).length} boxes, ${result.spacing.length} spacing measurements; text is not read from images`);
  return {observations, fetched: 1, failed: [], budgetHit: false};
};
