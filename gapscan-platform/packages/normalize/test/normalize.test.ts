import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRamp, clusterColors, confidence, confidenceBand, contrastRatio, deltaE2000, detectSpacing, elevationScale, fitTypeScale,
  inferRoles, mergeCandidates, nearDuplicates, parseColor, radiusScale, toHex, toOklch, toPx,
} from '@gapscan/normalize';

const close = (actual: number, expected: number, tolerance: number, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} ≉ ${expected}`);

test('parses every colour syntax extraction meets into the same sRGB value', () => {
  for (const input of ['#f00', '#ff0000', 'red', 'rgb(255, 0, 0)', 'rgb(255 0 0)', 'rgb(100% 0% 0%)', 'hsl(0 100% 50%)', 'hsl(0deg, 100%, 50%)', 'cmyk(0%, 100%, 100%, 0%)'])
    assert.equal(toHex(parseColor(input)!), '#ff0000', input);
  assert.equal(toHex(parseColor('oklch(0.628 0.2577 29.23)')!), '#ff0000');
  assert.equal(toHex(parseColor('hsl(120 100% 50%)')!), '#00ff00');
  close(parseColor('rgb(255 0 0 / 50%)')!.alpha, 0.5, 1e-9);
  assert.equal(toHex(parseColor('#0b5fd680')!), '#0b5fd680');
  for (const notColor of ['var(--brand)', 'currentColor', 'linear-gradient(red, blue)', 'inherit', '#ggg', 'rgb(none 0 0)']) assert.equal(parseColor(notColor), null, notColor);
});

test('CIEDE2000 matches the published Sharma test pairs', () => {
  close(deltaE2000({L: 50, a: 2.6772, b: -79.7751}, {L: 50, a: 0, b: -82.7485}), 2.0425, 1e-4, 'pair 1');
  close(deltaE2000({L: 50, a: 0, b: 0}, {L: 50, a: -1, b: 2}), 2.3669, 1e-4, 'pair 7');
  close(deltaE2000({L: 50, a: 2.5, b: 0}, {L: 73, a: 25, b: -18}), 27.1492, 1e-4, 'pair 17');
  close(deltaE2000({L: 2.0776, a: 0.0795, b: -1.135}, {L: 0.9033, a: -0.0636, b: -0.5514}), 0.9082, 1e-4, 'pair 34');
});

test('OKLCH and WCAG contrast agree with reference values', () => {
  const white = toOklch(parseColor('#fff')!);
  close(white.l, 1, 1e-3); close(white.c, 0, 1e-3);
  const red = toOklch(parseColor('#f00')!);
  close(red.l, 0.628, 1e-3); close(red.c, 0.2577, 1e-3); close(red.h, 29.23, 0.05);
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#767676', '#ffffff'), 4.54);
  assert.equal(contrastRatio('var(--x)', '#fff'), null);
});

test('clusters merge imperceptible differences and flag near-duplicates for review', () => {
  const clusters = clusterColors([
    {value: '#0B5FD6', count: 40, property: 'background-color', selector: '.btn-primary'},
    {value: '#0C60D7', count: 3, property: 'background-color', selector: '.cta'},                // ΔE < 2 → merged
    {value: '#1565D8', count: 5, property: 'color', selector: '.link'},                          // ΔE 2–5 → near-duplicate
    {value: '#1a1a1a', count: 60, property: 'color', selector: 'body'},
    {value: '#ffffff', count: 50, property: 'background', selector: 'body'},
    {value: '#d92d20', count: 6, property: 'color', selector: '.error-text'},
    {value: 'transparent', count: 9}, {value: 'var(--x)', count: 2},
  ]);
  const blue = clusters.find(c => c.hex === '#0b5fd6')!;
  assert.equal(blue.count, 43);
  assert.deepEqual(blue.members, ['#0B5FD6', '#0C60D7']);
  assert.equal(clusters.length, 5, 'transparent and unresolved values are not colours');
  assert.deepEqual(nearDuplicates(clusters).map(p => [p.a, p.b]), [['#0b5fd6', '#1565d8']]);

  const roles = Object.fromEntries(inferRoles(clusters).map(r => [r.role, r.hex]));
  assert.equal(roles.primary, '#0b5fd6');
  assert.equal(roles.text, '#1a1a1a');
  assert.equal(roles.surface, '#ffffff');
  assert.equal(roles.danger, '#d92d20');
});

test('tonal ramps keep observed colours and label the rest synthesized', () => {
  const [blue] = clusterColors([{value: '#0B5FD6'}]);
  const ramp = buildRamp(blue!);
  assert.equal(ramp.length, 10);
  assert.ok(ramp.every(step => /^#[0-9a-f]{6}$/.test(step.hex)));
  assert.ok(ramp.filter(s => s.status === 'synthesized').length >= 9);
  const lightness = ramp.map(s => toOklch(parseColor(s.hex)!).l);
  assert.deepEqual(lightness, [...lightness].sort((a, b) => b - a), 'ramp runs light to dark');
});

test('spacing detects the grid and lists values that fall off it', () => {
  const eight = detectSpacing([{value: '8px', count: 30}, {value: '16px 24px', count: 20}, {value: '1rem', count: 10}, {value: '32px', count: 8}, {value: '13px', count: 2, evidenceId: 'ev-13'}]);
  assert.equal(eight.baseUnit, 8);
  assert.deepEqual(eight.offScale, [{px: 13, count: 2, evidence: ['ev-13']}]);
  const four = detectSpacing([{value: '4px', count: 20}, {value: '12px', count: 20}, {value: '20px', count: 10}]);
  assert.equal(four.baseUnit, 4);
  assert.equal(detectSpacing([{value: '7px'}, {value: '13px'}, {value: '22px'}]).baseUnit, null);
});

test('type scale fits the documented ratio and flags irregular scales', () => {
  const major = fitTypeScale([12.8, 16, 20, 25, 31.25, 39.06].map((px, i) => ({size: px + 'px', family: '"Inter", sans-serif', count: i === 1 ? 50 : 5})));
  assert.equal(major?.ratio, 1.25);
  assert.equal(major?.basePx, 16);
  assert.equal(major?.irregular, false);
  assert.deepEqual(major?.families, ['Inter']);
  assert.equal(major?.sizes.find(s => s.px === 16)?.role, 'body');
  const messy = fitTypeScale(['13px', '15px', '17px', '19px', '23px', '29px', '37px'].map(size => ({size})));
  assert.ok(messy && messy.residual > 0);
});

test('radii and shadows order into named scales', () => {
  assert.deepEqual(radiusScale(['4px', '0', '8px', '0.5rem', '50%', '2px']), [{name: 'none', px: 0}, {name: 'sm', px: 2}, {name: 'md', px: 4}, {name: 'lg', px: 8}, {name: 'full', px: 'full'}]);
  const shadows = elevationScale(['0 8px 24px rgba(0,0,0,.2)', 'none', '0 1px 2px rgba(0,0,0,.1)', '0 2px 8px rgba(0,0,0,.15), 0 1px 1px #0002']);
  assert.deepEqual(shadows.map(s => s.blurPx), [2, 8, 24]);
  assert.equal(toPx('1.5rem'), 24); assert.equal(toPx('12pt'), 16); assert.equal(toPx('2em'), null);
});

test('merging keeps the most trusted value and records declared-vs-observed drift', () => {
  const merged = mergeCandidates([
    {channel: 'pdf_guideline', value: '#0052CC', instances: 1},
    {channel: 'observed_css', value: '#0B5FD6', instances: 120},
    {channel: 'figma_variables', value: '#0B5FD6', instances: 1},
  ])!;
  assert.equal(merged.winner, 'figma_variables');
  assert.equal(merged.value, '#0B5FD6');
  assert.equal(merged.drift.length, 1);
  assert.equal(merged.drift[0]?.declared.channel, 'pdf_guideline');
  assert.ok(merged.drift[0]!.distance > 3);
  assert.equal(merged.agreement, 0.67);
  assert.equal(mergeCandidates([]), null);
});

test('confidence follows the documented formula and bands', () => {
  assert.equal(confidence('code_tokens', 1, 99), 1);
  assert.equal(confidence('image_sampling', 0, 0), 0);
  assert.equal(confidence('observed_css', 1, 9), 0.43);
  assert.equal(confidence('code_tokens', 1, 1), 1, 'declared once is still declared');
  assert.equal(confidence('pdf_guideline', 1, 1), 0.7);
  assert.equal(confidenceBand(0.85), 'Confirmed'); assert.equal(confidenceBand(0.6), 'Likely'); assert.equal(confidenceBand(0.2), 'Inferred');
});
