// The result page: your design system laid out, and three things to do with it.
const id = new URLSearchParams(location.search).get('id');
let projectId = null, extractedAt = null, added = [];

function showName(name) {
  $('#system-name').textContent = name;
  setCrumbs([{label: 'Design systems', href: '/app/'}, {label: name}]);
}
async function load() {
  if (!id) { $('#system-meta').textContent = 'No design system in the link.'; return; }
  try {
    const record = await api(`/v1/extractions/${id}`);
    projectId = record.projectId;
    const project = await api(`/v1/projects/${projectId}`);
    showName(project.name);
    const sources = project.sources.filter(s => s.role !== 'application');
    const latest = [...project.extractions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    $('#system-meta').textContent = `Read from ${sources.map(s => s.kind === 'figma' ? `Figma file “${decodeURIComponent(new URL(s.uri).pathname.split('/')[3] ?? 'Figma').replace(/[-_]+/g, ' ')}”` : s.kind === 'url' ? new URL(s.uri).hostname.replace(/^www\./, '') : s.label || s.uri.replace(/^inline:/, '')).join(', ') || 'your sources'} · ${new Date(record.createdAt).toLocaleDateString(undefined, {day: 'numeric', month: 'long', year: 'numeric'})}`;
    if (latest && latest.id !== id) $('#system-meta').append(' · ', el('a', {href: `/app/system.html?id=${latest.id}`}, 'A newer version exists'));
    $('#update').href = `/app/?project=${projectId}`;
    // Sources added after this version was read are waiting for "Update my design system".
    extractedAt = record.createdAt;
    added = sources.filter(s => s.createdAt > extractedAt);
    renderAdded();
    api(`/v1/extractions/${id}/missing`).then(renderMissing).catch(() => {});
  } catch (error) { $('#system-meta').textContent = ''; $('#system-error').textContent = error.message; return; }
  const preview = `/v1/extractions/${id}/design-system.html`;
  $('#preview').src = `${preview}?embed=1`;
  $('#preview-open').href = preview;
  $('#action-export').href = `/app/export.html?id=${id}`;
  $('#action-documents').href = `/app/documents.html?id=${id}`;
  $('#action-migrate').href = `/app/migrate.html?id=${id}`;
  $('#more-tools').href = `/app/tools.html?id=${id}`;
  api(`/v1/extractions/${id}/recommendations`).then(ranked => {
    if (ranked[0]) $('#migrate-note').textContent = `Closest match: ${ranked[0].library}. See what moving to it takes.`;
  }).catch(() => {});
  api(`/v1/extractions/${id}/objects`).then(list => {
    const pct = Math.round(list.reduce((sum, o) => sum + o.completeness, 0) / Math.max(1, list.length) * 100);
    $('#documents-note').textContent = `${pct}% written today. Generate the rest and download them.`;
  }).catch(() => {});
}

$('#rename').addEventListener('click', () => {
  $('#rename-input').value = $('#system-name').textContent;
  $('#title-show').hidden = true; $('#rename-form').hidden = false; $('#rename-input').select();
});
const closeRename = () => { $('#title-show').hidden = false; $('#rename-form').hidden = true; };
$('#rename-cancel').addEventListener('click', closeRename);
$('#rename-input').addEventListener('keydown', event => { if (event.key === 'Escape') closeRename(); });
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { showName((await api(`/v1/projects/${projectId}`, {method: 'PATCH', body: JSON.stringify({name: $('#rename-input').value})})).name); closeRename(); }
  catch (error) { $('#system-error').textContent = error.message; }
});
load();

// ── Add what we missed: component code or quick tokens, then read everything again ──
const KIND_LABEL = {code: 'Code', file: 'File', url: 'Website', figma: 'Figma file', image: 'Image', pdf: 'PDF', zip: 'ZIP archive', pptx: 'PowerPoint', docx: 'Word', markdown: 'Markdown'};
function renderMissing(missing) {
  $('#missing-found').textContent = `${missing.found.components} component${missing.found.components === 1 ? '' : 's'} found`;
  const chips = [...missing.components.map(name => ({name, kind: 'code'})), ...missing.foundations.map(name => ({name, kind: 'tokens'}))];
  $('#missing-chips-wrap').hidden = !chips.length;
  const FIRST = 8, chip = c => el('button', {type: 'button', class: 'chip', onclick: () => startAdding(c)}, c.name);
  const more = chips.length > FIRST ? el('button', {type: 'button', class: 'chip more', onclick: () => more.replaceWith(...chips.slice(FIRST).map(chip))}, `${chips.length - FIRST} more`) : null;
  $('#missing-chips').replaceChildren(...chips.slice(0, FIRST).map(chip), ...(more ? [more] : []));
}
const TOKEN_KINDS = {'Colours': 'color', 'Typefaces': 'font-family', 'Type sizes': 'font-size', 'Spacing': 'space', 'Corner radius': 'radius', 'Shadows': 'shadow'};
function startAdding(chip) {
  showAddTab(chip.kind);
  if (chip.kind === 'code') { $('#add-code-name').value = `${chip.name.replace(/[^A-Za-z0-9]+/g, '')}.tsx`; $('#add-code-text').focus(); }
  else { const row = tokenRow(TOKEN_KINDS[chip.name] ?? 'color'); $('#token-rows').prepend(row); row.querySelector('input').focus(); }
}
function showAddTab(kind) {
  document.querySelectorAll('[data-add]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.add === kind)));
  document.querySelectorAll('.add-panel').forEach(p => { p.hidden = p.dataset.panel !== kind; });
}
document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => showAddTab(b.dataset.add)));

