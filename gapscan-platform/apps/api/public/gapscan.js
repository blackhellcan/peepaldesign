// GapScan executive dashboard (architecture Part 2 §2.3–2.5). Every number comes
// from the server; this page only formats it. Technical detail loads on demand.
const reportId = new URLSearchParams(location.search).get('id');
const LEVELS = {1: 'Trivial', 2: 'Easy', 3: 'Moderate', 4: 'Hard', 5: 'Very hard'};
const DECISION_LABEL = {keep: 'Keep', update: 'Update', replace: 'Find a replacement', check_first: 'Check first', optional: 'Optional addition'};
const AREA_ORDER = ['Foundations and tokens', 'Layout and structure', 'Actions', 'Forms and input', 'Navigation', 'Data display', 'Feedback and status', 'Overlays', 'Media and identity', 'Patterns and page templates', 'Content and voice', 'Utilities and tooling', 'Miscellaneous'];
const money = v => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0}).format(v);
const num = v => Number(v.toFixed(1)).toLocaleString();
const range = (low, high, format = num) => format(low) === format(high) ? format(low) : `${format(low)}–${format(high)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
let report, reference, techLoaded = null, suggestions = {}, aiEnabled = false;

const kpi = (value, label) => el('div', {class: 'stat'}, el('b', {}, value), el('span', {}, label));
function complexityWord(c) { return c === null ? 'Not estimated' : c < 1.5 ? 'Trivial' : c < 2.5 ? 'Easy' : c < 3.5 ? 'Moderate' : c < 4.5 ? 'Hard' : 'Very hard'; }

function headline() {
  const t = report.totals, required = report.items.filter(i => i.decision !== 'optional' && !(i.usage && !i.usage.usages));
  const areas = areaHours();
  const heaviest = Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a]) => a.toLowerCase());
  const same = required.filter(i => i.decision === 'keep').length;
  if (!t.available) return `Nothing can be estimated yet: ${plural(t.notEstimatedCount, 'item')} need a reviewer before the plan is priced.`;
  const word = complexityWord(t.complexity).toLowerCase();
  const detail = [same ? `${plural(same, 'component')} already ${same === 1 ? 'matches' : 'match'}` : '', heaviest.length ? `most of the work is in ${heaviest.join(' and ')}` : ''].filter(Boolean).join('; ');
  return `Moving to ${reference.library} is ${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word} project.${detail ? ` ${detail[0].toUpperCase()}${detail.slice(1)}.` : ''}`;
}

function areaHours() {
  const areas = {};
  for (const item of report.items) if (item.decision !== 'optional' && item.effort.low !== null && !report.assumptions.excluded.includes(item.id) && !(item.usage && !item.usage.usages)) areas[item.category] = (areas[item.category] || 0) + (item.effort.low + item.effort.high) / 2;
  return areas;
}

function renderSummary() {
  const t = report.totals, a = report.assumptions, required = report.items.filter(i => i.decision !== 'optional');
  $('#headline').textContent = headline();
  $('#kpis').replaceChildren(
    kpi(required.length, 'components compared'),
    kpi(t.complexity === null ? '—' : `${t.complexity} / 5`, complexityWord(t.complexity)),
    kpi(t.available ? range(t.low, t.high) : '—', 'engineering hours'),
    kpi(t.available ? range(t.costLow, t.costHigh, money) : '—', `at ${money(a.rate)}/h`),
    kpi(t.available ? range(t.weeksLow, t.weeksHigh) : '—', `weeks · ${plural(a.engineers, 'engineer')}`),
    ...(t.consumer ? [kpi(t.consumer.usages.toLocaleString(), `call sites · ${range(t.consumer.low, t.consumer.high)} h to update`)] : []),
  );
  const counts = t.levelCounts, total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
  const segments = [1, 2, 3, 4, 5].map(l => ({key: String(l), label: `${l} ${LEVELS[l]}`, n: counts[l] || 0})).concat([{key: 'na', label: 'Needs review', n: counts.not_estimated || 0}]);
  $('#mix').setAttribute('aria-label', segments.map(s => `${s.label}: ${s.n}`).join(', '));
  $('#mix').replaceChildren(...segments.filter(s => s.n).map(s => el('span', {class: `seg l${s.key}`, style: `flex:${s.n / total}`, title: `${s.label}: ${s.n}`})));
  $('#mix-legend').replaceChildren(...segments.map(s => el('span', {class: 'key'}, el('i', {class: `seg l${s.key}`}), `${s.label} ${s.n}`)));

  const line = item => el('li', {class: 'source'}, el('a', {href: `#item-${CSS.escape(item.id)}`}, item.name), el('span', {class: 'pill'}, item.effort.label));
  // Components the app never uses are not work, so they are not quick wins or breaking changes either.
  const inUse = i => !(i.usage && !i.usage.usages);
  const wins = report.items.filter(i => i.quickWin && inUse(i)), breaking = report.items.filter(i => i.breaking && i.decision !== 'optional' && inUse(i));
  $('#wins').replaceChildren(...(wins.length ? wins.map(line) : [el('li', {class: 'empty'}, 'None found.')]));
  const review = report.items.filter(i => ['replace', 'check_first'].includes(i.decision) && inUse(i));
  $('#needs-review').replaceChildren(...(review.length ? review.map(i => el('li', {class: 'source'}, el('a', {href: `#item-${CSS.escape(i.id)}`}, i.name), el('span', {class: 'pill minor'}, DECISION_LABEL[i.decision])))
    : [el('li', {class: 'empty'}, 'Nothing: every component has a decision.')]));
  $('#breaking').replaceChildren(...(breaking.length ? breaking.map(i => el('li', {class: 'source'}, el('a', {href: `#item-${CSS.escape(i.id)}`}, i.name), el('span', {class: 'pill major'}, i.decision === 'replace' ? 'No counterpart' : i.effort.label))) : [el('li', {class: 'empty'}, 'None found.')]));

  const decisions = {};
  for (const item of report.items) decisions[item.decision] = (decisions[item.decision] || 0) + 1;
  // Optional additions are things the reference has and you don't: worth knowing, never work.
  $('#decisions').textContent = Object.entries(DECISION_LABEL).filter(([k]) => k !== 'optional').map(([k, label]) => `${label} ${decisions[k] || 0}`).join(' · ')
    + (decisions.optional ? `. Plus ${decisions.optional} optional addition${decisions.optional === 1 ? '' : 's'} in ${reference.library} you don't use today.` : '');
  const areas = areaHours(), max = Math.max(1, ...Object.values(areas));
  $('#areas').replaceChildren(...(Object.keys(areas).length ? AREA_ORDER.filter(a => areas[a]).flatMap(a => [el('span', {}, a), el('div', {class: 'row'}, el('div', {class: 'bar', style: `width:${Math.max(4, areas[a] / max * 70)}%`}), el('span', {class: 'muted'}, `${num(areas[a])} h`))]) : [el('span', {class: 'empty'}, 'No estimated work yet.')]));
  $('#order').replaceChildren(...AREA_ORDER.filter(a => areas[a]).map(a => el('li', {}, a)), ...(report.tokenCategories.length ? [el('li', {}, 'Token mapping: ' + report.tokenCategories.map(c => `${c.name} (${c.remappedTokens})`).join(', '))] : []));
  $('#exclusions').replaceChildren(...report.exclusions.map(x => el('li', {}, x)));
  const form = $('#assumptions');
  for (const name of ['rate', 'apps', 'engineers', 'qaPct']) form.elements[name].value = a[name];
}

