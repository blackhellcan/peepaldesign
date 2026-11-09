// Shared helpers for the extraction pages. Plain browser JavaScript, no build.
const $ = selector => document.querySelector(selector);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value; else if (key === 'style') node.setAttribute('style', value); else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
async function api(path, options = {}) {
  await sessionReady;   // the first visit gets its visitor cookie before anything else is asked for
  const response = await fetch(path, {...options, headers: {'content-type': 'application/json', ...(options.headers || {})}});
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401 && !location.pathname.endsWith('/signin.html')) { location.href = signinUrl(); throw new Error('Sign in first.'); }
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}
// After signing in, people come back to the page they were on.
const signinUrl = () => `/app/signin.html#next=${encodeURIComponent(location.pathname + location.search)}`;

// ── App bar: the same on every page. Brand, where you are, who you are, theme. ──
const ICONS = {
  moon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20.7 14.6A8.5 8.5 0 0 1 9.4 3.3a.8.8 0 0 0-1-1A10 10 0 1 0 21.7 15.6a.8.8 0 0 0-1-1Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
};
const svg = markup => { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstChild; };   // fixed icons only, never data
const appBar = el('nav', {class: 'appbar', 'aria-label': 'GapScan'}, el('div', {class: 'appbar-inner'},
  el('a', {class: 'brand', href: '/app/'}, el('span', {class: 'brand-mark', 'aria-hidden': 'true'}), 'GapScan'),
  el('ol', {class: 'crumbs', 'aria-label': 'You are here'}),
  el('div', {class: 'appbar-end'}, el('button', {class: 'icon-button', id: 'theme', type: 'button'}))));
document.body.prepend(appBar);
// Pages say where they are: [{label, href?}, …]; the last one is the current page.
function setCrumbs(crumbs) {
  appBar.querySelector('.crumbs').replaceChildren(...crumbs.map((c, i) => el('li', {}, i === crumbs.length - 1
    ? el('span', {'aria-current': 'page'}, c.label) : el('a', {href: c.href}, c.label))));
  document.title = [...crumbs].reverse().map(c => c.label).concat('GapScan').join(' · ');
}
// Projects › <project> › …rest, with the project's name fetched (left out if it can't be read).
async function crumbsFor(projectId, ...rest) {
  const project = projectId ? await api(`/v1/projects/${projectId}`).catch(() => null) : null;
  setCrumbs([{label: 'Design systems', href: '/app/'}, ...(project ? [{label: project.name, href: `/app/?project=${project.id}`}] : []), ...rest]);
  return project;
}

// Pages about one design system (Export, Documents, Migrate): Design systems / <name> / <page>.
async function systemContext(id, label) {
  const record = await api(`/v1/extractions/${id}`), project = await api(`/v1/projects/${record.projectId}`);
  setCrumbs([{label: 'Design systems', href: '/app/'}, {label: project.name, href: `/app/system.html?id=${id}`}, {label}]);
  return {record, project};
}

// Who is here: `me` resolves to {user, anonymous, admin} (user null when accounts are off) and `whoami` to the user.
// Visitors (no sign-in) see nothing in the bar; signed-in people see their email; admins also get the Admin link.
const me = location.pathname.endsWith('/signin.html') ? Promise.resolve({user: null})
  : fetch('/v1/auth/me').then(r => r.status === 401 ? (location.href = signinUrl(), {user: null}) : r.json()).catch(() => ({user: null}));
