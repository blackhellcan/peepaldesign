// Extraction review (architecture Part 1 §1.8): plain language first, raw evidence behind a toggle.
const params = new URLSearchParams(location.search), id = params.get('id');
// The full review is for admins. With accounts on, everyone else sees the simple result page instead.
me.then(info => { if (info?.user && info.auth !== 'off' && !info.admin) location.replace(`/app/system.html?id=${encodeURIComponent(id ?? '')}`); });
const SEVERITY = {major: 0, minor: 1, info: 2};
const band = c => c >= 0.8 ? 'Confirmed' : c >= 0.5 ? 'Likely' : 'Inferred';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const swatch = (hex, title, note) => el('figure', {class: 'swatch', style: 'margin:0'}, el('i', {style: `background:${hex}`, 'aria-hidden': 'true'}), el('div', {}, el('strong', {}, title), el('br'), el('code', {}, hex), note ? el('div', {class: 'muted'}, note) : null));

// ── Tabs: one view at a time; the address keeps the tab (#foundations) so it can be shared or bookmarked ──
const VIEWS = ['overview', 'foundations', 'components', 'documentation', 'deliver', 'migrate'];
const tabs = [...document.querySelectorAll('.page-tabs [role="tab"]')];
function showView(view, {focus = false, push = true} = {}) {
  if (!VIEWS.includes(view)) view = 'overview';
  for (const tab of tabs) {
    const on = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  if (push) history.replaceState(null, '', view === 'overview' ? location.pathname + location.search : `#${view}`);
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
  // Arrow keys move between tabs, as for any tab list.
  tab.addEventListener('keydown', event => {
    const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
    if (step) { event.preventDefault(); showView(tabs[(i + step + tabs.length) % tabs.length].dataset.view, {focus: true}); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); showView(tabs[event.key === 'Home' ? 0 : tabs.length - 1].dataset.view, {focus: true}); }
  });
});
document.addEventListener('click', event => {
  const link = event.target.closest('[data-go]');
  if (link) { event.preventDefault(); showView(link.dataset.go); scrollTo({top: 0}); }
});
addEventListener('hashchange', () => showView(location.hash.slice(1), {push: false}));
showView(location.hash.slice(1), {push: false});

