// Documents: the six documents of a complete design system, written whole by Claude from the
// extraction (when AI writing is on), read here like documents, with what's missing highlighted.
const id = new URLSearchParams(location.search).get('id');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const date = iso => new Date(iso).toLocaleDateString(undefined, {day: 'numeric', month: 'long', year: 'numeric'});
let docs = [], current = null, aiOn = false, writing = false;

const written = s => Boolean(s.draftedBy?.missing);                 // written whole by AI
const missingOf = s => s.draftedBy?.missing ?? [];
const gapsIn = doc => doc.sections.reduce((n, s) => n + missingOf(s).length, 0);

function status(kind, ...content) {
  $('#gen-status').hidden = !content.length;
  $('#gen-status').className = `notice gen-status ${kind}`;
  $('#gen-status').replaceChildren(...content);
}

function sectionView(s) {
  const missing = missingOf(s);
  return el('article', {class: 'doc-read'}, el('h3', {}, s.title),
    markdown(s.content),
    missing.length ? el('aside', {class: 'missing-box'}, el('strong', {}, 'Missing'), el('ul', {}, missing.map(m => el('li', {}, m)))) : null,
    !written(s) && s.status === 'missing' && s.provenance !== 'extracted' ? el('p', {class: 'muted fine'}, 'Starting point from GapScan; not written from your system yet.') : null);
}
function downloadMarkdown(doc) {
  const text = [`# ${doc.title}`, '', ...doc.sections.flatMap(s => [`## ${s.title}`, '', s.content.replace(/^#{1,2} /gm, '### '), '', ...(missingOf(s).length ? [`> **Missing:** ${missingOf(s).join('; ')}`, ''] : [])])].join('\n');
  const link = el('a', {href: URL.createObjectURL(new Blob([text], {type: 'text/markdown'})), download: `${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`});
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function render() {
  if (!docs.length) return;
  current ??= docs[0].kind;
  const doc = docs.find(d => d.kind === current), gaps = gapsIn(doc);
  const nav = el('nav', {class: 'docs-nav', 'aria-label': 'Documents'}, el('ul', {class: 'plain'}, docs.map(d => {
    const n = gapsIn(d), done = d.sections.some(written);
    return el('li', {}, el('button', {type: 'button', class: 'doc-link', 'aria-current': d.kind === current ? 'true' : null, onclick: () => { current = d.kind; render(); scrollTo({top: 0}); }},
      el('span', {class: 'doc-link-name'}, d.title),
      el('span', {class: 'muted doc-link-meta'}, done ? (n ? `${plural(n, 'thing')} missing` : 'Complete') : 'Not written yet')));
  })));
  const rewrite = aiOn && !writing ? el('button', {type: 'button', onclick: () => generate([doc.kind])}, doc.sections.some(written) ? 'Rewrite this document' : 'Write this document') : null;
  const main = el('div', {class: 'docs-main doc-reader'},
    el('div', {class: 'docs-main-head'}, el('div', {}, el('h2', {class: 'doc-title'}, doc.title),
      el('span', {class: 'muted'}, `${plural(doc.sections.length, 'section')}${gaps ? ` · ${plural(gaps, 'thing')} missing, highlighted below` : ''}`)),
      el('div', {class: 'row'}, rewrite, el('button', {type: 'button', onclick: () => downloadMarkdown(doc)}, 'Download (Markdown)'))),
    ...doc.sections.map(sectionView));
  $('#reader').replaceChildren(nav, main);
}

function summarise() {
  const all = docs.flatMap(d => d.sections), done = all.filter(written);
  if (writing) return;
  if (!aiOn) return status('info', 'AI writing isn’t turned on for this GapScan, so these are GapScan’s starting points from your design system. Turn it on to have every document written in full.');
  if (!done.length) return status('', '');
  const at = done.map(s => s.draftedBy.at).sort().at(-1), gaps = done.reduce((n, s) => n + missingOf(s).length, 0);
  status('ok', `Written with AI from your design system on ${date(at)}.${gaps ? ` ${plural(gaps, 'thing')} your system doesn’t establish yet ${gaps === 1 ? 'is' : 'are'} highlighted as missing.` : ''}`);
}

async function load() {
  docs = await api(`/v1/extractions/${id}/objects`);
  $('#generate').hidden = !aiOn;
  $('#generate').textContent = docs.some(d => d.sections.some(written)) ? 'Rewrite all with AI' : 'Write with AI';
  render(); summarise();
}

async function generate(kinds) {
  if (writing) return;
  writing = true; $('#generate').disabled = true; render();
  status('working', el('span', {class: 'kind-busy', 'aria-hidden': 'true'}), el('span', {id: 'gen-message'}, 'Starting…'));
  try {
    await runJob(`/v1/extractions/${id}/documents`, message => { const m = $('#gen-message'); if (m) m.textContent = message; }, kinds ? {kinds} : {});
    writing = false; await load();
  } catch (error) {
    writing = false; $('#generate').disabled = false; render();
    status('error', `The documents couldn’t be written: ${error.message}`);
  }
  $('#generate').disabled = false;
}
$('#generate').addEventListener('click', () => generate());

if (!id) $('#lead').textContent = 'No design system in the link.';
else {
  $('#to-pdf').href = `/app/export.html?id=${id}`;
  systemContext(id, 'Documents').catch(error => { $('#lead').textContent = error.message; });
  (async () => {
    aiOn = (await aiStatus).enabled;
    try {
      await load();
      // First visit with AI on and nothing written yet: write everything without waiting to be asked.
      if (aiOn && !docs.some(d => d.sections.some(written))) generate();
    } catch (error) { $('#reader').replaceChildren(el('p', {class: 'error'}, error.message)); }
  })();
}
