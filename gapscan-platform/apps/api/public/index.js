// Home (no ?project): one way to start, then your design systems. With ?project: its sources, extractions and people.
const projectParam = new URLSearchParams(location.search).get('project');
let projectId = null, sources = [], activeJob = null, stream = null;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const when = iso => new Date(iso).toLocaleString(undefined, {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'});

// ── Website readers: GapScan's browser, or Scrapling when the server has it ──
let readers = [{id: 'default', label: 'GapScan’s browser', description: '', available: true}];
function fillReaders(select, note) {
  select.replaceChildren(...readers.map(r => el('option', {value: r.id, disabled: !r.available}, r.available ? r.label : `${r.label} (not available)`)));
  const explain = () => { const r = readers.find(x => x.id === select.value); note.textContent = r?.description ?? ''; };
  const off = readers.find(r => !r.available);
  note.title = off?.reason ?? '';
  select.addEventListener('change', explain); explain();
}
const readerBody = select => select.value === 'scrapling' ? {reader: 'scrapling'} : {};
api('/v1/readers').then(list => { readers = list; fillReaders($('#start-reader'), $('#start-reader-note')); fillReaders($('#url-reader'), $('#url-reader-note')); }).catch(() => {});

// ── Home: one start box, then your design systems ──
// Each card shows the system's own colours as a strip, read from the saved scales.
function projectCard(p) {
  const strip = el('span', {class: 'swatch-strip', 'aria-hidden': 'true'});
  if (p.latestExtraction) api(`/v1/extractions/${p.latestExtraction.id}/scales`).then(scales => {
    const hexes = [...new Set([...scales.roles.map(r => r.hex), ...scales.colors.map(c => c.hex)])].slice(0, 6);
    strip.replaceChildren(...hexes.map(hex => el('i', {style: `background:${hex}`})));
  }).catch(() => {});
  const href = p.latestExtraction ? `/app/system.html?id=${p.latestExtraction.id}` : `/app/?project=${p.id}`;
  return el('a', {class: 'project-card system-card', href}, strip,
    el('span', {class: 'project-name'}, p.name),
    el('span', {class: 'muted project-meta'}, p.latestExtraction ? `Updated ${new Date(p.latestExtraction.createdAt).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})}` : 'Not read yet'));
}
async function showHome() {
  setCrumbs([]);
  $('#home').hidden = false;
  try {
    const projects = await api('/v1/projects');
    $('#mine').hidden = !projects.length;
    $('#projects').replaceChildren(...projects.map(projectCard));
  } catch (error) { $('#mine').hidden = false; $('#projects').replaceChildren(el('p', {class: 'error'}, error.message)); }
}

// Files chosen or dropped on the start box wait here until Get started.
const startFiles = [];
function renderStartFiles() {
  $('#start-files-list').replaceChildren(...startFiles.map((file, i) => el('li', {class: 'start-file'}, el('span', {}, file.name), el('span', {class: 'muted'}, size(file.size)),
    el('button', {type: 'button', class: 'quiet', 'aria-label': `Remove ${file.name}`, onclick: () => { startFiles.splice(i, 1); renderStartFiles(); }}, 'Remove'))));
}
function takeFiles(files) {
  for (const file of files) {
    if (file.size > MAX_BYTES) { $('#start-error').textContent = `${file.name} is ${size(file.size)}; the limit is 40 MB.`; continue; }
    startFiles.push(file);
  }
  renderStartFiles();
}
$('#start-url').addEventListener('input', () => {
  const figmaOff = isFigma($('#start-url').value.trim()) && !figmaConnected;
  $('#start-hint').textContent = figmaOff ? FIGMA_OFF : 'You can also drop files anywhere on this box: brand guides, PDFs, token files or screenshots.';
  $('#start-hint').classList.toggle('warn', figmaOff);
});
$('#start-files').addEventListener('change', () => { takeFiles([...$('#start-files').files]); $('#start-files').value = ''; });
const box = $('#start-box');
for (const type of ['dragenter', 'dragover']) box.addEventListener(type, event => { event.preventDefault(); box.classList.add('is-over'); });
for (const type of ['dragleave', 'dragend']) box.addEventListener(type, () => box.classList.remove('is-over'));
box.addEventListener('drop', event => { event.preventDefault(); box.classList.remove('is-over'); takeFiles([...event.dataTransfer.files]); });

// A name people will recognise: the site's address, or the first file's name.
function nameFor(uri, files) {
  if (uri) { try { return new URL(uri).hostname.replace(/^www\./, ''); } catch {} }
  return files[0]?.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') || 'My design system';
}
$('#start-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#start-error').textContent = '';
  const typed = $('#start-url').value.trim(), uri = typed ? withScheme(typed) : null;
  if (!uri && !startFiles.length) { $('#start-error').textContent = 'Paste a link or choose files to start.'; $('#start-url').focus(); return; }
  if (uri) { try { new URL(uri); } catch { $('#start-error').textContent = 'That doesn’t look like a web address.'; return; } }
  // A Figma link this GapScan can't read: the hint under the box already says why, so create nothing.
  if (uri && isFigma(uri) && !figmaConnected && !startFiles.length) { $('#start-url').focus(); return; }
  $('#start-go').disabled = true; $('#start-go').textContent = 'Starting…';
  let project;
  try {
    project = await api('/v1/projects', {method: 'POST', body: JSON.stringify({name: nameFor(uri, startFiles)})});
    if (uri) await api(`/v1/projects/${project.id}/sources`, {method: 'POST', body: JSON.stringify({kind: 'url', uri, consent: true, ...readerBody($('#start-reader'))})});
    for (const file of startFiles) await api(`/v1/projects/${project.id}/sources`, {method: 'POST', body: JSON.stringify(await fileBody(file))});
    const {events} = await api(`/v1/projects/${project.id}/extractions`, {method: 'POST', body: JSON.stringify({})});
    followReading(events, project.id);
  } catch (error) {
    $('#start-go').disabled = false; $('#start-go').textContent = 'Get started';
    $('#start-error').replaceChildren(error.message, ...(project ? [' ', el('a', {href: `/app/?project=${project.id}`}, 'Check the sources')] : []));
  }
});
function followReading(events, id) {
  $('#reading').hidden = false; $('#start-form').hidden = true;
  $('#reading').scrollIntoView({behavior: 'smooth', block: 'start'});
  renderSteps('collect', 'Starting…', 0, 0, $('#home-steps'));
  const stream = new EventSource(events), warnings = [];
  stream.addEventListener('progress', e => { const {body} = JSON.parse(e.data); renderSteps(body.stage, body.message, body.done, body.total, $('#home-steps')); });
  stream.addEventListener('warning', e => warnings.push(JSON.parse(e.data).body.message));
  stream.addEventListener('complete', e => { stream.close(); renderSteps('done', 'Done.', 0, 0, $('#home-steps')); location.href = `/app/system.html?id=${JSON.parse(e.data).body.resultId}`; });
  stream.addEventListener('failed', e => {
    stream.close();
    $('#reading-failed').hidden = false;
    $('#reading-message').replaceChildren(JSON.parse(e.data).body.message, ...(warnings.length ? [el('ul', {class: 'reasons'}, warnings.map(w => el('li', {}, w)))] : []));
    $('#reading-open').href = `/app/?project=${id}`;
  });
}

