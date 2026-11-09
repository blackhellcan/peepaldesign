// Documentation review, shared by the Documents page and the admin review: the six documents
// beside the selected one's sections, a "Needs approval" filter, drafts next to GapScan's
// original, approval, drafting with Claude, and Markdown downloads. Expects the page to define
// `id` (the extraction) and `plural`, and to contain #objects.
try { $('#reviewer').value = localStorage.getItem('gapscan-reviewer') || ''; } catch {}
$('#reviewer').addEventListener('change', () => { try { localStorage.setItem('gapscan-reviewer', $('#reviewer').value.trim()); } catch {} });
const PROVENANCE = {extracted: 'From your sources', inferred: 'Suggested by GapScan', drafted: 'Starting draft'};
const STATUS_WORDS = {present: 'Written', partial: 'Partly written', missing: 'Not written yet'};
const draftable = s => s.provenance !== 'extracted' || s.id.startsWith('component-');
// Facts read from your sources stand on their own; inferred and drafted text waits for a person.
const needsApproval = s => !s.approval && s.provenance !== 'extracted';
let aiEnabled = false, docs = [], docKind = null, docFilter = 'all', signedIn = null;

function sectionCard(object, s) {
  const base = `/v1/extractions/${id}/objects/${object.kind}/sections/${encodeURIComponent(s.id)}`;
  const note = el('span', {class: 'muted', 'aria-live': 'polite'});
  const update = updated => { docs = docs.map(o => o.kind === updated.kind ? updated : o); renderDocs(); };
  const approve = s.approval ? null : el('button', {type: 'button', class: needsApproval(s) ? 'primary' : ''}, s.draftedBy ? 'Approve this draft' : 'Approve');
  approve?.addEventListener('click', async () => {
    const by = signedIn ?? $('#reviewer').value.trim();
    if (!by) { $('#reviewer-row').hidden = false; $('#reviewer').focus(); note.textContent = 'Add your name or email first; it is recorded with the approval.'; return; }
    approve.disabled = true;
    try { update(await api(`${base}/approval`, {method: 'PUT', body: JSON.stringify({by})})); }
    catch (error) { approve.disabled = false; note.textContent = error.message; }
  });
  // Claude drafts on request only; the result replaces this text and still needs approving.
  const draft = aiEnabled && draftable(s) ? el('button', {type: 'button'}, s.draftedBy ? 'Redraft with Claude' : 'Draft with Claude') : null;
  draft?.addEventListener('click', async () => {
    draft.disabled = true;
    try { await runJob(`${base}/draft`, message => { note.textContent = message; }); update((await api(`/v1/extractions/${id}/objects`)).find(o => o.kind === object.kind)); }
    catch (error) { draft.disabled = false; note.textContent = error.message; }
  });
  const discard = s.draftedBy ? el('button', {type: 'button', class: 'quiet'}, 'Discard draft') : null;
  discard?.addEventListener('click', async () => {
    discard.disabled = true;
    try { update(await api(`${base}/draft`, {method: 'DELETE'})); } catch (error) { discard.disabled = false; note.textContent = error.message; }
  });

  const state = s.approval ? el('span', {class: 'pill ok'}, `Approved by ${s.approval.by}`)
    : s.stale ? el('span', {class: 'pill major'}, 'Changed since approval')
    : needsApproval(s) ? el('span', {class: 'pill minor'}, 'Needs approval') : null;
  const body = s.draftedBy?.original
    ? el('div', {class: 'compare'},
        el('div', {class: 'compare-col'}, el('div', {class: 'compare-label'}, 'Claude’s draft'), markdown(s.content)),
        el('details', {class: 'compare-col original', open: true},
          el('summary', {class: 'compare-label'}, 'GapScan’s original'), markdown(s.draftedBy.original)))
    : markdown(s.content);
  return el('article', {class: `doc-section${needsApproval(s) ? ' is-pending' : ''}`, id: `section-${object.kind}-${s.id}`},
    el('header', {class: 'doc-section-head'}, el('h3', {}, s.title),
      el('span', {class: 'row'}, el('span', {class: `pill ${s.status === 'present' ? 'ok' : ''}`}, STATUS_WORDS[s.status]),
        el('span', {class: 'muted fine-tag'}, s.draftedBy ? 'Drafted by Claude' : PROVENANCE[s.provenance]), state)),
    body,
    s.draftedBy?.openQuestions.length ? el('div', {class: 'questions'}, el('strong', {}, 'Decisions for your team'), el('ul', {}, s.draftedBy.openQuestions.map(q => el('li', {}, q)))) : null,
    s.draftedBy ? el('p', {class: 'muted fine'}, `Written by ${s.draftedBy.model} on ${new Date(s.draftedBy.at).toLocaleString()}${s.evidence.length ? `, citing ${plural(s.evidence.length, 'piece')} of evidence` : ''}. Check it before approving.`) : null,
    el('div', {class: 'row doc-actions'}, approve, draft, discard, note));
}

