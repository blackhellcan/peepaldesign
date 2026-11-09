// Export: Figma, a PDF book, or tokens for code. One action each.
const id = new URLSearchParams(location.search).get('id');
const codeHref = () => `/v1/extractions/${id}/export?format=${document.querySelector('input[name="format"]:checked').value}`;
document.querySelectorAll('input[name="format"]').forEach(radio => radio.addEventListener('change', () => { $('#code-download').href = codeHref(); }));

async function load() {
  if (!id) { $('#lead').textContent = 'No design system in the link.'; return; }
  try {
    const {project} = await systemContext(id, 'Export');
    $('#lead').textContent = `Take ${project.name} where you work.`;
  } catch (error) { $('#lead').textContent = error.message; return; }
  $('#figma-download').href = `/v1/extractions/${id}/figma-export.json`;
  $('#code-download').href = codeHref();
  api(`/v1/extractions/${id}/objects`).then(list => {
    const written = list.flatMap(o => o.sections).filter(s => s.approval || s.draftedBy).length;
    $('#pdf-docs').replaceChildren(written ? `Includes ${written} written documentation section${written === 1 ? '' : 's'}. ` : 'No documents written yet. ',
      el('a', {href: `/app/documents.html?id=${id}`}, written ? 'See the documents' : 'Write the documents first'));
  }).catch(() => {});
}
$('#pdf-make').addEventListener('click', async () => {
  const button = $('#pdf-make'), status = $('#pdf-status');
  button.disabled = true; status.textContent = 'Starting…';
  try {
    const {resultId: jobId} = await runJob(`/v1/extractions/${id}/book`, message => { status.textContent = message; });
    const manifest = await api(`/v1/assets/${jobId}`);
    status.replaceChildren(el('a', {class: 'button', href: `/v1/assets/${jobId}/file?download=1`}, `Download ${manifest.file}`));
    button.textContent = 'Create again';
  } catch (error) { status.textContent = error.message; }
  button.disabled = false;
});
load();