// ── One project ──
async function openProject(id) {
  const project = await api(`/v1/projects/${id}`);
  projectId = project.id; sources = project.sources.filter(s => s.role !== 'application');
  $('#project-view').hidden = false;
  showName(project.name);
  const extractions = [...project.extractions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#project-summary').textContent = `${plural(sources.length, 'source')} · ${extractions.length ? `last read ${when(extractions[0].createdAt)}` : 'not read yet'}`;
  $('#versions').replaceChildren(...(extractions.length ? extractions.map((e, i) => el('li', {class: 'source'},
    el('a', {href: `/app/system.html?id=${e.id}`}, `Version ${e.version}`), el('span', {class: 'muted'}, `${when(e.createdAt)}${i === 0 ? ' · latest' : ''}`)))
    : [el('li', {class: 'empty'}, 'Not read yet. Add sources below, then read them.')]));
  $('#run').textContent = extractions.length ? 'Update my design system' : 'Read my design system';
  renderSources();
  // Sharing needs accounts: visitors have a private space, so there is no People card for them.
  if (project.role && !(await me).anonymous) {
    $('#project-card').hidden = false;
    renderMembers(await api(`/v1/projects/${id}/members`), project.role);
    $('#invite').hidden = project.role !== 'owner';
  }
}
function showName(name) {
  $('#project-title').textContent = name;
  setCrumbs([{label: 'Design systems', href: '/app/'}, {label: name}]);
}
$('#rename').addEventListener('click', () => {
  $('#rename-input').value = $('#project-title').textContent;
  $('#title-show').hidden = true; $('#rename-form').hidden = false;
  $('#rename-input').select();
});
const closeRename = () => { $('#title-show').hidden = false; $('#rename-form').hidden = true; $('#rename-error').textContent = ''; };
$('#rename-cancel').addEventListener('click', closeRename);
$('#rename-input').addEventListener('keydown', event => { if (event.key === 'Escape') closeRename(); });
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { showName((await api(`/v1/projects/${projectId}`, {method: 'PATCH', body: JSON.stringify({name: $('#rename-input').value})})).name); closeRename(); $('#rename').focus(); }
  catch (error) { $('#rename-error').textContent = error.message; }
});

