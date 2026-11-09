// Image sources, tested on generated mockups with known values: anti-aliased rounded boxes,
// an outlined button, "text" marks inside, at @1x and as a @2x PNG with a 144 dpi header.
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {analyzePixels, crc32, imageAdapter, imageInfo} from '@gapscan/adapters';

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function canvas(w: number, h: number, bg: string) {
  const data = new Uint8Array(w * h * 4), c = hex(bg);
  for (let i = 0; i < w * h; i++) data.set([...c, 255], i * 4);
  // Rounded rectangle with 4×4 supersampled coverage (real anti-aliasing at the corners).
  const inside = (px: number, py: number, x: number, y: number, rw: number, rh: number, r: number) => {
    if (px < x || py < y || px > x + rw || py > y + rh) return false;
    const cx = Math.min(Math.max(px, x + r), x + rw - r), cy = Math.min(Math.max(py, y + r), y + rh - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };
  const rect = (x: number, y: number, rw: number, rh: number, r: number, color: string, border = 0) => {
    const col = hex(color);
    for (let py = Math.floor(y); py < Math.ceil(y + rh); py++) for (let px = Math.floor(x); px < Math.ceil(x + rw); px++) {
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const qx = px + (sx + 0.5) / 4, qy = py + (sy + 0.5) / 4;
        const ins = inside(qx, qy, x, y, rw, rh, r), hole = border > 0 && inside(qx, qy, x + border, y + border, rw - 2 * border, rh - 2 * border, Math.max(0, r - border));
        if (ins && !hole) cover++;
      }
      if (!cover || px < 0 || py < 0 || px >= w || py >= h) continue;
      const a = cover / 16, i = (py * w + px) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = Math.round(data[i + k]! * (1 - a) + col[k]! * a);
    }
  };
  return {data, rect, width: w, height: h};
}
function mockup(s = 1) {
  const c = canvas(640 * s, 480 * s, '#f4f5f7');
  c.rect(40 * s, 40 * s, 400 * s, 200 * s, 12 * s, '#ffffff');                       // card
  c.rect(64 * s, 64 * s, 120 * s, 40 * s, 8 * s, '#005eff');                         // primary button, 24 inside the card
  c.rect(84 * s, 80 * s, 80 * s, 8 * s, 0, '#ffffff');                               // its label ("text")
  c.rect(196 * s, 64 * s, 120 * s, 40 * s, 8 * s, '#d0d5dd', 1 * s);                 // outlined button, 12 to the right
  c.rect(216 * s, 80 * s, 80 * s, 8 * s, 0, '#1d2939');
  c.rect(64 * s, 128 * s, 72 * s, 24 * s, 12 * s, '#e3f5f8');                        // pill tag
  c.rect(40 * s, 264 * s, 400 * s, 160 * s, 12 * s, '#ffffff');                      // second card, 24 below
  return c;
}
function png(c: ReturnType<typeof canvas>, dpi?: number) {
  const chunk = (type: string, body: Uint8Array) => {
    const out = Buffer.alloc(12 + body.length), tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    out.writeUInt32BE(body.length, 0); tb.copy(out, 4); out.writeUInt32BE(crc32(tb), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(c.width, 0); ihdr.writeUInt32BE(c.height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((c.width * 4 + 1) * c.height);
  for (let y = 0; y < c.height; y++) Buffer.from(c.data.subarray(y * c.width * 4, (y + 1) * c.width * 4)).copy(raw, y * (c.width * 4 + 1) + 1);
  const phys = Buffer.alloc(9); if (dpi) { phys.writeUInt32BE(Math.round(dpi / 0.0254), 0); phys.writeUInt32BE(Math.round(dpi / 0.0254), 4); phys[8] = 1; }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...(dpi ? [chunk('pHYs', phys)] : []), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]));
}

test('boxes, corner radii, borders and spacing come out of an anti-aliased mockup', () => {
  const result = analyzePixels(mockup());
  const radii = [...new Set(result.radii)].sort((a, b) => a - b);
  assert.deepEqual(radii, [8, 12, 9999], `radii ${result.radii.join(',')}`);
  const outlined = result.boxes.filter(b => b.ring);
  assert.equal(outlined.length, 1, 'the outlined button is one box');
  assert.deepEqual([outlined[0]!.borderWidth, outlined[0]!.border, outlined[0]!.fill, outlined[0]!.radius, outlined[0]!.width, outlined[0]!.height], [1, '#d0d5dd', '#ffffff', 8, 120, 40]);
  for (const gap of [24, 12]) assert.ok(result.spacing.includes(gap), `spacing ${gap} in ${result.spacing.join(',')}`);
  const colors = result.palette.map(c => c.hex);
  for (const c of ['#f4f5f7', '#ffffff', '#005eff', '#d0d5dd', '#e3f5f8']) assert.ok(colors.includes(c), `${c} in ${colors.join(',')}`);
  assert.equal(result.palette.find(c => c.hex === '#005eff')!.role, 'fill');
  assert.equal(result.palette.find(c => c.hex === '#d0d5dd')!.role, 'border');
  assert.ok(result.boxes.some(b => b.background), 'the page background is recognised, not counted as a box');
});

test('file headers give format, size and density without decoding', () => {
  assert.deepEqual(imageInfo(png(mockup(), 144)), {format: 'png', width: 640, height: 480, density: 2, densityBasis: '144 dpi in the file'});
  assert.equal(imageInfo(png(mockup()))!.density, 1);
  assert.equal(imageInfo(new Uint8Array([1, 2, 3])), null);
});

const hasBrowser = await import('playwright').then(p => p.chromium.launch().then(b => b.close()).then(() => true)).catch(() => false);
test('a @2x screenshot is decoded in Chromium and measured in CSS pixels', {skip: !hasBrowser && 'Chromium for Playwright is not installed', timeout: 60_000}, async () => {
  const messages: string[] = [];
  const result = await imageAdapter({assetId: 'i', name: 'mockup@2x.png', uri: 'upload:mockup@2x.png', bytes: png(mockup(2), 144)}, {signal: new AbortController().signal, progress: m => { messages.push(m); }});
  const values = (type: string) => result.observations.flatMap(o => o.type === type && 'value' in o ? [o.value] : []);
  assert.ok(values('radius').includes('8px') && values('radius').includes('12px'), `radii ${values('radius').join(',')}`);
  assert.ok(values('spacing').includes('24px'), `spacing ${values('spacing').join(',')}`);
  assert.ok(values('color').includes('#005eff'));
  assert.ok(result.observations.every(o => o.channel === 'image_sampling'), 'image values are the lowest-trust channel');
  assert.match(messages.join(' '), /144 dpi in the file.*text is not read from images/s);
});

test('a @2x screenshot without a dpi is scaled by its file name', {skip: !hasBrowser && 'Chromium for Playwright is not installed', timeout: 60_000}, async () => {
  const messages: string[] = [];
  const result = await imageAdapter({assetId: 'i', name: 'buttons@2x.png', uri: 'upload:buttons@2x.png', bytes: png(mockup(2))}, {signal: new AbortController().signal, progress: m => { messages.push(m); }});
  const radii = result.observations.flatMap(o => o.type === 'radius' ? [o.value] : []);
  assert.ok(radii.includes('8px') && radii.includes('12px'), radii.join(','));
  assert.match(messages[0]!, /@2x from the file name/);
});