function specimenFrame(html, css) {
  // Captured markup renders in an isolated, script-free frame with its own styles: never re-themed.
  return el('iframe', {class: 'specimen', sandbox: '', title: 'Captured example', srcdoc: `<!doctype html><style>body{margin:12px;font-family:system-ui}${css || ''}</style>${html || ''}`});
}

function itemCard(item) {
  const card = el('details', {class: 'item', id: `item-${item.id}`});
  const target = reference.components.find(c => c.id === item.match.targetId);
  card.append(el('summary', {}, el('span', {class: 'name'}, item.name),
    el('span', {class: `pill ${item.decision === 'replace' || item.decision === 'check_first' ? 'minor' : ''}`}, DECISION_LABEL[item.decision]),
    el('span', {class: 'pill'}, item.effort.label), el('span', {class: 'muted'}, item.effort.low === null ? '' : `${range(item.effort.low, item.effort.high)} h`),
    item.usage ? el('span', {class: `pill ${item.usage.usages ? '' : 'ok'}`}, item.usage.usages ? `${plural(item.usage.usages, 'use')} · ${plural(item.usage.screens, 'screen')}` : 'Not used') : null));
  card.addEventListener('toggle', () => { if (card.open && !card.dataset.built) { card.dataset.built = '1'; card.append(itemBody(item, target)); } });
  return card;
}

