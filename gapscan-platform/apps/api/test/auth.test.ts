import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configFromEnv, createInfra} from '@gapscan/infra';
import {buildApp} from '../src/app.ts';
import {accessRules, authSettingsFromEnv} from '../src/auth.ts';
import type {Mail} from '../src/mailer.ts';

const PUBLIC = 'https://gapscan.example.com';

async function harness(options: {allowedDomains?: string[]; testUsers?: string[]; visitors?: boolean; admins?: string[]} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-auth-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const outbox: Mail[] = [];
  const app = buildApp({infra, auth: {mode: 'magic-link', publicUrl: new URL(PUBLIC), mailer: {send: async mail => { outbox.push(mail); }}, allowedDomains: options.allowedDomains ?? [], ...(options.testUsers ? {testUsers: options.testUsers} : {}), ...(options.visitors ? {visitors: true} : {}), ...(options.admins ? {admins: options.admins} : {})}});
  const call = async (method: string, url: string, {cookie, payload, origin, from}: {cookie?: string; payload?: object; origin?: string; from?: string} = {}) => {
    const r = await app.inject({method: method as 'GET', url, ...(from ? {remoteAddress: from} : {}), headers: {...(cookie ? {cookie} : {}), ...(origin ? {origin} : {})}, ...(payload ? {payload} : {})});
    return {status: r.statusCode, body: /json/.test(String(r.headers['content-type'])) ? JSON.parse(r.body) : r.body, cookie: String(r.headers['set-cookie'] ?? '')};
  };
  // Request a link, read it from the "email", and exchange it for a session cookie.
  const signIn = async (email: string) => {
    assert.equal((await call('POST', '/v1/auth/link', {payload: {email}})).status, 202);
    const mail = outbox.findLast(m => m.to === email.toLowerCase())!;
    const link = mail.text.match(/https:\S+/)![0], token = new URL(link).hash.slice('#token='.length);
    const session = await call('POST', '/v1/auth/session', {payload: {token}});
    assert.equal(session.status, 200);
    return {cookie: session.cookie.split(';')[0]!, setCookie: session.cookie, link, token, user: session.body.user};
  };
  const close = async () => { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); };
  return {app, infra, outbox, call, signIn, close};
}

test('every API route has an access rule, and a route without one stops the server starting', async () => {
  const h = await harness();
  try { await h.app.ready(); } finally { await h.close(); }
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-auth-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const app = buildApp({infra});
  app.get('/v1/forgotten', async () => ({open: true}));
  await assert.rejects(async () => { await app.ready(); }, /Routes without an access rule in auth.ts: GET \/v1\/forgotten/);
  await infra.close(); await rm(dataDir, {recursive: true, force: true});
  for (const key of Object.keys(accessRules(infra.store))) assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \//);
});

test('a magic link signs you in once; the link travels in the URL fragment; the cookie is HttpOnly and Secure', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('GET', '/v1/library')).status, 401, 'signed out');
    assert.equal((await h.call('GET', '/app/')).status, 200, 'pages stay public');
    const ana = await h.signIn('Ana@Example.com');
    assert.match(ana.link, /^https:\/\/gapscan\.example\.com\/app\/signin\.html#token=[\w-]{43}$/);
    assert.match(ana.setCookie, /^gapscan_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
    assert.equal(ana.user.email, 'ana@example.com');
    assert.equal((await h.call('POST', '/v1/auth/session', {payload: {token: ana.token}})).status, 400, 'single use');
    assert.equal((await h.call('GET', '/v1/auth/me', {cookie: ana.cookie})).body.user.email, 'ana@example.com');
    assert.equal((await h.call('GET', '/v1/library', {cookie: ana.cookie})).status, 200);
    assert.equal((await h.call('POST', '/v1/auth/logout', {cookie: ana.cookie})).status, 204);
    assert.equal((await h.call('GET', '/v1/library', {cookie: ana.cookie})).status, 401, 'the session is gone after sign-out');
  } finally { await h.close(); }
});