async function load() {
  if (!id) { $('#subtitle').textContent = 'No extraction id in the link.'; return; }
  let eds, scales;
  try { [eds, scales] = await Promise.all([api(`/v1/extractions/${id}?include=full`), api(`/v1/extractions/${id}/scales`)]); }
  catch (error) { $('#subtitle').textContent = error.message; return; }
  const evidence = new Map(eds.evidence.map(e => [e.id, e]));
  const sourceNames = eds.sources.map(s => s.label || s.uri);
  $('#subtitle').textContent = `Version ${eds.version} · from ${sourceNames.join(', ')} · ${new Date(eds.createdAt).toLocaleString()}`;
  crumbsFor(eds.projectId, {label: `Extraction v${eds.version}`});
  $('#extract-again').href = `/app/?project=${eds.projectId}`;

  const stat = (value, label) => el('div', {class: 'stat'}, el('b', {}, value), el('span', {}, label));
  $('#stats').replaceChildren(
    stat(scales.colors.length, 'distinct colours'),
    stat(scales.type ? scales.type.sizes.length : 0, scales.type ? `type sizes · ratio ${scales.type.ratio}` : 'type sizes'),
    stat(scales.spacing.baseUnit ? `${scales.spacing.baseUnit}px` : 'None', 'spacing grid'),
    stat(eds.components.length, 'components'),
    stat(eds.quirks.length, 'findings'),
  );

  $('#count-components').textContent = eds.components.length || '';
  const findings = [...eds.quirks].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  const important = findings.filter(q => q.severity === 'major').length;
  $('#findings-count').textContent = findings.length ? `${plural(findings.length, 'finding')}${important ? `, ${important} important` : ''}` : '';
  const FIRST = 5;
  $('#more-findings').hidden = findings.length <= FIRST;
  $('#more-findings').textContent = `Show all ${findings.length}`;
  $('#more-findings').onclick = () => { $('#findings').querySelectorAll('.finding[hidden]').forEach(f => { f.hidden = false; }); $('#more-findings').hidden = true; };
  $('#findings').replaceChildren(...(findings.length ? findings.map((q, index) => el('div', {class: 'finding', hidden: index >= FIRST},
    el('span', {class: `pill ${q.severity}`}, q.severity === 'major' ? 'Important' : q.severity === 'minor' ? 'Worth a look' : 'Note'),
    el('div', {}, el('div', {}, q.summary), q.evidence.length ? el('details', {}, el('summary', {class: 'muted'}, `Evidence (${q.evidence.length})`),
      el('ul', {}, q.evidence.slice(0, 12).map(id => { const e = evidence.get(id); return el('li', {}, el('code', {}, e ? `${e.locator} — ${e.raw.slice(0, 160)}` : id)); }))) : null),
  )) : [el('p', {class: 'empty'}, 'Nothing stood out.')]));

  $('#roles').replaceChildren(...(scales.roles.length ? scales.roles.map(r => swatch(r.hex, r.role, `Inferred: ${r.reason.toLowerCase()}`)) : [el('p', {class: 'empty'}, 'No colour roles could be inferred.')]));
  const palette = scales.colors.slice(0, 48);
  $('#palette').replaceChildren(...palette.map(c => swatch(c.hex, plural(c.count, 'use'), c.members.length > 1 ? `${c.members.length} near-identical values merged` : null)));
  if (scales.colors.length > palette.length) $('#palette').after(el('p', {class: 'muted'}, `${scales.colors.length - palette.length} less-used colours are listed under Technical details.`));

  const bodyFamily = eds.tokens.find(t => t.path === 'font.family.body')?.value || 'inherit', headingFamily = eds.tokens.find(t => t.path === 'font.family.heading')?.value;
  if (scales.type) {
    $('#type-summary').textContent = `Body text ${scales.type.basePx}px in ${bodyFamily}${headingFamily ? `, headings in ${headingFamily}` : ''}. Sizes ${scales.type.irregular ? 'do not follow' : 'follow'} a ${scales.type.ratio} scale.`;
    $('#type-scale').replaceChildren(...scales.type.sizes.slice(0, 14).map(s => el('div', {class: 'typerow'},
      el('div', {class: 'meta'}, `${s.role} · ${s.px}px`, el('br'), plural(s.count, 'use')),
      el('div', {class: 'sample', style: `font-size:${Math.min(s.px, 64)}px;font-family:${JSON.stringify(s.role === 'body' ? bodyFamily : headingFamily || bodyFamily)}`}, 'The quick brown fox'))));
  } else $('#type-summary').textContent = 'No font sizes were found in these sources.';

  const sp = scales.spacing;
  $('#space-summary').textContent = sp.baseUnit ? `${Math.round(sp.coverage * 100)}% of spacing values fit a ${sp.baseUnit}px grid.` : sp.steps.length ? 'Spacing values do not follow a 4px or 8px grid.' : 'No spacing values were found.';
  const max = Math.max(1, ...sp.steps);
  $('#spacing').replaceChildren(...sp.steps.slice(0, 16).flatMap(px => [el('span', {}, `${px}px`), el('div', {class: 'bar', style: `width:${Math.max(2, px / max * 100)}%`})]));
  $('#radius').replaceChildren(...(scales.radius.length ? scales.radius.map(r => el('div', {class: 'shape', style: `border-radius:${r.px === 'full' ? '999px' : r.px + 'px'}`}, r.name)) : [el('span', {class: 'empty'}, 'None found')]));
  $('#shadows').replaceChildren(...(scales.elevation.length ? scales.elevation.slice(0, 6).map(s => el('div', {class: 'shape', style: `box-shadow:${s.value};border-color:transparent`}, `level ${s.level}`)) : [el('span', {class: 'empty'}, 'None found')]));

  const header = el('tr', {}, el('th', {}, 'Component'), el('th', {}, 'Category'), el('th', {}, 'States seen'), el('th', {}, 'Missing'), el('th', {}, 'Variants and sizes'), el('th', {}, 'Confidence'));
  $('#component-table').replaceChildren(header, ...(eds.components.length ? eds.components.map(c => el('tr', {},
    el('td', {}, el('strong', {}, c.canonical), c.rawNames.length > 1 ? el('div', {class: 'muted'}, c.rawNames.slice(0, 4).join(', ')) : null),
    el('td', {}, c.category), el('td', {}, c.statesObserved.join(', ') || '—'),
    el('td', {}, c.statesMissing.length ? c.statesMissing.map(s => el('span', {class: `pill ${s.startsWith('focus') ? 'major' : 'minor'}`, style: 'margin-right:4px'}, s)) : '—'),
    el('td', {}, [...c.variants.map(v => v.name), ...c.sizes.map(s => 'size ' + s)].slice(0, 6).join(', ') || '—'), el('td', {}, band(c.confidence)),
  )) : [el('tr', {}, el('td', {colspan: 6, class: 'empty'}, 'No components were found.'))]));

  const assetName = new Map(eds.sources.map(s => [s.id, s.label || s.uri]));
  $('#coverage-list').replaceChildren(...eds.coverage.perAsset.map(a => el('li', {class: 'source'},
    el('span', {}, assetName.get(a.assetId) || a.assetId, a.failed.length ? el('div', {class: 'muted'}, a.failed.slice(0, 3).map(f => f.reason).join(' · ')) : null),
    el('span', {class: `pill ${a.fetched ? (a.budgetHit ? 'minor' : 'ok') : 'major'}`}, a.fetched ? `${plural(a.fetched, 'part')} read${a.budgetHit ? ', budget reached' : ''}` : 'Not read'))),
    el('li', {class: 'muted', style: 'padding-top:8px'}, `Viewports: ${eds.coverage.viewports.length ? eds.coverage.viewports.map(v => v + 'px').join(', ') : 'n/a'} · Themes: ${eds.coverage.themes.join(', ') || 'light only'}`));

  // Tokens render in pages so very large systems stay responsive.
  let shown = 100;
  const renderTokens = () => {
    const query = $('#token-filter').value.trim().toLowerCase();
    const rows = eds.tokens.filter(t => !query || t.path.toLowerCase().includes(query) || String(t.value).toLowerCase().includes(query));
    $('#token-table').replaceChildren(el('tr', {}, el('th', {}, 'Token'), el('th', {}, 'Value'), el('th', {}, 'Tier'), el('th', {}, 'Status'), el('th', {}, 'Confidence'), el('th', {}, 'Evidence')),
      ...rows.slice(0, shown).map(t => el('tr', {}, el('td', {}, el('code', {}, t.path)), el('td', {}, el('code', {}, String(t.value)), t.aliasOf ? el('div', {class: 'muted'}, '→ ' + t.aliasOf) : null),
        el('td', {}, t.tier), el('td', {}, t.status === 'unresolved' ? el('span', {class: 'pill minor'}, 'unresolved') : t.status), el('td', {}, band(t.confidence)),
        el('td', {}, t.evidence.slice(0, 2).map(id => el('div', {}, el('code', {}, evidence.get(id)?.locator || id))), t.evidence.length > 2 ? el('div', {class: 'muted'}, `+${t.evidence.length - 2} more`) : null))));
    $('#more-tokens').hidden = rows.length <= shown;
    $('#more-tokens').textContent = `Show more (${rows.length - shown} left)`;
  };
  $('#token-filter').addEventListener('input', () => { shown = 100; renderTokens(); });
  $('#more-tokens').addEventListener('click', () => { shown += 200; renderTokens(); });
  $('#technical').addEventListener('toggle', renderTokens, {once: true});
}
load();

