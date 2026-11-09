import test from 'node:test';
import assert from 'node:assert/strict';
import {listReferences, loadReference, REFERENCE_SOURCES} from '@gapscan/library';

test('every configured reference has a pinned, schema-valid snapshot with checksummed sources', async () => {
  const list = await listReferences();
  assert.deepEqual(list.map(r => r.id).sort(), REFERENCE_SOURCES.map(r => r.id).sort());
  for (const summary of list) {
    const reference = (await loadReference(summary.id))!;
    assert.ok(reference.components.length >= 10, `${summary.id} has components`);
    // Per-file libraries (shadcn) forward the native element's props, so most components declare none of their own.
    const perFile = REFERENCE_SOURCES.find(r => r.id === summary.id)?.onePerFile;
    if (summary.kind === 'types' && !perFile) assert.ok(reference.components.filter(c => c.props?.length).length >= reference.components.length * 0.8, `${summary.id} components carry their props`);
    // Pinned: an exact npm version on jsDelivr, or a full 40-character commit on GitHub.
    assert.ok(reference.sources.every(s => /^[0-9a-f]{64}$/.test(s.sha256) && (s.uri.startsWith('https://cdn.jsdelivr.net/npm/') || /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\//.test(s.uri))), `${summary.id}: pinned artifacts with checksums`);
    assert.ok(reference.components.every(c => c.category !== 'Utilities and tooling' && (summary.kind === 'types' || c.category !== 'Miscellaneous')), 'CSS noise is filtered; declared components are kept');
    assert.ok(reference.components.some(c => c.canonical === 'Button' && c.category === 'Actions'), `${summary.id} has a Button`);
  }
});

test('Polaris and Carbon buttons carry their published variants, sizes and states', async () => {
  const polaris = (await loadReference('polaris-13.9.5'))!.components.find(c => c.canonical === 'Button')!;
  assert.ok(['primary', 'plain', 'tone=critical'].every(v => polaris.variants.some(x => x.name === v)));
  assert.ok(['slim', 'large'].every(s => polaris.sizes.includes(s)));
  assert.ok(['loading', 'disabled', 'focus-visible'].every(s => polaris.statesObserved.includes(s)));
  const carbon = (await loadReference('carbon-styles-1.68.0'))!.components.filter(c => c.canonical === 'Button');
  assert.equal(carbon.length, 1, 'only the btn class is named Button');
});

test('unknown or unsafe ids return nothing', async () => {
  assert.equal(await loadReference('nope'), null);
  assert.equal(await loadReference('../../package'), null);
});

test('reference role colours match each library’s published palette', async () => {
  const expected: Record<string, Record<string, string>> = {
    'bootstrap-5.3.3': {primary: '#0d6efd', danger: '#dc3545', success: '#198754'},
    'polaris-13.9.5': {primary: '#303030', danger: '#c70a24', success: '#047b5d'},
    'carbon-styles-1.68.0': {primary: '#0f62fe', danger: '#da1e28', success: '#24a148'},
    'bulma-1.0.2': {primary: '#00d1b2', danger: '#ff6685', success: '#48c78e'},
  };
  for (const [id, roles] of Object.entries(expected)) {
    const reference = (await loadReference(id))!;
    for (const [role, hex] of Object.entries(roles)) assert.equal(String(reference.tokens.find(t => t.path === `color.${role}`)?.value).toLowerCase(), hex, `${id} ${role}`);
    assert.ok(reference.specimens.length >= reference.components.length * 0.8, `${id} has previews for most components`);
  }
});

test('Material Design 3 buttons carry the five published button types', async () => {
  const button = (await loadReference('material-web-2.3.0'))!.components.find(c => c.canonical === 'Button')!;
  assert.deepEqual(button.variants.map(v => v.name).sort(), ['elevated', 'filled', 'filled-tonal', 'outlined', 'text']);
  assert.ok(button.statesObserved.includes('disabled'));
});

test('shadcn/ui and Chakra read their variants from recipes, with the states their styles cover', async () => {
  const shadcn = (await loadReference('shadcn-ui-2026-10'))!, chakra = (await loadReference('chakra-3.37.0'))!;
  const button = (r: typeof shadcn) => r.components.find(c => c.canonical === 'Button')!;
  assert.deepEqual(button(shadcn).variants.map(v => v.name), ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']);
  assert.ok(['hover', 'focus-visible', 'disabled'].every(s => button(shadcn).statesObserved.includes(s)), 'from hover:, focus-visible: and disabled: classes');
  assert.deepEqual(button(chakra).variants.map(v => v.name), ['solid', 'subtle', 'surface', 'outline', 'ghost', 'plain']);
  assert.ok(button(chakra).statesObserved.includes('focus-visible'), 'from focusVisibleRing');
  assert.ok(!shadcn.components.some(c => /Portal|Overlay|Trigger|Header|Content$/.test(c.rawNames[0]!)), 'one component per file, parts dropped');
  assert.equal(shadcn.components.find(c => c.canonical === 'Sheet')?.category, 'Overlays');
});
