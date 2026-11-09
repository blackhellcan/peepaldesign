// Migrate: the closest design system first, then your reports, then any other system to compare with.
const id = new URLSearchParams(location.search).get('id');
const date = iso => new Date(iso).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
const sentence = text => text.charAt(0).toUpperCase() + text.slice(1);

// Runs a comparison and opens the report; progress shows in the given element.
async function compare(referenceId, status, buttons) {
  buttons.forEach(b => { b.disabled = true; });
  status.hidden = false;
  try {
    const result = await new Promise(async (resolve, reject) => {
      try {
        const {events} = await api('/v1/gapscans', {method: 'POST', body: JSON.stringify({edsId: id, referenceId})});
        const stream = new EventSource(events);
        stream.addEventListener('progress', e => { status.querySelector('[aria-live]').textContent = JSON.parse(e.data).body.message; });
        stream.addEventListener('complete', e => { stream.close(); resolve(JSON.parse(e.data).body); });
        stream.addEventListener('failed', e => { stream.close(); reject(new Error(JSON.parse(e.data).body.message)); });
      } catch (error) { reject(error); }
    });
    location.href = `/app/gapscan.html?id=${result.resultId}`;
  } catch (error) {
    buttons.forEach(b => { b.disabled = false; });
    status.hidden = true; $('#best-error').textContent = error.message;
  }
}

async function load() {
  if (!id) { $('#lead').textContent = 'No design system in the link.'; return; }
  let ranked, reports;
  try {
    const [{project}, r, list] = await Promise.all([systemContext(id, 'Migrate'), api(`/v1/extractions/${id}/recommendations`), api(`/v1/extractions/${id}/gapscans`)]);
    ranked = r; reports = list;
    $('#lead').textContent = `Find the design system closest to ${project.name}, and see what moving to it takes, component by component.`;
  } catch (error) { $('#best-title').textContent = 'Something went wrong'; $('#best-error').textContent = error.message; return; }
  const reportFor = referenceId => reports.find(r => r.referenceId === referenceId);
  const names = new Map(ranked.map(r => [r.id, `${r.library} ${r.version}`]));

  const best = ranked[0];
  if (!best) { $('#best-title').textContent = 'No reference systems are available'; return; }
  $('#best-title').textContent = `${best.library} ${best.version}`;
  $('#best-reason').textContent = `Your closest match: ${best.reason.charAt(0).toLowerCase()}${best.reason.slice(1)}. Built for ${best.framework}.`;
  if (best.homepage) { $('#best-site').hidden = false; $('#best-site').href = best.homepage; }
  const existing = reportFor(best.id);
  if (existing) { $('#best-open').hidden = false; $('#best-open').href = `/app/gapscan.html?id=${existing.id}`; $('#best-open').classList.add('primary'); }
  else { $('#best-go').hidden = false; $('#best-go').addEventListener('click', () => compare(best.id, $('#best-progress'), [$('#best-go')])); }

  $('#reports-card').hidden = !reports.length;
  $('#reports').replaceChildren(...reports.map(r => {
    const totals = r.summary?.totals, hours = totals?.available ? `${Math.round(totals.low)}–${Math.round(totals.high)} hours of work` : 'Needs a review before it can be estimated';
    return el('li', {class: 'source'}, el('a', {href: `/app/gapscan.html?id=${r.id}`}, names.get(r.referenceId) ?? r.referenceId), el('span', {class: 'muted'}, `${hours} · ${date(r.updatedAt)}`));
  }));

  $('#recs').replaceChildren(...ranked.slice(1).map(r => {
    const report = reportFor(r.id), status = el('span', {class: 'progress-inline', hidden: true}, el('span', {class: 'kind-busy', 'aria-hidden': 'true'}), el('span', {'aria-live': 'polite'}));
    const action = report ? el('a', {class: 'button', href: `/app/gapscan.html?id=${report.id}`}, 'Open report') : el('button', {type: 'button'}, 'Compare');
    if (!report) action.addEventListener('click', () => compare(r.id, status, [...document.querySelectorAll('#recs button'), $('#best-go')]));
    return el('div', {class: 'rec'}, el('div', {}, el('strong', {}, `${r.library} ${r.version}`), el('div', {class: 'muted'}, `${sentence(r.reason)} · ${r.framework}`)), el('div', {class: 'row'}, status, action));
  }));
}
load();
