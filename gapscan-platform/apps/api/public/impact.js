// Application impact, shared by Migrate and the admin review: add the product's code (public GitHub
// repository or ZIP) as an application source, scan where components are used, show the result.
// Expects the page to define `id` (the extraction) and to contain #impact-form and #impact-result.
let projectOf = null;
function renderUsage(report) {
  const used = report.components.filter(c => c.usages).sort((a, b) => b.usages - a.usages), unused = report.components.filter(c => !c.usages);
  $('#impact-result').replaceChildren(
    el('p', {}, `${used.length} of ${report.components.length} components are used across ${report.filesScanned} files and ${report.screens} screens${report.filesSkipped ? ` (${report.filesSkipped} files skipped: tests, dependencies, docs or too large)` : ''}.`),
    el('div', {class: 'table-wrap'}, el('table', {}, el('tr', {}, el('th', {}, 'Component'), el('th', {}, 'Usages'), el('th', {}, 'Screens'), el('th', {}, 'Props passed'), el('th', {}, 'Example')),
      used.slice(0, 30).map(c => el('tr', {}, el('td', {}, c.component), el('td', {}, String(c.usages)), el('td', {}, String(c.screens.length)),
        el('td', {}, Object.entries(c.propUsages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p, n]) => `${p} ×${n}`).join(', ') || '—'),
        el('td', {}, c.examples[0] ? el('code', {}, `${c.examples[0].file}:${c.examples[0].line}`) : '—'))))),
    unused.length ? el('p', {class: 'muted'}, `Not used anywhere in the scanned code: ${unused.map(c => c.component).join(', ')}.`) : '');
}
async function impact() {
  if (!id) return;
  try { projectOf = (await api(`/v1/extractions/${id}?include=full`)).projectId; renderUsage(await api(`/v1/projects/${projectOf}/usage`)); } catch {}
}
$('#impact-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, out = $('#impact-result'), repo = form.elements.repo.value.trim(), zip = form.elements.zip.files[0];
  if (!repo && !zip) { out.replaceChildren(el('p', {class: 'error'}, 'Add a public GitHub link or a ZIP of your app.')); return; }
  out.replaceChildren(el('p', {class: 'muted'}, 'Adding your code…'));
  try {
    projectOf ??= (await api(`/v1/extractions/${id}?include=full`)).projectId;
    if (repo) await api(`/v1/projects/${projectOf}/sources`, {method: 'POST', body: JSON.stringify({kind: 'url', uri: repo, role: 'application'})});
    if (zip) {
      const buffer = new Uint8Array(await zip.arrayBuffer()); let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      await api(`/v1/projects/${projectOf}/sources`, {method: 'POST', body: JSON.stringify({kind: 'file', name: zip.name.replace(/[^\w .()@-]/g, '_'), base64: btoa(binary), role: 'application'})});
    }
    const {events} = await api(`/v1/projects/${projectOf}/usage`, {method: 'POST', body: JSON.stringify({edsId: id})});
    const stream = new EventSource(events);
    stream.addEventListener('progress', e => out.replaceChildren(el('p', {class: 'muted'}, JSON.parse(e.data).body.message)));
    stream.addEventListener('warning', e => out.append(el('p', {class: 'error'}, JSON.parse(e.data).body.message)));
    stream.addEventListener('failed', e => { stream.close(); out.replaceChildren(el('p', {class: 'error'}, JSON.parse(e.data).body.message)); });
    stream.addEventListener('complete', async () => { stream.close(); renderUsage(await api(`/v1/projects/${projectOf}/usage`)); });
    form.reset();
  } catch (error) { out.replaceChildren(el('p', {class: 'error'}, error.message)); }
});
impact();