var sessionReady = me.then(() => {}, () => {});
const whoami = me.then(info => {
  const user = info?.user ?? null, end = appBar.querySelector('.appbar-end');
  // Admins get a settings gear before the theme switch; it opens the admin area.
  if (info?.admin) $('#theme').before(el('a', {class: 'icon-button admin-gear', href: '/app/admin.html', 'aria-label': 'Admin settings', title: 'Admin settings',
    ...(location.pathname.endsWith('/admin.html') ? {'aria-current': 'page'} : {})}, svg(ICONS.gear)));
  if (user && !info.anonymous) end.prepend(el('div', {class: 'account'}, el('span', {class: 'muted account-email', title: user.email}, user.email),
    el('button', {type: 'button', class: 'quiet', onclick: async () => { await fetch('/v1/auth/logout', {method: 'POST'}); location.href = '/app/signin.html#signed-out'; }}, 'Sign out')));
  return user;
});
// Drafting with Claude is on only when the server says so; buttons stay hidden otherwise.
const aiStatus = location.pathname.endsWith('/signin.html') ? Promise.resolve({enabled: false}) : fetch('/v1/ai').then(r => r.ok ? r.json() : {enabled: false}).catch(() => ({enabled: false}));
// A failure message followed by the reasons each source gave (warnings are otherwise easy to miss).
function withReasons(message, warnings) { return warnings.length ? `${message} ${warnings.join(' ')}` : message; }
// Starts a job and resolves when it completes; progress messages go to `onProgress`.
async function runJob(path, onProgress = () => {}, body) {
  const {events} = await api(path, {method: 'POST', ...(body ? {body: JSON.stringify(body)} : {})});
  return new Promise((resolve, reject) => {
    const stream = new EventSource(events), warnings = [];
    stream.addEventListener('progress', e => onProgress(JSON.parse(e.data).body.message));
    stream.addEventListener('warning', e => warnings.push(JSON.parse(e.data).body.message));
    stream.addEventListener('complete', e => { stream.close(); resolve(JSON.parse(e.data).body); });
    stream.addEventListener('failed', e => { stream.close(); reject(Object.assign(new Error(withReasons(JSON.parse(e.data).body.message, warnings)), {warnings})); });
    stream.addEventListener('cancelled', () => { stream.close(); reject(new Error('Cancelled.')); });
  });
}
(function theme() {
  const button = $('#theme');
  const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const paint = () => { const dark = isDark(); button.replaceChildren(svg(dark ? ICONS.sun : ICONS.moon)); button.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme'); button.title = button.getAttribute('aria-label'); };
  try { const saved = localStorage.getItem('gapscan-theme'); if (saved) document.documentElement.dataset.theme = saved; } catch {}
  paint();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
  button.addEventListener('click', () => {
    document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('gapscan-theme', document.documentElement.dataset.theme); } catch {}
    paint();
  });
})();

// Minimal, safe Markdown → DOM for generated sections: headings, lists, tables,
// fenced code, bold, italic and inline code. Never uses innerHTML.
function inline(text) {
  const out = [], pattern = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_|\*[^*]+\*)/g;
  let last = 0, m;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? el('strong', {}, t.slice(2, -2)) : t.startsWith('`') ? el('code', {}, t.slice(1, -1)) : el('em', {}, t.slice(1, -1)));
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function markdown(source) {
  const root = el('div', {class: 'md'}), lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) { const code = []; while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]); root.append(el('pre', {}, el('code', {}, code.join('\n')))); continue; }
    if (/^#{1,4} /.test(line)) { root.append(el('h4', {}, ...inline(line.replace(/^#+ /, '')))); continue; }
    if (line.startsWith('- ')) { const list = el('ul'); while (i < lines.length && lines[i].startsWith('- ')) list.append(el('li', {}, ...inline(lines[i++].slice(2)))); i--; root.append(list); continue; }
    if (line.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]); i--;
      const cells = row => row.split('|').slice(1, -1).map(c => c.trim());
      const table = el('table', {}, el('tr', {}, cells(rows[0]).map(c => el('th', {}, ...inline(c)))), rows.slice(2).map(r => el('tr', {}, cells(r).map(c => el('td', {}, ...inline(c))))));
      root.append(el('div', {class: 'table-wrap'}, table)); continue;
    }
    if (line.trim()) root.append(el('p', {}, ...inline(line)));
  }
  return root;
}