test('projects are private to their members; owners invite, editors work, approvals carry the signed-in name', async () => {
  const h = await harness();
  try {
    const ana = await h.signIn('ana@example.com'), ben = await h.signIn('ben@example.com');
    const project = (await h.call('POST', '/v1/projects', {cookie: ana.cookie, payload: {name: 'Acme'}})).body;
    await h.call('POST', `/v1/projects/${project.id}/sources`, {cookie: ana.cookie, payload: {kind: 'code', name: 'a.css', content: '.btn{color:#0b5fd6}'}});
    const {jobId} = (await h.call('POST', `/v1/projects/${project.id}/extractions`, {cookie: ana.cookie})).body;
    await h.infra.queue.idle();
    const edsId = (await h.call('GET', `/v1/jobs/${jobId}`, {cookie: ana.cookie})).body.resultId;

    // Ben is signed in but not a member: everything about the project reads as "not found".
    for (const url of [`/v1/projects/${project.id}`, `/v1/jobs/${jobId}`, `/v1/extractions/${edsId}`, `/v1/extractions/${edsId}/export?format=css`])
      assert.deepEqual([(await h.call('GET', url, {cookie: ben.cookie})).status, url], [404, url]);
    assert.equal((await h.call('POST', '/v1/gapscans', {cookie: ben.cookie, payload: {edsId, referenceId: 'bootstrap-5.3.3'}})).status, 404, 'resolved through the body too');
    assert.deepEqual((await h.call('GET', '/v1/projects', {cookie: ben.cookie})).body, []);
    assert.equal((await h.call('PATCH', `/v1/projects/${project.id}`, {cookie: ben.cookie, payload: {name: 'Mine now'}})).status, 404, 'only members rename');
    assert.deepEqual((await h.call('GET', '/v1/projects', {cookie: ana.cookie})).body.map((p: {name: string; extractions: number}) => [p.name, p.extractions]), [['Acme', 1]]);

    // Ana invites Ben as an editor; he gets an email and access.
    const members = await h.call('POST', `/v1/projects/${project.id}/members`, {cookie: ana.cookie, payload: {email: 'ben@example.com'}});
    assert.deepEqual(members.body.map((m: {email: string; role: string}) => [m.email, m.role]), [['ana@example.com', 'owner'], ['ben@example.com', 'editor']]);
    assert.match(h.outbox.at(-1)!.subject, /added to Acme/);
    assert.equal((await h.call('GET', `/v1/extractions/${edsId}`, {cookie: ben.cookie})).status, 200);
    assert.deepEqual((await h.call('GET', '/v1/projects', {cookie: ben.cookie})).body.map((p: {id: string}) => p.id), [project.id]);
    assert.equal((await h.call('POST', `/v1/projects/${project.id}/members`, {cookie: ben.cookie, payload: {email: 'eve@example.com'}})).status, 403, 'editors cannot invite');
    assert.equal((await h.call('DELETE', `/v1/projects/${project.id}/members/${ana.user.id}`, {cookie: ana.cookie})).status, 400, 'the last owner stays');

    // An approval records who is signed in, whatever name the request claims.
    const objects = (await h.call('GET', `/v1/extractions/${edsId}/objects`, {cookie: ben.cookie})).body;
    const section = objects[0].sections[0];
    const approved = await h.call('PUT', `/v1/extractions/${edsId}/objects/${objects[0].kind}/sections/${section.id}/approval`, {cookie: ben.cookie, payload: {by: 'Somebody Else'}});
    assert.equal(approved.status, 200);
    assert.equal(approved.body.sections.find((s: {id: string}) => s.id === section.id).approval.by, 'ben@example.com');

    await h.call('DELETE', `/v1/projects/${project.id}/members/${ben.user.id}`, {cookie: ana.cookie});
    assert.equal((await h.call('GET', `/v1/extractions/${edsId}`, {cookie: ben.cookie})).status, 404, 'removed members lose access');
  } finally { await h.close(); }
});

test('cross-site requests are refused; sign-in requests reveal nothing and are rate-limited', async () => {
  const h = await harness({allowedDomains: ['example.com']});
  try {
    const ana = await h.signIn('ana@example.com');
    assert.equal((await h.call('POST', '/v1/projects', {cookie: ana.cookie, origin: 'https://evil.test', payload: {name: 'x'}})).status, 403);
    assert.equal((await h.call('POST', '/v1/projects', {cookie: ana.cookie, origin: PUBLIC, payload: {name: 'x'}})).status, 201);

    const before = h.outbox.length;
    const outsider = await h.call('POST', '/v1/auth/link', {payload: {email: 'mallory@other.test'}});
    const insider = await h.call('POST', '/v1/auth/link', {payload: {email: 'new@example.com'}});
    assert.deepEqual([outsider.status, outsider.body], [insider.status, insider.body], 'same answer either way');
    assert.equal(h.outbox.length, before + 1, 'only the allowed domain got a link');
    for (let i = 0; i < 6; i++) await h.call('POST', '/v1/auth/link', {payload: {email: 'flood@example.com'}});
    assert.equal(h.outbox.filter(m => m.to === 'flood@example.com').length, 5, 'at most five links per address in 15 minutes');
    assert.equal((await h.call('POST', '/v1/auth/link', {payload: {email: 'not-an-email'}})).status, 400);
    assert.equal((await h.call('POST', '/v1/auth/session', {payload: {token: 'x'.repeat(43)}})).status, 400);
  } finally { await h.close(); }
});

