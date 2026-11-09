// More tools: brand assets made from the design system (the form itself lives in assets.js).
const id = new URLSearchParams(location.search).get('id');
if (id) systemContext(id, 'More tools').then(({project}) => { document.querySelector('#asset-form [name="brandName"]').value = project.name; }).catch(error => { $('#lead').textContent = error.message; });
else $('#lead').textContent = 'No design system in the link.';
