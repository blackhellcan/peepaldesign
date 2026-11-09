setCrumbs([{label: 'Sign in'}]);
// Magic-link sign-in. The token arrives in the URL fragment (never sent to a server) and is
// exchanged only when the person presses Sign in, so link scanners that open emails can't use it up.
const fragment = new URLSearchParams(location.hash.slice(1)), token = fragment.get('token'), ssoError = fragment.get('error');
// Only GapScan's own pages are valid places to return to.
const next = /^\/app\/[a-z-]*(\.html)?(\?[\w=&%.-]*)?$/.test(fragment.get('next') ?? '') ? fragment.get('next') : '/app/';
const signedOut = fragment.has('signed-out');
// Messages for single sign-on that came back without signing in (codes from /v1/auth/sso/…/callback).
const SSO_ERRORS = {
  cancelled: 'Sign-in was cancelled. Choose an option to try again.',
  state: 'That sign-in took too long or was already used. Start again.',
  code: 'The sign-in provider didn’t accept this sign-in. Start again.',
  token: 'The sign-in couldn’t be verified. Start again, and contact your administrator if it keeps happening.',
  email: 'Your account didn’t share a verified email address, so it can’t be used to sign in.',
  domain: 'This email address can’t sign in here. Ask a project owner to invite you.',
  provider: 'The sign-in provider couldn’t be reached. Try again in a moment.',
  unknown: 'That sign-in option isn’t set up here.',
};
if (ssoError) { $('#sso-error').textContent = SSO_ERRORS[ssoError] ?? SSO_ERRORS.provider; $('#sso-error').hidden = false; }
fetch('/v1/auth/providers').then(r => r.json()).then(({emailLinks, providers, testUsers, adminOnly}) => {
  if (adminOnly) {
    setCrumbs([{label: 'Admin sign-in'}]);
    $('h1').textContent = 'Admin sign-in';
    $('#lead').textContent = 'Only GapScan admins sign in. Everyone else can use GapScan without an account.';
    $('#lead').after(el('p', {}, el('a', {href: '/app/'}, 'Go to GapScan')));
  }
  if (testUsers?.length) showTestUsers(testUsers);
  if (providers?.length) {
    $('#sso').replaceChildren(...providers.map(p => el('a', {class: 'button sso-button', href: `/v1/auth/sso/${encodeURIComponent(p.id)}/start`}, `Continue with ${p.name}`)),
      emailLinks ? el('p', {class: 'muted or'}, 'or get a link by email') : '');
    $('#sso').hidden = false;
    $('#lead').textContent = emailLinks === false ? 'Sign in with your organisation’s account.' : 'Sign in with your organisation’s account, or get a link by email. No password needed.';
  }
  if (emailLinks === false) $('#email-form').hidden = true;
}).catch(() => {});
history.replaceState(null, '', location.pathname);   // keep the token out of history and bookmarks
if (token) { $('#finish').hidden = false; $('#request').hidden = true; }
addEventListener('hashchange', () => location.reload());   // a link opened in a tab already on this page

$('#finish-button').addEventListener('click', async () => {
  $('#finish-button').disabled = true;
  try { await api('/v1/auth/session', {method: 'POST', body: JSON.stringify({token})}); location.replace(next); }
  catch (error) { $('#finish-error').textContent = error.message; $('#request').hidden = false; $('#finish-button').disabled = false; }
});
$('#email-form').addEventListener('submit', async event => {
  event.preventDefault();
  const status = $('#request-status');
  try { status.textContent = (await api('/v1/auth/link', {method: 'POST', body: JSON.stringify({email: $('#email').value})})).message; }
  catch (error) { status.textContent = error.message; }
});

// Local testing only: the server lists test accounts when GAPSCAN_AUTH_TEST_USERS is set.
// The last account used signs in again by itself, except straight after signing out.
const TEST_KEY = 'gapscan-test-user';
async function testSignIn(email) {
  try {
    await api('/v1/auth/test-session', {method: 'POST', body: JSON.stringify({email})});
    try { localStorage.setItem(TEST_KEY, email); } catch {}
    location.replace(next);
  } catch (error) { $('#test-status').textContent = error.message; }
}
function showTestUsers(emails) {
  $('#test-buttons').replaceChildren(...emails.map(email => el('button', {type: 'button', onclick: () => testSignIn(email)}, `Sign in as ${email}`)));
  $('#test-users').hidden = false;
  let last = null;
  // Signing out forgets the account, so you can pick another.
  try { if (signedOut) localStorage.removeItem(TEST_KEY); else last = localStorage.getItem(TEST_KEY); } catch {}
  if (last && emails.includes(last) && !token) { $('#test-status').textContent = `Signing in as ${last}…`; testSignIn(last); }
}