function itemBody(item, target) {
  const body = el('div', {class: 'item-body'});
  const specimen = item.beforeSpecimenId && specimens.get(item.beforeSpecimenId);
  body.append(el('div', {class: 'grid two'},
    el('div', {}, el('h3', {}, 'Before (your system)'), specimen ? [specimenFrame(specimen.html, specimen.css), el('p', {class: 'muted'}, specimen.origin === 'captured' ? 'Captured from your source.' : 'Inferred example: your CSS rules applied to generated markup.')] : el('p', {class: 'empty'}, 'No runnable example was captured for this component.')),
    el('div', {}, el('h3', {}, `After (${reference.library})`), target
      ? el('div', {}, projectionSlot(item), el('strong', {}, target.canonical), el('p', {class: 'muted'}, [target.variants.length && `Styles: ${target.variants.slice(0, 8).join(', ')}`, target.sizes.length && `Sizes: ${target.sizes.join(', ')}`, target.states.length && `States: ${target.states.join(', ')}`].filter(Boolean).join(' · ') || 'No published options captured.'))
      : el('p', {class: 'empty'}, item.decision === 'optional' ? 'Only in the reference system.' : 'No counterpart in the reference system.'))));
  if (item.diffs.length) body.append(el('h3', {}, 'What changes'), el('ul', {}, item.diffs.map(d => el('li', {}, d.summary))));
  body.append(el('p', {}, el('strong', {}, 'Why this level: '), item.effort.basis || '—'));
  if (item.usage) body.append(el('p', {}, el('strong', {}, 'In your app: '), item.usage.usages ? `${item.usage.usages} usages in ${plural(item.usage.files, 'file')} (${plural(item.usage.screens, 'screen')}). ${Object.entries(item.usage.propUsages).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([p, n]) => `${p} ×${n}`).join(', ')}` : 'Not used in the scanned code, so it is left out of required work.'));
  if (item.acceptance.length) body.append(el('p', {}, el('strong', {}, 'Done when: '), item.acceptance.join(' · ')));
  body.append(el('p', {class: 'muted'}, `Match: ${item.match.status} (score ${item.match.score}) — ${item.match.reasons.join('; ')}${item.match.approvedBy ? ` · approved by ${item.match.approvedBy}` : ''}`));
  if (['replace', 'check_first'].includes(item.decision) || item.match.status !== 'confirmed') body.append(reviewForm(item));
  const tech = el('details', {class: 'tech'}, el('summary', {}, 'Technical details'));
  tech.addEventListener('toggle', async () => {
    if (!tech.open || tech.dataset.built) return;
    tech.dataset.built = '1';
    techLoaded ??= api(`/v1/gapscans/${reportId}?include=tech`);
    const full = (await techLoaded).items.find(i => i.id === item.id);
    const rows = full?.tech?.tokenDiff || [], props = full?.tech?.propMap || [];
    tech.append(rows.length ? el('table', {}, el('tr', {}, el('th', {}, 'Slot'), el('th', {}, 'Yours'), el('th', {}, 'Reference'), el('th', {}, 'Change')), rows.map(r => el('tr', {}, el('td', {}, el('code', {}, r.slot)), el('td', {}, el('code', {}, r.before)), el('td', {}, el('code', {}, r.after ?? '—')), el('td', {}, r.change)))) : el('p', {class: 'empty'}, 'No role-level token mapping.'),
      props.length ? el('ul', {}, props.map(p => el('li', {}, el('code', {}, `${p.from} → ${p.to ?? '(no equivalent)'}`)))) : '',
      el('p', {class: 'muted'}, `Drivers: ${item.effort.drivers.join(', ') || 'none'}`));
  });
  body.append(tech);
  return body;
}