// ── Sources ──
function showError(message) { $('#source-error').textContent = message || ''; }
const KINDS = {url: ['Website', 'web'], figma: ['Figma file', 'figma'], pdf: ['PDF', 'doc'], pptx: ['PowerPoint', 'doc'], docx: ['Word', 'doc'],
  markdown: ['Markdown', 'doc'], code: ['Code', 'code'], zip: ['ZIP archive', 'zip'], image: ['Image', 'image']};
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
const MAX_BYTES = 40 * 1048576;
// Websites read before are saved: say what will be reused and what is left to read.
const savedNotes = new Map();
function savedNote(saved) {
  if (!saved) return null;
  const date = new Date(saved.startedAt).toLocaleDateString();
  if (saved.stale) return `Saved on ${date}, but older than the reuse limit: it will be read again.`;
  return `Saved: ${saved.pages} page${saved.pages === 1 ? '' : 's'} read on ${date}` + (saved.full ? '. The next extraction reuses them without reading the site again.'
    : saved.queued ? `. The next extraction reuses them and continues with up to ${Math.min(8, saved.limit - saved.pages)} more of the ${saved.queued} pages not read yet.` : '. The next extraction reuses them.');
}
async function loadSavedNote(source) {
  if (source.kind !== 'url' || savedNotes.has(source.uri)) return;
  savedNotes.set(source.uri, null);
  try { const {saved} = await api(`/v1/saved-sites?url=${encodeURIComponent(source.uri)}`); savedNotes.set(source.uri, savedNote(saved)); renderSources(); } catch {}
}
// Uploads in flight and ones that failed, shown in the list until they finish or are dismissed.
const pending = [];
function sourceCard(s) {
  const [kindLabel, icon] = KINDS[s.kind] ?? [s.kind, 'doc'];
  const title = s.kind === 'url' ? new URL(s.uri).host + new URL(s.uri).pathname.replace(/\/$/, '') : s.label || s.uri.replace(/^inline:/, '');
  const detail = s.kind === 'figma' ? s.uri : s.kind === 'url' ? `${s.uri}${s.reader === 'scrapling' ? ' · read with Scrapling' : ''}` : `${kindLabel} · ${size(s.bytes)}`;
  return el('li', {class: 'source-card'}, el('span', {class: `kind-icon kind-${icon}`, 'aria-hidden': 'true'}),
    el('span', {class: 'source-text'}, el('span', {class: 'source-title', title: s.label || s.uri}, title), el('span', {class: 'muted source-detail'}, detail),
      savedNotes.get(s.uri) ? el('span', {class: 'muted saved'}, savedNotes.get(s.uri)) : null),
    el('span', {class: 'pill'}, kindLabel));
}
function pendingCard(item) {
  return el('li', {class: `source-card ${item.error ? 'is-error' : 'is-busy'}`}, el('span', {class: `kind-icon ${item.error ? 'kind-error' : 'kind-busy'}`, 'aria-hidden': 'true'}),
    el('span', {class: 'source-text'}, el('span', {class: 'source-title'}, item.name), el('span', {class: item.error ? 'error source-detail' : 'muted source-detail'}, item.error || 'Adding…')),
    item.error ? el('button', {type: 'button', class: 'quiet', 'aria-label': `Dismiss ${item.name}`, onclick: () => { pending.splice(pending.indexOf(item), 1); renderSources(); }}, 'Dismiss') : null);
}
function renderSources() {
  $('#source-list').replaceChildren(...sources.map(sourceCard), ...pending.map(pendingCard));
  $('#source-count').textContent = sources.length ? plural(sources.length, 'source') : '';
  const busy = pending.some(p => !p.error);
  $('#run').disabled = !sources.length || !!activeJob || busy;
  $('#extract-ready').textContent = busy ? 'Waiting for sources to finish adding…' : sources.length
    ? `Ready to read ${plural(sources.length, 'source')}. Websites take longest: each page is rendered at three widths.`
    : 'Add at least one source to extract.';
  $('#refresh-row').hidden = ![...savedNotes.values()].some(Boolean);
  sources.forEach(loadSavedNote);
}
// Adds one source, showing it as "Adding…" until the server has it; a failure stays in the list with its reason.
async function addSource(body, name) {
  showError('');
  const item = {name}; pending.push(item); renderSources();
  try {
    sources.push(await api(`/v1/projects/${projectId}/sources`, {method: 'POST', body: JSON.stringify(body)}));
    pending.splice(pending.indexOf(item), 1);
    renderSources();
    return true;
  } catch (error) { item.error = error.message; renderSources(); return false; }
}
async function fileBody(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = ''; for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return {kind: 'file', name: file.name.replace(/[^\w .()@-]/g, '_'), base64: btoa(binary)};
}
async function addFiles(files) {
  for (const file of files) {
    const name = file.name.replace(/[^\w .()@-]/g, '_');
    if (file.size > MAX_BYTES) { pending.push({name, error: `${size(file.size)} is over the 40 MB limit.`}); renderSources(); continue; }
    await addSource(await fileBody(file), name);
  }
}
$('#files').addEventListener('change', async () => { const files = [...$('#files').files]; $('#files').value = ''; await addFiles(files); });
const zone = $('#dropzone');
for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('is-over'); });
for (const type of ['dragleave', 'dragend']) zone.addEventListener(type, () => zone.classList.remove('is-over'));
zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('is-over'); addFiles([...event.dataTransfer.files]); });
// A file dropped beside the zone would otherwise open in the tab and lose the page.
addEventListener('dragover', event => event.preventDefault());
addEventListener('drop', event => event.preventDefault());