// Reference recommendations and starting a GapScan from this extraction.
async function recommendations() {
  if (!id) return;
  try {
    const ranked = await api(`/v1/extractions/${id}/recommendations`);
    if (ranked[0]) $('#next-migrate').textContent = `Closest fit: ${ranked[0].library} (${ranked[0].reason.charAt(0).toLowerCase()}${ranked[0].reason.slice(1)}). Priced component by component.`;
    reports(ranked);
    $('#recs').replaceChildren(...ranked.map((r, i) => el('div', {class: 'rec'},
      el('div', {}, el('strong', {}, `${r.library} ${r.version}`), i === 0 ? el('span', {class: 'pill ok', style: 'margin-left:8px'}, 'Closest fit') : null, el('div', {class: 'muted'}, `${r.reason} · ${r.framework}`)),
      el('button', {class: i === 0 ? 'primary' : '', type: 'button', onclick: () => startScan(r.id)}, 'Run GapScan'))));
  } catch (error) { $('#recs').replaceChildren(el('p', {class: 'error'}, error.message)); }
}
// Reports already run on this extraction, so they can be reopened.
async function reports(ranked) {
  try {
    const list = await api(`/v1/extractions/${id}/gapscans`), names = new Map(ranked.map(r => [r.id, `${r.library} ${r.version}`]));
    $('#count-migrate').textContent = list.length || '';
    $('#reports-card').hidden = !list.length;
    $('#reports').replaceChildren(...list.map(r => {
      const totals = r.summary?.totals, hours = totals?.available ? `${Math.round(totals.low)}–${Math.round(totals.high)} h` : 'Not estimated';
      return el('li', {class: 'source'}, el('a', {href: `/app/gapscan.html?id=${r.id}`}, names.get(r.referenceId) ?? r.referenceId),
        el('span', {class: 'muted'}, `${hours} · ${new Date(r.updatedAt).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})}`));
    }));
  } catch {}
}
async function startScan(referenceId) {
  const box = $('#scan-log'); box.hidden = false; box.textContent = 'Starting…\n';
  document.querySelectorAll('#recs button').forEach(b => { b.disabled = true; });
  try {
    const {events} = await api('/v1/gapscans', {method: 'POST', body: JSON.stringify({edsId: id, referenceId})});
    const stream = new EventSource(events);
    stream.addEventListener('progress', e => { box.textContent += JSON.parse(e.data).body.message + '\n'; });
    stream.addEventListener('complete', e => { stream.close(); location.href = `/app/gapscan.html?id=${JSON.parse(e.data).body.resultId}`; });
    stream.addEventListener('failed', e => { stream.close(); box.textContent += 'Failed: ' + JSON.parse(e.data).body.message; document.querySelectorAll('#recs button').forEach(b => { b.disabled = false; }); });
  } catch (error) { box.textContent += error.message; document.querySelectorAll('#recs button').forEach(b => { b.disabled = false; }); }
}
recommendations();