// The projected preview loads only when a card opens; it is never presented as built code.
function projectionSlot(item) {
  const slot = el('div', {}, el('p', {class: 'muted'}, item.afterSpecimenId ? 'Loading projected preview…' : 'The reference has no example for this component.'));
  if (item.afterSpecimenId) api(`/v1/gapscans/${reportId}/items/${encodeURIComponent(item.id)}/projection`).then(p => {
    const note = p.substitutions.length ? `Projected preview: ${reference.library} CSS with your colours (${p.substitutions.map(s => `${s.from} → ${s.to}`).slice(0, 3).join(', ')}). Not built yet.` : `Projected preview: ${reference.library} CSS; no brand colour needed swapping. Not built yet.`;
    slot.replaceChildren(specimenFrame(p.html, p.css), el('p', {class: 'muted'}, note));
  }).catch(error => slot.replaceChildren(el('p', {class: 'muted'}, error.message)));
  return slot;
}

function reviewForm(item) {
  const suggestion = suggestions[item.match.sourceId];
  const options = [el('option', {value: ''}, 'No counterpart: approve a custom build or replacement'), ...reference.components.filter(c => c.category === item.category || c.id === item.match.targetId || c.id === suggestion?.targetId).map(c => el('option', {value: c.id, selected: c.id === item.match.targetId}, `${c.canonical} (${c.category})`))];
  const form = el('form', {class: 'review'}, el('h3', {}, 'Reviewer decision'),
    el('label', {}, 'Counterpart', el('select', {name: 'target'}, options)),
    el('label', {}, 'Your name or email', el('input', {type: 'text', name: 'by', required: true})),
    el('label', {}, 'Reason', el('input', {type: 'text', name: 'reason', required: true})),
    el('div', {class: 'row'}, el('button', {class: 'primary', type: 'submit'}, 'Approve mapping'), el('span', {class: 'muted', 'aria-live': 'polite'})));
  if (item.match.status !== 'confirmed' && !item.match.sourceId.startsWith('target:')) form.querySelector('h3').after(suggestionBlock(item, suggestion, form));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const status = form.querySelector('[aria-live]');
    status.textContent = 'Saving…';
    try {
      await api(`/v1/gapscans/${reportId}/matches/${encodeURIComponent(item.match.sourceId)}`, {method: 'PUT', body: JSON.stringify({targetId: form.elements.target.value || null, by: form.elements.by.value, reason: form.elements.reason.value})});
      techLoaded = null; await load(); status.textContent = 'Saved.';
    } catch (error) { status.textContent = error.message; }
  });
  return form;
}

// Claude's suggestion is advice: using it fills in the form, and the mapping counts only once a reviewer approves it.
function suggestionBlock(item, suggestion, form) {
  const box = el('div', {class: 'suggestion'}), note = el('span', {class: 'muted', 'aria-live': 'polite'});
  if (suggestion) {
    const target = reference.components.find(c => c.id === suggestion.targetId);
    const use = el('button', {type: 'button'}, 'Use this suggestion');
    use.addEventListener('click', () => {
      form.elements.target.value = suggestion.targetId ?? '';
      form.elements.reason.value = `Claude's suggestion (${suggestion.confidence} confidence), checked by reviewer: ${suggestion.rationale}`.slice(0, 1000);
      form.elements.by.focus();
    });
    box.append(el('p', {}, el('strong', {}, 'Claude suggests: '), target ? `${target.canonical} (${target.category})` : `no ${reference.library} counterpart`, ' ', el('span', {class: 'pill'}, `${suggestion.confidence} confidence`)),
      el('p', {}, suggestion.rationale), el('p', {class: 'muted'}, `${suggestion.model}, ${new Date(suggestion.at).toLocaleString()}. Not applied until you approve the mapping below.`));
    box.append(el('div', {class: 'row'}, use, aiEnabled ? askButton('Ask again') : null, note));
  } else if (aiEnabled) box.append(el('div', {class: 'row'}, askButton('Ask Claude for a match'), note));
  else return el('span');
  function askButton(label) {
    const button = el('button', {type: 'button'}, label);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await runJob(`/v1/gapscans/${reportId}/matches/${encodeURIComponent(item.match.sourceId)}/suggestion`, message => { note.textContent = message; });
        suggestions = await api(`/v1/gapscans/${reportId}/suggestions`);
        form.replaceWith(reviewForm(item));
      } catch (error) { button.disabled = false; note.textContent = error.message; }
    });
    return button;
  }
  return box;
}

