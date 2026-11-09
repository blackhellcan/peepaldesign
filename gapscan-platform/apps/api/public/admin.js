// Admin: every design system, recent activity, the reference library and how this GapScan is set up.
const when = iso => new Date(iso).toLocaleString(undefined, {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'});
let systems = [], activity = [];

// Tabs, with the address keeping the tab (#activity) like the other tabbed pages.
const VIEWS = ['systems', 'activity', 'library', 'settings'], tabs = [...document.querySelectorAll('.page-tabs [role="tab"]')];
function showView(view) {
  if (!VIEWS.includes(view)) view = 'systems';
  tabs.forEach(t => { const on = t.dataset.view === view; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
  VIEWS.forEach(v => { $(`#view-${v}`).hidden = v !== view; });
  history.replaceState(null, '', view === 'systems' ? location.pathname : `#${view}`);
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
    if (step) { event.preventDefault(); const next = tabs[(i + step + tabs.length) % tabs.length]; showView(next.dataset.view); next.focus(); }
  });
});
showView(location.hash.slice(1));

function renderSystems() {
  const query = $('#search').value.trim().toLowerCase();
  const rows = systems.filter(s => !query || s.name.toLowerCase().includes(query) || (s.owner ?? '').toLowerCase().includes(query));
  $('#systems').replaceChildren(el('tr', {}, ['Design system', 'Owner', 'Sources', 'Extractions', 'Last activity', ''].map(h => el('th', {}, h))),
    ...rows.map(s => el('tr', {},
      el('td', {}, el('strong', {}, s.name)),
      el('td', {class: 'muted'}, s.owner ?? '—'),
      el('td', {}, String(s.sources)),
      el('td', {}, String(s.extractions)),
      el('td', {class: 'muted'}, when(s.lastActivity)),
      el('td', {}, s.latestExtraction ? el('span', {class: 'row'}, el('a', {href: `/app/review.html?id=${s.latestExtraction.id}`}, 'Full detail'), el('a', {href: `/app/system.html?id=${s.latestExtraction.id}`}, 'As the user sees it'))
        : el('a', {href: `/app/?project=${s.id}`}, 'Sources')))));
  $('#systems-status').textContent = rows.length ? '' : query ? 'Nothing matches that search.' : 'No design systems yet.';
}
function renderActivity() {
  const rows = $('#failed-only').checked ? activity.filter(a => a.status === 'failed') : activity;
  const STATUS = {completed: 'ok', failed: 'major', cancelled: '', queued: 'minor', running: 'minor'};
  $('#activity').replaceChildren(el('tr', {}, ['When', 'What', 'Design system', 'Status', 'Detail'].map(h => el('th', {}, h))),
    ...(rows.length ? rows.map(a => el('tr', {},
      el('td', {class: 'muted'}, when(a.createdAt)), el('td', {}, a.label), el('td', {}, a.project ?? '—'),
      el('td', {}, el('span', {class: `pill ${STATUS[a.status] ?? ''}`}, a.status)),
      el('td', {class: 'wrap'}, a.error ?? (a.type === 'extract' && a.resultId ? el('a', {href: `/app/review.html?id=${a.resultId}`}, 'Open') : a.type === 'gapscan' && a.resultId ? el('a', {href: `/app/gapscan.html?id=${a.resultId}`}, 'Open report') : ''))))
      : [el('tr', {}, el('td', {colspan: 5, class: 'muted'}, 'Nothing here.'))]));
}
function renderSettings(settings) {
  const row = (term, value) => [el('dt', {}, term), el('dd', {}, value)];
  $('#settings').replaceChildren(
    ...row('Accounts', settings.accounts),
    ...row('Admins', settings.admins.length ? settings.admins.join(', ') : 'None'),
    ...row('Sign-in', settings.signIn.length ? settings.signIn.join(', ') : '—'),
    ...row('Drafting with Claude', settings.drafting.enabled ? `On: ${settings.drafting.model}, ${settings.drafting.effort} effort` : 'Off (set GAPSCAN_AI=claude)'),
    ...row('Figma token', settings.figmaToken ? 'Set: Figma links are read, and admins can sync variables' : 'Not set: Figma links are recorded but not read'));
}
// The reference library: one card per system; its components load when opened.
const READ_FROM = {css: 'Read from its published CSS', types: 'Read from its TypeScript types', recipes: 'Read from its style recipes', registry: 'Read from its component registry', 'web-components': 'Read from its web components'};
const number = n => Number(n).toLocaleString();
function libraryCard(r) {
  const body = el('div', {class: 'library-components'});
  const more = el('details', {class: 'library-more'}, el('summary', {}, `Show ${number(r.components)} components`), body);
  more.addEventListener('toggle', async () => {
    if (!more.open || body.dataset.loaded) return;
    body.dataset.loaded = '1'; body.replaceChildren(el('p', {class: 'muted'}, 'Loading…'));
    try {
      const full = await api(`/v1/library/${encodeURIComponent(r.id)}`), groups = new Map();
      for (const c of full.components) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
      body.replaceChildren(...[...groups].sort((a, b) => b[1].length - a[1].length).map(([category, list]) => el('div', {class: 'library-group'},
        el('h4', {}, `${category} `, el('span', {class: 'muted'}, String(list.length))),
        el('ul', {class: 'chips plain'}, list.map(c => {
          const detail = [c.variants?.length ? `${c.variants.length} styles` : '', c.sizes?.length ? `sizes ${c.sizes.join(', ')}` : '', (c.states ?? c.statesObserved)?.length ? `states ${(c.states ?? c.statesObserved).join(', ')}` : ''].filter(Boolean).join(' · ');
          return el('li', {class: 'library-chip', title: detail || 'No published options'}, c.canonical);
        })))));
    } catch (error) { body.replaceChildren(el('p', {class: 'error'}, error.message)); }
  });
  return el('article', {class: 'library-card'},
    el('div', {class: 'library-head'}, el('h3', {}, r.library), el('span', {class: 'pill', title: r.version}, r.version)),
    el('p', {class: 'muted library-meta'}, `${r.framework} · ${READ_FROM[r.kind] ?? `Read as ${r.kind}`}`),
    el('dl', {class: 'library-facts'},
      el('div', {}, el('dt', {}, 'Components'), el('dd', {}, number(r.components))),
      el('div', {}, el('dt', {}, 'Tokens'), el('dd', {}, r.tokens ? number(r.tokens) : '—')),
      el('div', {}, el('dt', {}, 'Pinned'), el('dd', {}, new Date(r.pinnedAt).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})))),
    el('div', {class: 'row library-actions'}, r.homepage ? el('a', {href: r.homepage, target: '_blank', rel: 'noopener'}, 'Website') : null),
    more);
}
async function renderLibrary() {
  try {
    const list = await api('/v1/library');
    $('#count-library').textContent = list.length;
    const components = list.reduce((n, r) => n + r.components, 0);
    $('#library-summary').textContent = `${list.length} design systems · ${number(components)} components`;
    $('#library').replaceChildren(...list.map(libraryCard));
  } catch (error) { $('#library').replaceChildren(el('p', {class: 'error'}, error.message)); }
}

$('#search').addEventListener('input', renderSystems);
$('#failed-only').addEventListener('change', renderActivity);
setCrumbs([{label: 'Admin'}]);
(async () => {
  try {
    [systems, activity] = await Promise.all([api('/v1/admin/design-systems'), api('/v1/admin/activity')]);
    $('#count-systems').textContent = systems.length || '';
    const failed = activity.filter(a => a.status === 'failed').length;
    $('#count-failed').textContent = failed ? `${failed} failed` : '';
    renderSystems(); renderActivity();
    renderSettings(await api('/v1/admin/settings'));
    renderLibrary();
  } catch (error) {
    $('#systems-status').replaceChildren(error.message === 'Admins only.' ? el('span', {}, 'Admins only. ', el('a', {href: '/app/signin.html'}, 'Sign in as an admin')) : error.message);
  }
})();