test('hosted deployments must choose accounts explicitly and cannot log sign-in links', () => {
  assert.equal(authSettingsFromEnv({}).mode, 'off', 'local mode stays open');
  assert.throws(() => authSettingsFromEnv({GAPSCAN_STORE: 'postgres'}), /needs GAPSCAN_AUTH=magic-link/);
  assert.equal(authSettingsFromEnv({GAPSCAN_STORE: 'postgres', GAPSCAN_AUTH: 'off'}).mode, 'off');
  assert.throws(() => authSettingsFromEnv({GAPSCAN_AUTH: 'magic-link'}), /GAPSCAN_PUBLIC_URL/);
  assert.throws(() => authSettingsFromEnv({GAPSCAN_STORE: 'postgres', GAPSCAN_AUTH: 'magic-link', GAPSCAN_PUBLIC_URL: PUBLIC, GAPSCAN_MAIL: 'log'}), /server logs/);
  assert.throws(() => authSettingsFromEnv({GAPSCAN_STORE: 'postgres', GAPSCAN_AUTH: 'magic-link', GAPSCAN_PUBLIC_URL: PUBLIC}), /GAPSCAN_SMTP_URL and GAPSCAN_MAIL_FROM/);
  const local = authSettingsFromEnv({GAPSCAN_AUTH: 'magic-link', GAPSCAN_PUBLIC_URL: 'http://localhost:4300', GAPSCAN_AUTH_DOMAINS: 'Acme.com, acme.io'});
  assert.deepEqual(local.mode === 'magic-link' && [local.mail, local.allowedDomains], ['log', ['acme.com', 'acme.io']]);
});

test('test accounts: local development only, listed on the sign-in page, one click, from this machine', async () => {
  const local = {GAPSCAN_AUTH: 'magic-link', GAPSCAN_PUBLIC_URL: 'http://localhost:4301', GAPSCAN_AUTH_TEST_USERS: 'Owner@test.local, editor@test.local'};
  assert.deepEqual(authSettingsFromEnv(local).mode === 'magic-link' && authSettingsFromEnv(local).testUsers, ['owner@test.local', 'editor@test.local']);
  assert.throws(() => authSettingsFromEnv({...local, GAPSCAN_PUBLIC_URL: 'https://gapscan.example.com'}), /local development only/);
  assert.throws(() => authSettingsFromEnv({...local, GAPSCAN_STORE: 'postgres', GAPSCAN_MAIL: 'smtp', GAPSCAN_SMTP_URL: 'smtp://x', GAPSCAN_MAIL_FROM: 'a@b.c'}), /local development only/);
  assert.throws(() => authSettingsFromEnv({...local, GAPSCAN_AUTH_TEST_USERS: 'not-an-email'}), /invalid email/);

  const off = await harness();
  try {
    assert.equal((await off.call('GET', '/v1/auth/providers')).body.testUsers, undefined);
    assert.equal((await off.call('POST', '/v1/auth/test-session', {payload: {email: 'owner@test.local'}})).status, 404, 'absent unless configured');
  } finally { await off.close(); }

  const h = await harness({testUsers: ['owner@test.local', 'editor@test.local']});
  try {
    assert.deepEqual((await h.call('GET', '/v1/auth/providers')).body.testUsers, ['owner@test.local', 'editor@test.local']);
    assert.equal((await h.call('POST', '/v1/auth/test-session', {payload: {email: 'someone@else.com'}})).status, 400);
    assert.equal((await h.call('POST', '/v1/auth/test-session', {payload: {email: 'owner@test.local'}, from: '203.0.113.5'})).status, 403, 'not from another machine');
    const signedIn = await h.call('POST', '/v1/auth/test-session', {payload: {email: 'owner@test.local'}});
    assert.equal(signedIn.status, 200);
    assert.match(signedIn.cookie, /HttpOnly/);
    assert.equal(h.outbox.length, 0, 'no email sent');
    const cookie = signedIn.cookie.split(';')[0]!;
    assert.equal((await h.call('GET', '/v1/auth/me', {cookie})).body.user.email, 'owner@test.local');
    assert.equal((await h.call('POST', '/v1/projects', {cookie, payload: {name: 'Test'}})).status, 201);
  } finally { await h.close(); }
});