let specimens = new Map();
function renderItems() {
  const filter = $('#filter').value;
  const needsReview = i => ['replace', 'check_first'].includes(i.decision) ? 0 : 1;
  const visible = report.items.filter(i => filter === 'all' ? i.decision !== 'optional' : filter === 'review' ? ['replace', 'check_first'].includes(i.decision) : i.decision === filter)
    .sort((a, b) => needsReview(a) - needsReview(b) || (b.effort.level ?? 6) - (a.effort.level ?? 6) || a.name.localeCompare(b.name));
  $('#items').replaceChildren(...(visible.length ? visible.map(itemCard) : [el('p', {class: 'empty'}, 'Nothing in this view.')]));
  const optional = report.items.filter(i => i.decision === 'optional').length;
  $('#optional-note').hidden = filter === 'optional' || !optional;
  $('#optional-note').replaceChildren(`${plural(optional, 'optional addition')}: components ${reference.library} has that you don't use today. Not counted as work. `,
    el('button', {type: 'button', class: 'quiet', onclick: () => { $('#filter').value = 'optional'; renderItems(); }}, 'Show them'));
}

// ── Codemod ──
function diffBlock(diff) {
  return el('pre', {class: 'diff'}, diff.trimEnd().split('\n').map(line => el('span', {class: line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'file' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : null}, line + '\n')));
}
function renderCodemod(plan, run) {
  const covered = plan.rules.components.map(c => c.component === c.target ? c.component : `${c.component} → ${c.target}`);
  const parts = [el('p', {}, covered.length ? `Rules for ${plural(covered.length, 'component')}: ${covered.join(', ')}.` : 'No confirmed matches can be rewritten automatically yet.')];
  if (plan.notes.length) parts.push(el('details', {}, el('summary', {}, `Changes by hand (${plan.notes.length})`), el('ul', {class: 'muted'}, plan.notes.map(n => el('li', {}, n)))));
  if (run) {
    const t = run.totals;
    parts.push(el('div', {class: 'grid stats'}, kpi(t.changes.toLocaleString(), `edits in ${plural(t.filesChanged, 'file')}`), kpi(t.manual.toLocaleString(), 'call sites to change by hand'), kpi(t.filesRead.toLocaleString(), 'files read')));
    if (run.hash !== plan.hash) parts.push(el('p', {class: 'error'}, 'The report has changed since this dry run. Run it again before downloading the script.'));
    parts.push(...run.files.map(f => el('details', {class: 'item'},
      el('summary', {}, el('span', {class: 'name'}, el('code', {}, f.path)), f.changes ? el('span', {class: 'pill'}, plural(f.changes, 'edit')) : null, f.manual.length ? el('span', {class: 'pill minor'}, `${f.manual.length} by hand`) : null),
      f.manual.length ? el('ul', {}, f.manual.map(m => el('li', {}, `Line ${m.line}${m.component ? ` · ${m.component}` : ''}: ${m.reason}`))) : null,
      f.diff ? diffBlock(f.diff) : null)));
    if (!run.files.length) parts.push(el('p', {class: 'empty'}, 'Nothing in your code needs changing for these rules.'));
    parts.push(el('p', {class: 'muted'}, `Dry run of rules ${run.hash}, ${new Date(run.createdAt).toLocaleString()}. Run the script from your repository root: node gapscan-codemod.mjs (add --write to apply).`));
  }
  $('#codemod').replaceChildren(...parts);
}
async function loadCodemod() {
  $('#codemod-download').href = `/v1/gapscans/${reportId}/codemod.mjs`;
  try {
    const plan = await api(`/v1/gapscans/${reportId}/codemod/rules`);
    const run = await api(`/v1/gapscans/${reportId}/codemod`).catch(() => null);
    renderCodemod(plan, run);
  } catch (error) { $('#codemod').replaceChildren(el('p', {class: 'error'}, error.message)); }
}
$('#codemod-run').addEventListener('click', async () => {
  const button = $('#codemod-run'), out = $('#codemod');
  button.disabled = true;
  try {
    const {events} = await api(`/v1/gapscans/${reportId}/codemod`, {method: 'POST'});
    const stream = new EventSource(events), done = () => { stream.close(); button.disabled = false; };
    stream.addEventListener('progress', e => out.replaceChildren(el('p', {class: 'muted'}, JSON.parse(e.data).body.message)));
    stream.addEventListener('warning', e => out.append(el('p', {class: 'muted'}, JSON.parse(e.data).body.message)));
    stream.addEventListener('failed', e => { done(); out.replaceChildren(el('p', {class: 'error'}, JSON.parse(e.data).body.message)); });
    stream.addEventListener('complete', () => { done(); loadCodemod(); });
  } catch (error) { button.disabled = false; out.replaceChildren(el('p', {class: 'error'}, error.message)); }
});