// Hand-off downloads and missing-object review.
const FORMATS = [['dtcg', 'tokens.json (DTCG)'], ['css', 'CSS variables'], ['tailwind4', 'Tailwind v4 theme'], ['scss', 'SCSS variables']];
if (id) $('#exports').replaceChildren(...FORMATS.map(([format, label]) => el('a', {class: 'button', href: `/v1/extractions/${id}/export?format=${format}`, download: ''}, label)));


// Figma Variables: preview, then an explicit confirmation that applies exactly that preview.
$('#figma-form').addEventListener('submit', async event => {
  event.preventDefault();
  const fileUrl = event.target.elements.fileUrl.value.trim(), out = $('#figma-result');
  out.replaceChildren(el('p', {class: 'muted'}, 'Reading the file’s variables…'));
  try {
    const plan = await api(`/v1/extractions/${id}/figma-sync/plan`, {method: 'POST', body: JSON.stringify({fileUrl})});
    const row = c => el('tr', {}, el('td', {}, el('code', {}, c.name)), el('td', {}, c.mode), el('td', {}, c.before ?? 'new'), el('td', {}, c.after));
    const apply = el('button', {class: 'primary', type: 'button'}, `Apply ${plan.create.length + plan.update.length} changes to Figma`);
    apply.disabled = !plan.create.length && !plan.update.length;
    apply.addEventListener('click', async () => {
      if (!confirm(`Write ${plan.create.length} new and ${plan.update.length} changed values to the “${plan.collection}” collection in this Figma file?`)) return;
      apply.disabled = true;
      try { const done = await api(`/v1/extractions/${id}/figma-sync/apply`, {method: 'POST', body: JSON.stringify({fileUrl, hash: plan.hash, confirm: true})}); out.append(el('p', {}, done.applied ? `Done: ${done.created} new, ${done.updated} changed.` : done.message)); }
      catch (error) { apply.disabled = false; out.append(el('p', {class: 'error'}, error.message)); }
    });
    out.replaceChildren(
      el('p', {}, `${plan.collectionExists ? 'Updating' : 'Creating'} the “${plan.collection}” collection (modes: ${plan.modes.join(', ')}): ${plan.create.length} new, ${plan.update.length} changed, ${plan.unchanged} unchanged, ${plan.skipped.length} skipped.`),
      [...plan.create, ...plan.update].length ? el('div', {class: 'table-wrap'}, el('table', {}, el('tr', {}, el('th', {}, 'Variable'), el('th', {}, 'Mode'), el('th', {}, 'Now'), el('th', {}, 'After')), [...plan.update, ...plan.create].slice(0, 40).map(row))) : '',
      plan.skipped.length ? el('details', {}, el('summary', {class: 'muted'}, `Skipped (${plan.skipped.length})`), el('ul', {}, plan.skipped.map(s => el('li', {}, `${s.path}: ${s.reason}`)))) : '',
      el('div', {class: 'row'}, apply));
  } catch (error) { out.replaceChildren(el('p', {class: 'error'}, error.message)); }
});

// The Figma-style library view of this extraction (also saved as a self-contained file with ?download=1).
if (id) { $("#design-system").href = $("#design-system-components").href = `/v1/extractions/${id}/design-system.html`; $("#figma-export").href = `/v1/extractions/${id}/figma-export.json`; }
// Figma: one card, two ways in.
document.querySelectorAll('input[name="figma-mode"]').forEach(radio => radio.addEventListener('change', () => {
  const mode = document.querySelector('input[name="figma-mode"]:checked').value;
  $('#figma-library').hidden = mode !== 'library'; $('#figma-sync').hidden = mode !== 'sync';
}));