function renderAdded() {
  $('#pending-wrap').hidden = !added.length;
  $('#pending-list').replaceChildren(...added.map(s => el('li', {class: 'source-card'}, el('span', {class: 'kind-icon kind-code', 'aria-hidden': 'true'}),
    el('span', {class: 'source-text'}, el('span', {class: 'source-title'}, s.label || s.uri.replace(/^inline:/, '')), el('span', {class: 'muted source-detail'}, KIND_LABEL[s.kind] ?? s.kind)))));
  $('#update-system').disabled = !added.length;
}
async function addSource(body) {
  $('#add-error').textContent = '';
  const source = await api(`/v1/projects/${projectId}/sources`, {method: 'POST', body: JSON.stringify(body)});
  added.push(source); renderAdded();
}
const safeName = name => name.replace(/[^\w .()@-]/g, '_');
$('#add-code-form').addEventListener('submit', async event => {
  event.preventDefault();
  const content = $('#add-code-text').value, name = safeName($('#add-code-name').value.trim() || 'Component.tsx');
  if (!content.trim()) { $('#add-error').textContent = 'Paste the component’s source code first, or upload its files.'; $('#add-code-text').focus(); return; }
  try { await addSource({kind: 'code', name, content}); $('#add-code-text').value = ''; $('#add-code-name').value = 'Component.tsx'; }
  catch (error) { $('#add-error').textContent = error.message; }
});
$('#add-code-files').addEventListener('change', async () => {
  for (const file of $('#add-code-files').files) {
    if (file.size > 40 * 1048576) { $('#add-error').textContent = `${file.name} is over the 40 MB limit.`; continue; }
    try { await addSource({kind: 'code', name: safeName(file.name), content: await file.text()}); }
    catch (error) { $('#add-error').textContent = `${file.name}: ${error.message}`; }
  }
  $('#add-code-files').value = '';
});

// Quick tokens become CSS custom properties, which GapScan reads like any stylesheet.
const KINDS = [['color', 'Colour', '#7C3AED'], ['font-family', 'Typeface', 'Inter, sans-serif'], ['font-size', 'Type size', '16px'], ['space', 'Spacing', '8px'], ['radius', 'Corner radius', '8px'], ['shadow', 'Shadow', '0 1px 3px rgba(0,0,0,.2)']];
function tokenRow(kind = 'color') {
  const select = el('select', {'aria-label': 'Kind'}, KINDS.map(([value, label]) => el('option', {value, selected: value === kind}, label)));
  const name = el('input', {type: 'text', placeholder: 'Name, e.g. brand', 'aria-label': 'Name', maxlength: '60'});
  const value = el('input', {type: 'text', 'aria-label': 'Value', maxlength: '200'});
  const swatch = el('span', {class: 'token-swatch', 'aria-hidden': 'true'});
  const sync = () => { const k = KINDS.find(([v]) => v === select.value); value.placeholder = k[2]; swatch.style.visibility = select.value === 'color' ? 'visible' : 'hidden'; swatch.style.background = value.value || k[2]; };
  select.addEventListener('change', sync); value.addEventListener('input', sync); sync();
  return el('div', {class: 'token-row'}, select, name, swatch, value, el('button', {type: 'button', class: 'quiet', 'aria-label': 'Remove', onclick: event => event.target.closest('.token-row').remove()}, 'Remove'));
}
$('#add-token-row').addEventListener('click', () => $('#token-rows').append(tokenRow()));
$('#token-rows').append(tokenRow());
$('#add-tokens-form').addEventListener('submit', async event => {
  event.preventDefault();
  const rows = [...document.querySelectorAll('.token-row')].map(r => ({kind: r.querySelector('select').value, name: r.querySelectorAll('input')[0].value.trim(), value: r.querySelectorAll('input')[1].value.trim()})).filter(r => r.value);
  if (!rows.length) { $('#add-error').textContent = 'Fill in at least one value.'; return; }
  const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const bad = rows.find(r => /[;{}<>]/.test(r.value));
  if (bad) { $('#add-error').textContent = `“${bad.value}” isn’t a value GapScan can use.`; return; }
  // Each value becomes a variable plus a rule that uses it, because GapScan reads typefaces, sizes, radii
  // and shadows from where they're used. Attribute selectors keep these rules from looking like components.
  const named = rows.map((r, i) => ({...r, variable: `--${r.kind}-${slug(r.name) || i + 1}`, key: slug(r.name) || String(i + 1)}));
  const USE = {
    'font-family': r => `${/head|display|title/i.test(r.name) ? 'h1, h2, h3' : 'body'} { font-family: ${r.value}; }`,
    'font-size': r => `[data-text="${r.key}"] { font-size: ${r.value}; }`,
    radius: r => `[data-radius="${r.key}"] { border-radius: ${r.value}; }`,
    shadow: r => `[data-elevation="${r.key}"] { box-shadow: ${r.value}; }`,
  };
  const css = `:root {\n${named.map(r => `  ${r.variable}: ${r.value};`).join('\n')}\n}\n${named.filter(r => USE[r.kind]).map(r => USE[r.kind](r)).join('\n')}\n`;
  try {
    await addSource({kind: 'code', name: `added-styles-${added.length + 1}.css`, content: css});
    $('#token-rows').replaceChildren(tokenRow());
  } catch (error) { $('#add-error').textContent = error.message; }
});

// Read everything again (saved website pages are reused) and open the new version.
$('#update-system').addEventListener('click', async () => {
  const button = $('#update-system'), progress = $('#update-progress');
  button.disabled = true; progress.hidden = false; $('#update-status').textContent = 'Starting…';
  try {
    const {resultId} = await runJob(`/v1/projects/${projectId}/extractions`, message => { $('#update-status').textContent = message; });
    location.href = `/app/system.html?id=${resultId}`;
  } catch (error) { button.disabled = false; progress.hidden = true; $('#add-error').textContent = error.message; }
});