// ── Tabs: Report and Codemod; #codemod opens the second ──
const tabs = [...document.querySelectorAll('.page-tabs [role="tab"]')];
function showView(view, {focus = false} = {}) {
  if (view !== 'codemod') view = 'report';
  for (const tab of tabs) { const on = tab.dataset.view === view; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; if (on && focus) tab.focus(); }
  $('#view-report').hidden = view !== 'report'; $('#view-codemod').hidden = view !== 'codemod';
  history.replaceState(null, '', view === 'codemod' ? '#codemod' : location.pathname + location.search);
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
    if (step) { event.preventDefault(); showView(tabs[(i + step + tabs.length) % tabs.length].dataset.view, {focus: true}); }
  });
});
showView(location.hash.slice(1));
// Links to a component (from attention lists) open its card, showing it first if the filter hides it.
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#item-"]');
  if (!link) return;
  event.preventDefault();
  const itemId = decodeURIComponent(link.getAttribute('href').slice('#item-'.length)).replace(/\\(.)/g, '$1');
  let card = document.getElementById(`item-${itemId}`);
  if (!card) { $('#filter').value = 'all'; renderItems(); card = document.getElementById(`item-${itemId}`); }
  if (card) { card.open = true; card.scrollIntoView({behavior: 'smooth', block: 'start'}); card.querySelector('summary')?.focus({preventScroll: true}); }
});

async function load() {
  if (!reportId) { $('#headline').textContent = 'No report id in the link.'; return; }
  try {
    report = await api(`/v1/gapscans/${reportId}`);
    reference = await api(`/v1/library/${report.reference.id}`);
    const eds = await api(`/v1/extractions/${report.edsId}?include=full`);
    specimens = new Map(eds.specimens.map(s => [s.id, s]));
    [suggestions, aiEnabled] = await Promise.all([api(`/v1/gapscans/${reportId}/suggestions`).catch(() => ({})), aiStatus.then(a => a.enabled)]);
    $('#title').textContent = `Your system → ${reference.library} ${reference.version}`;
    api(`/v1/projects/${eds.projectId}`).then(project => setCrumbs([{label: 'Design systems', href: '/app/'}, {label: project.name, href: `/app/system.html?id=${report.edsId}`},
      {label: 'Migrate', href: `/app/migrate.html?id=${report.edsId}`}, {label: reference.library}])).catch(() => {});
    renderSummary(); renderItems(); loadCodemod();
  } catch (error) { $('#headline').textContent = error.message; }
}
$('#filter').addEventListener('change', renderItems);
$('#assumptions').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, body = Object.fromEntries(['rate', 'apps', 'engineers', 'qaPct'].map(n => [n, Number(form.elements[n].value)]));
  try { const result = await api(`/v1/gapscans/${reportId}/assumptions`, {method: 'PUT', body: JSON.stringify(body)}); report.assumptions = result.assumptions; report.totals = result.totals; renderSummary(); }
  catch (error) { $('#assume-note').textContent = error.message; }
});
load();