test('visitor mode: no sign-in, a private space per browser, and only admins sign in to see everything', async () => {
  assert.throws(() => authSettingsFromEnv({GAPSCAN_AUTH: 'visitor', GAPSCAN_PUBLIC_URL: PUBLIC}), /needs GAPSCAN_ADMIN_EMAILS/);
  const settings = authSettingsFromEnv({GAPSCAN_AUTH: 'visitor', GAPSCAN_PUBLIC_URL: PUBLIC, GAPSCAN_ADMIN_EMAILS: 'Admin@Example.com'});
  assert.ok(settings.mode === 'magic-link' && settings.visitors && settings.admins[0] === 'admin@example.com');

  const h = await harness({visitors: true, admins: ['admin@example.com']});
  try {
    assert.equal((await h.call('GET', '/app/')).cookie, '', 'reading a page creates nothing');
    const first = await h.call('GET', '/v1/auth/me');
    assert.equal(first.status, 200);
    assert.equal(first.body.anonymous, true);
    assert.equal(first.body.admin, false);
    assert.match(first.body.user.email, /@visitors\.invalid$/);
    const ana = first.cookie.split(';')[0]!;
    const project = (await h.call('POST', '/v1/projects', {cookie: ana, payload: {name: 'Ana system'}})).body;
    assert.deepEqual((await h.call('GET', '/v1/projects', {cookie: ana})).body.map((p: {name: string}) => p.name), ['Ana system']);

    // Another browser: its own empty space, and Ana's project reads as not found.
    const ben = (await h.call('GET', '/v1/projects')).cookie.split(';')[0]!;
    assert.ok(ben && ben !== ana);
    assert.deepEqual((await h.call('GET', '/v1/projects', {cookie: ben})).body, []);
    assert.equal((await h.call('GET', `/v1/projects/${project.id}`, {cookie: ben})).status, 404);
    assert.equal((await h.call('GET', '/v1/admin/design-systems', {cookie: ben})).status, 403);
    assert.equal((await h.call('POST', `/v1/projects/${project.id}/members`, {cookie: ana, payload: {email: 'friend@example.com'}})).status, 403, 'no sharing without accounts');

    // Only admins get sign-in links.
    assert.equal((await h.call('POST', '/v1/auth/link', {payload: {email: 'someone@example.com'}})).status, 202);
    assert.equal(h.outbox.length, 0, 'same answer, no email');
    assert.equal((await h.call('GET', '/v1/auth/providers')).body.adminOnly, true);
    const admin = await h.signIn('admin@example.com');
    const me = (await h.call('GET', '/v1/auth/me', {cookie: admin.cookie})).body;
    assert.deepEqual([me.admin, me.anonymous], [true, false]);
    const all = (await h.call('GET', '/v1/admin/design-systems', {cookie: admin.cookie})).body;
    assert.deepEqual(all.map((p: {name: string; owner: string}) => [p.name, p.owner]), [['Ana system', 'Visitor']], 'visitors stay anonymous');
    assert.equal((await h.call('GET', `/v1/projects/${project.id}`, {cookie: admin.cookie})).status, 200, 'admins can open any project');
    for (const url of ['/v1/admin/activity', '/v1/admin/settings']) assert.equal((await h.call('GET', url, {cookie: ben})).status, 403, url);
    await h.call('POST', `/v1/projects/${project.id}/sources`, {cookie: ana, payload: {kind: 'code', name: 'a.css', content: '.btn{color:#0b5fd6}'}});
    await h.call('POST', `/v1/projects/${project.id}/extractions`, {cookie: ana});
    await h.infra.queue.idle();
    const activity = (await h.call('GET', '/v1/admin/activity', {cookie: admin.cookie})).body;
    assert.deepEqual(activity.map((a: {label: string; status: string; project: string}) => [a.label, a.status, a.project]), [['Read a design system', 'completed', 'Ana system']]);
    const settings = (await h.call('GET', '/v1/admin/settings', {cookie: admin.cookie}));
    assert.equal(settings.body.accounts, 'Visitors without sign-in; admins sign in');
    assert.deepEqual(settings.body.admins, ['admin@example.com']);
    assert.ok(settings.body.references.length >= 10);
    assert.doesNotMatch(JSON.stringify(settings.body), /secret|password|token":"/i, 'never secrets');
  } finally { await h.close(); }
});
