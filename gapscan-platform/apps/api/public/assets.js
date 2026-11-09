// Brand assets, shared by More tools and the admin review: pick a template, fill its fields, render,
// then preview and download with the checks it passed. Expects `id` and #asset-form, #asset-template,
// #asset-fields and #asset-result.
let templates = [];
const FIELD_LABELS = {address: 'Address', name: 'Name', role: 'Role', email: 'Email', phone: 'Phone', website: 'Website', title: 'Title', subtitle: 'Subtitle', points: 'Points (separate with ;)', body: 'Message', cta: 'Button label', url: 'Button link (https://…)'};
function assetFields() {
  const template = templates.find(t => t.id === $('#asset-template').value);
  // A letter or newsletter body gets a multi-line box; everything else is one line.
  $('#asset-fields').replaceChildren(...(template?.fields ?? []).map(f => el('label', {}, FIELD_LABELS[f] || f,
    f === 'body' ? el('textarea', {name: `field-${f}`, maxlength: '4000', rows: '5'}) : el('input', {type: 'text', name: `field-${f}`, maxlength: f === 'points' ? '1200' : '160'}))));
}
async function assets() {
  if (!id) return;
  templates = await api('/v1/templates');
  $('#asset-template').replaceChildren(...templates.map(t => el('option', {value: t.id}, t.label)));
  assetFields();
}
$('#asset-template').addEventListener('change', assetFields);
$('#asset-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, data = {};
  for (const input of form.querySelectorAll('[name^="field-"]')) if (input.value.trim()) data[input.name.slice(6)] = input.value.trim();
  const result = $('#asset-result');
  result.replaceChildren(el('p', {class: 'muted'}, 'Rendering…'));
  try {
    const {jobId, events} = await api(`/v1/extractions/${id}/assets`, {method: 'POST', body: JSON.stringify({template: form.elements.template.value, brandName: form.elements.brandName.value, data})});
    const stream = new EventSource(events);
    stream.addEventListener('failed', e => { stream.close(); result.replaceChildren(el('p', {class: 'error'}, JSON.parse(e.data).body.message)); });
    stream.addEventListener('complete', async () => {
      stream.close();
      const manifest = await api(`/v1/assets/${jobId}`), url = `/v1/assets/${jobId}/file`;
      result.replaceChildren(
        manifest.contentType === 'image/png' ? el('img', {src: url, alt: `${manifest.template.label} preview`, style: 'max-width:100%;border:1px solid var(--line);border-radius:8px'})
          : manifest.contentType.startsWith('text/html') ? el('iframe', {src: url, sandbox: '', title: 'Email preview', style: 'width:100%;height:520px;border:1px solid var(--line);border-radius:8px;background:#fff'})
          : el('p', {}, el('a', {href: `${url}?download=1`}, `Download ${manifest.file}`)),
        el('ul', {class: 'plain'}, manifest.checks.map(c => el('li', {class: 'source'}, el('span', {}, c.message), el('span', {class: `pill ${c.pass ? 'ok' : 'minor'}`}, c.pass ? 'Pass' : 'Check')))),
        el('a', {class: 'button', href: `${url}?download=1`}, 'Download'));
    });
  } catch (error) { result.replaceChildren(el('p', {class: 'error'}, error.message)); }
});
assets();