// Markdown of one document: every section, with the ones still waiting for approval marked.
function downloadMarkdown(object) {
  const text = [`# ${object.title}`, '', ...object.sections.flatMap(s => [`## ${s.title}${s.approval ? '' : ' (not yet approved)'}`, '', s.content.replace(/^#{1,2} /gm, '### '), ''])].join('\n');
  const link = el('a', {href: URL.createObjectURL(new Blob([text], {type: 'text/markdown'})), download: `${object.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`});
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
// With Claude on: draft every section of this document that isn't approved or drafted yet, one at a time.
function draftAllButton(object) {
  const todo = object.sections.filter(s => aiEnabled && draftable(s) && !s.approval && !s.draftedBy);
  if (!todo.length) return null;
  const button = el('button', {type: 'button', class: 'primary'}, `Draft ${plural(todo.length, 'section')} with Claude`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    for (const [i, s] of todo.entries()) {
      button.textContent = `Drafting ${i + 1} of ${todo.length}…`;
      try { await runJob(`/v1/extractions/${id}/objects/${object.kind}/sections/${encodeURIComponent(s.id)}/draft`); }
      catch (error) { button.textContent = error.message; button.disabled = false; break; }
    }
    docs = await api(`/v1/extractions/${id}/objects`); renderDocs();
  });
  return button;
}
function renderDocs() {
  if (!docs.length) return;
  const pending = docs.flatMap(o => o.sections.filter(needsApproval));
  $('#review-count').textContent = pending.length || '';
  const pct = Math.round(docs.reduce((sum, o) => sum + o.completeness, 0) / docs.length * 100);
  const setText = (selector, text) => { const node = document.querySelector(selector); if (node) node.textContent = text; };
  setText('#count-documentation', `${pct}%`);
  setText('#next-documentation', `${pct}% documented today across accessibility, guidelines, principles, tooling, content and brand.${pending.length ? ` ${plural(pending.length, 'section')} waiting for approval.` : ''}`);
  if (!docs.some(o => o.kind === docKind)) docKind = docs[0].kind;
  const visible = o => docFilter === 'all' ? o.sections : o.sections.filter(needsApproval);
  const nav = el('nav', {class: 'docs-nav', 'aria-label': 'Documents'}, el('ul', {class: 'plain'}, docs.map(o => {
    const p = Math.round(o.completeness * 100), waiting = o.sections.filter(needsApproval).length;
    return el('li', {}, el('button', {type: 'button', class: 'doc-link', 'aria-current': o.kind === docKind ? 'true' : null, onclick: () => { docKind = o.kind; renderDocs(); $('#objects').scrollIntoView({block: 'start'}); }},
      el('span', {class: 'doc-link-name'}, o.title),
      el('span', {class: 'meter', 'aria-hidden': 'true'}, el('i', {style: `width:${p}%`})),
      el('span', {class: 'muted doc-link-meta'}, `${p}%${waiting ? ` · ${waiting} to approve` : ''}`)));
  })));
  const object = docs.find(o => o.kind === docKind), sections = visible(object), p = Math.round(object.completeness * 100);
  const main = el('div', {class: 'docs-main'},
    el('div', {class: 'docs-main-head'}, el('div', {}, el('h3', {class: 'doc-title'}, object.title), el('span', {class: 'muted'}, `${p}% complete · ${plural(object.sections.length, 'section')}`)),
      el('div', {class: 'row'}, draftAllButton(object), el('button', {type: 'button', onclick: () => downloadMarkdown(object)}, 'Download (Markdown)'))),
    ...(sections.length ? sections.map(s => sectionCard(object, s))
      : [el('p', {class: 'empty'}, docFilter === 'review' ? 'Nothing here is waiting for approval.' : 'No sections.')]));
  $('#objects').replaceChildren(nav, main);
}
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  docFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  // Jump to the first document with something to approve.
  if (docFilter === 'review' && !docs.find(o => o.kind === docKind)?.sections.some(needsApproval)) docKind = docs.find(o => o.sections.some(needsApproval))?.kind ?? docKind;
  renderDocs();
}));
async function objects() {
  if (!id) return;
  try {
    const [ai, list, user] = await Promise.all([aiStatus, api(`/v1/extractions/${id}/objects`), whoami]);
    aiEnabled = ai.enabled; docs = list;
    // Signed in, approvals carry your account's email (the server records it); otherwise ask for a name once.
    signedIn = user?.email ?? null;
    $('#reviewer-row').hidden = Boolean(signedIn);
    renderDocs();
  } catch (error) { $('#objects').replaceChildren(el('p', {class: 'error'}, error.message)); }
}
objects();