const withScheme = uri => /^[a-z]+:\/\//i.test(uri) ? uri : `https://${uri}`;   // "acme.com" means the site
let figmaConnected = true;
api('/v1/figma').then(f => { figmaConnected = f.connected; }).catch(() => {});
const FIGMA_OFF = 'Figma isn’t connected on this GapScan, so Figma files can’t be read yet. Export the styles as CSS or token JSON, or use the live site’s link instead.';
const isFigma = uri => { try { return /(^|\.)figma\.com$/.test(new URL(withScheme(uri)).hostname); } catch { return false; } };
$('#url').addEventListener('input', () => {
  $('#url-hint').textContent = isFigma($('#url').value.trim()) ? (figmaConnected ? 'Figma file: variables, styles and components are read through the Figma API.' : FIGMA_OFF)
    : 'Websites are rendered in a sandboxed browser at desktop, tablet and phone widths, plus dark mode.';
});
$('#link-form').addEventListener('submit', async event => {
  event.preventDefault();
  const typed = $('#url').value.trim();
  if (!typed) return $('#url').focus();
  const uri = withScheme(typed);
  if (await addSource({kind: 'url', uri, consent: true, ...readerBody($('#url-reader'))}, uri)) { $('#url').value = ''; $('#url').dispatchEvent(new Event('input')); }
});
$('#add-code').addEventListener('click', async () => {
  const content = $('#code').value, name = $('#code-name').value.trim() || 'styles.css';
  if (!content.trim()) return $('#code').focus();
  if (await addSource({kind: 'code', name, content}, name)) { $('#code').value = ''; $('#paste').open = false; }
});

// ── Extract: named steps from the job's progress events, the raw log behind "Details" ──
const STEPS = [['collect', 'Reading sources'], ['parse', 'Finding components'], ['normalize', 'Measuring tokens and scales'], ['audit', 'Checking for issues'], ['done', 'Opening your review']];
let stepState = {};
function renderSteps(active, detail, done = 0, total = 0, target = $('#steps')) {
  const reached = STEPS.findIndex(([id]) => id === active);
  target.replaceChildren(...STEPS.map(([id, label], i) => {
    const state = i < reached ? 'done' : i === reached ? 'active' : 'todo';
    return el('li', {class: `step is-${state}`, ...(state === 'active' ? {'aria-current': 'step'} : {})},
      el('span', {class: 'step-dot', 'aria-hidden': 'true'}),
      el('span', {class: 'step-text'}, el('span', {class: 'step-label'}, label, id === 'collect' && total ? ` (${Math.min(done, total)} of ${total})` : ''),
        state === 'active' && detail ? el('span', {class: 'muted step-detail'}, detail) : null,
        state === 'active' && id === 'collect' && total ? el('span', {class: 'bar-track'}, el('i', {style: `transform:scaleX(${(done / total).toFixed(3)})`})) : null));
  }));
}
function log(line) { const box = $('#log'); $('#log-details').hidden = false; box.textContent += line + '\n'; box.scrollTop = box.scrollHeight; }
function setMode(mode) {
  $('#extract-idle').hidden = mode !== 'idle';
  $('#extract-running').hidden = mode !== 'running';
  $('#extract-failed').hidden = mode !== 'failed';
}
async function runExtraction() {
  $('#log').textContent = ''; $('#status').textContent = ''; stepState = {warnings: 0};
  try {
    const {jobId, events} = await api(`/v1/projects/${projectId}/extractions`, {method: 'POST', body: JSON.stringify({refresh: $('#refresh').checked})});
    activeJob = jobId; renderSources(); setMode('running'); renderSteps('collect', 'Starting…');
    $('#extract-panel').scrollIntoView({behavior: 'smooth', block: 'nearest'});
    stream = new EventSource(events);
    stream.addEventListener('progress', e => { const {body} = JSON.parse(e.data); log(body.message); renderSteps(body.stage, body.message, body.done, body.total); });
    stream.addEventListener('warning', e => { const message = JSON.parse(e.data).body.message; log('⚠ ' + message); stepState.warnings++; (stepState.reasons ??= []).push(message); $('#status').textContent = `${plural(stepState.warnings, 'warning')}: see Details.`; });
    const finish = () => { stream.close(); activeJob = null; renderSources(); };
    stream.addEventListener('complete', e => { finish(); renderSteps('done', 'Done.'); location.href = `/app/system.html?id=${JSON.parse(e.data).body.resultId}`; });
    stream.addEventListener('failed', e => { finish(); fail('The extraction stopped', JSON.parse(e.data).body.message, stepState.reasons ?? []); });
    stream.addEventListener('cancelled', () => { finish(); setMode('idle'); $('#extract-ready').textContent = 'Extraction cancelled. Pages already read from websites are kept for next time.'; });
  } catch (error) { activeJob = null; renderSources(); fail('The extraction couldn’t start', error.message); }
}
function fail(title, message, reasons = []) {
  setMode('failed'); $('#failed-title').textContent = title;
  $('#failed-message').replaceChildren(message, ...(reasons.length ? [el('ul', {class: 'reasons'}, reasons.map(r => el('li', {}, r)))] : []));
}
$('#run').addEventListener('click', runExtraction);
$('#retry').addEventListener('click', runExtraction);
$('#cancel').addEventListener('click', () => {
  if (!activeJob) return;
  $('#cancel').disabled = true; $('#status').textContent = 'Cancelling…';
  api(`/v1/jobs/${activeJob}`, {method: 'DELETE'}).catch(error => { $('#status').textContent = error.message; }).finally(() => { $('#cancel').disabled = false; });
});

// ── People (accounts on) ──
function renderMembers(members, role) {
  const owners = members.filter(m => m.role === 'owner').length;
  $('#members').replaceChildren(...members.map(m => el('li', {class: 'source'}, el('span', {}, m.email), el('span', {class: 'pill'}, m.role),
    role === 'owner' && !(m.role === 'owner' && owners === 1) ? el('button', {type: 'button', onclick: async () => {
      try { renderMembers(await api(`/v1/projects/${projectId}/members/${m.userId}`, {method: 'DELETE'}), role); } catch (error) { $('#invite-status').textContent = error.message; }
    }}, 'Remove') : null)));
}
$('#invite').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    renderMembers(await api(`/v1/projects/${projectId}/members`, {method: 'POST', body: JSON.stringify({email: $('#invite-email').value, role: $('#invite-role').value})}), 'owner');
    $('#invite-status').textContent = `Invited ${$('#invite-email').value}. They'll get an email.`; $('#invite-email').value = '';
  } catch (error) { $('#invite-status').textContent = error.message; }
});

// Wait for the sign-in check so a signed-out visitor goes straight to the sign-in page.
whoami.then(() => projectParam ? openProject(projectParam).catch(error => {
  setCrumbs([{label: 'Design systems', href: '/app/'}, {label: 'Not found'}]);
  $('#project-view').hidden = false; $('#project-title').textContent = 'Project not found'; $('#rename').hidden = true;
  $('#project-summary').textContent = `${error.message} It may have been removed, or you may not be a member.`;
  document.querySelectorAll('#project-view section').forEach(s => { s.hidden = true; });
}) : showHome());
