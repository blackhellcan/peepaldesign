// Single sign-on against a local OpenID Connect provider that behaves like the real ones
// (discovery, JWKS, PKCE-checked token endpoint), including the ways sign-in must fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac, generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configFromEnv, createInfra} from '@gapscan/infra';
import {buildApp} from '../src/app.ts';
import {authSettingsFromEnv} from '../src/auth.ts';
import {createOidc} from '../src/oidc.ts';

const b64 = (v: object | Buffer) => Buffer.from(Buffer.isBuffer(v) ? v : JSON.stringify(v)).toString('base64url');
const PUBLIC = 'https://gapscan.example.com';

type Tamper = {claims?: Record<string, unknown>; alg?: string; badSignature?: boolean; unsigned?: boolean};
async function provider() {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1', alg: 'RS256', use: 'sig'};
  const codes = new Map<string, {challenge: string; nonce: string; tamper: Tamper}>();
  let origin = '';
  const idToken = (nonce: string, t: Tamper) => {
    const now = Math.floor(Date.now() / 1000);
    const header = {alg: t.alg ?? 'RS256', kid: 'k1', typ: 'JWT'}, claims = {iss: origin, aud: 'client-1', sub: 'u1', email: 'Ana@Acme.test', email_verified: true, iat: now, exp: now + 300, nonce, ...t.claims};
    const data = `${b64(header)}.${b64(claims)}`;
    if (t.unsigned) return `${b64({alg: 'none'})}.${b64(claims)}.`;
    if (t.alg === 'HS256') return `${data}.${createHmac('sha256', 'client-secret').update(data).digest('base64url')}`;
    const signature = sign('sha256', Buffer.from(data), privateKey);
    if (t.badSignature) signature[10] = signature[10]! ^ 0xff;
    return `${data}.${signature.toString('base64url')}`;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin), json = (status: number, body: object) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, {issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`});
    if (url.pathname === '/jwks') return json(200, {keys: [jwk]});
    if (url.pathname === '/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body), grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      // A real provider checks the client and the PKCE verifier before issuing tokens.
      if (!grant || form.get('client_secret') !== 'client-secret' || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return json(400, {error: 'invalid_grant'});
      return json(200, {id_token: idToken(grant.nonce, grant.tamper), access_token: 'x', token_type: 'Bearer'});
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // What the provider's sign-in page would do after the person approves: issue a code for this request.
  const approve = (authorizeUrl: string, tamper: Tamper = {}) => {
    const q = new URL(authorizeUrl).searchParams, code = randomBytes(12).toString('hex');
    codes.set(code, {challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, tamper});
    return {code, state: q.get('state')!};
  };
  return {get origin() { return origin; }, approve, close: () => new Promise(r => server.close(r))};
}

async function harness(allowedDomains: string[] = []) {
  const idp = await provider(), dataDir = await mkdtemp(join(tmpdir(), 'gapscan-sso-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const sso = createOidc({providers: [{id: 'test', name: 'Acme SSO', issuer: idp.origin, clientId: 'client-1', clientSecret: 'client-secret', trustEmail: false}],
    secret: 'x'.repeat(40), publicUrl: new URL(PUBLIC), allowHttp: true});
  const app = buildApp({infra, auth: {mode: 'magic-link', publicUrl: new URL(PUBLIC), mailer: {send: async () => {}}, allowedDomains, sso}});
  const start = async () => {
    const r = await app.inject({method: 'GET', url: '/v1/auth/sso/test/start'});
    assert.equal(r.statusCode, 302);
    return {location: String(r.headers.location), cookie: String(r.headers['set-cookie']).split(';')[0]!};
  };
  const callback = async (query: Record<string, string>, cookie: string) => {
    const r = await app.inject({method: 'GET', url: `/v1/auth/sso/test/callback?${new URLSearchParams(query)}`, headers: {cookie}});
    return {status: r.statusCode, location: String(r.headers.location), cookies: [r.headers['set-cookie']].flat().map(String)};
  };
  const signIn = async (tamper: Tamper = {}) => { const s = await start(); return callback(idp.approve(s.location, tamper), s.cookie); };
  return {app, infra, idp, start, callback, signIn, close: async () => { await app.close(); await infra.close(); await idp.close(); await rm(dataDir, {recursive: true, force: true}); }};
}

test('signing in with an OpenID Connect provider: PKCE, nonce and a single-use state', async () => {
  const h = await harness();
  try {
    assert.deepEqual(JSON.parse((await h.app.inject({method: 'GET', url: '/v1/auth/providers'})).body), {emailLinks: true, providers: [{id: 'test', name: 'Acme SSO'}]});
    const s = await h.start(), q = new URL(s.location).searchParams;
    assert.equal(new URL(s.location).origin, h.idp.origin);
    assert.deepEqual([q.get('response_type'), q.get('client_id'), q.get('redirect_uri'), q.get('scope'), q.get('code_challenge_method')],
      ['code', 'client-1', `${PUBLIC}/v1/auth/sso/test/callback`, 'openid email profile', 'S256']);
    assert.match(s.cookie, /^gapscan_sso=[\w-]+\.[\w-]+$/);
    const grant = h.idp.approve(s.location);
    const done = await h.callback(grant, s.cookie);
    assert.deepEqual([done.status, done.location], [302, '/app/']);
    const session = done.cookies.find(c => c.startsWith('gapscan_session='))!;
    assert.match(session, /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    const me = JSON.parse((await h.app.inject({method: 'GET', url: '/v1/auth/me', headers: {cookie: session.split(';')[0]!}})).body);
    assert.equal(me.user.email, 'ana@acme.test', 'the verified email, lower-cased');
    const replay = await h.callback(grant, s.cookie);
    assert.equal(replay.location, '/app/signin.html#error=state', 'a replayed callback is refused');
  } finally { await h.close(); }
});

test('sign-in fails safely on tampered, foreign, expired or unverified tokens', async () => {
  const h = await harness();
  try {
    const cases: [Tamper, string][] = [
      [{claims: {aud: 'someone-else'}}, 'token'], [{claims: {iss: 'https://evil.test'}}, 'token'], [{unsigned: true}, 'token'], [{alg: 'HS256'}, 'token'],
      [{badSignature: true}, 'token'], [{claims: {exp: Math.floor(Date.now() / 1000) - 3600}}, 'token'], [{claims: {nonce: 'other'}}, 'token'],
      [{claims: {email_verified: false}}, 'email'], [{claims: {email: undefined}}, 'email'],
    ];
    for (const [tamper, code] of cases) assert.equal((await h.signIn(tamper)).location, `/app/signin.html#error=${code}`, JSON.stringify(tamper));
    const s = await h.start(), grant = h.idp.approve(s.location);
    assert.equal((await h.callback(grant, s.cookie.replace(/\.[\w-]+$/, '.forged'))).location, '/app/signin.html#error=state', 'a forged cookie');
    assert.equal((await h.callback({...grant, state: 'not-mine'}, s.cookie)).location, '/app/signin.html#error=state', 'a state from another sign-in');
    assert.equal((await h.callback({error: 'access_denied', state: grant.state}, s.cookie)).location, '/app/signin.html#error=cancelled');
    const other = await h.start();
    assert.equal((await h.callback(h.idp.approve(s.location), other.cookie)).location, '/app/signin.html#error=state', 'another sign-in’s cookie');
    assert.equal((await h.app.inject({method: 'GET', url: '/v1/auth/sso/nope/start'})).headers.location, '/app/signin.html#error=unknown');
  } finally { await h.close(); }
});

test('the email-domain rule applies to single sign-on too', async () => {
  const h = await harness(['example.org']);
  try { assert.equal((await h.signIn()).location, '/app/signin.html#error=domain'); } finally { await h.close(); }
});

test('settings: providers from the environment, a signing secret, and a Microsoft tenant', () => {
  const base = {GAPSCAN_AUTH: 'magic-link', GAPSCAN_PUBLIC_URL: PUBLIC, GAPSCAN_SECRET: 's'.repeat(40)};
  const google = authSettingsFromEnv({...base, GAPSCAN_SSO_GOOGLE_CLIENT_ID: 'g', GAPSCAN_SSO_GOOGLE_CLIENT_SECRET: 'gs'});
  assert.deepEqual(google.mode === 'magic-link' && google.providers.map(p => [p.id, p.issuer, p.trustEmail]), [['google', 'https://accounts.google.com', false]]);
  assert.throws(() => authSettingsFromEnv({...base, GAPSCAN_SSO_MICROSOFT_CLIENT_ID: 'm', GAPSCAN_SSO_MICROSOFT_CLIENT_SECRET: 'ms', GAPSCAN_SSO_MICROSOFT_TENANT: 'common'}), /tenant/);
  const ms = authSettingsFromEnv({...base, GAPSCAN_SSO_MICROSOFT_CLIENT_ID: 'm', GAPSCAN_SSO_MICROSOFT_CLIENT_SECRET: 'ms', GAPSCAN_SSO_MICROSOFT_TENANT: 'a1b2c3d4-0000-0000-0000-000000000000'});
  assert.equal(ms.mode === 'magic-link' && ms.providers[0]!.issuer, 'https://login.microsoftonline.com/a1b2c3d4-0000-0000-0000-000000000000/v2.0');
  assert.throws(() => authSettingsFromEnv({...base, GAPSCAN_SECRET: 'short', GAPSCAN_SSO_GOOGLE_CLIENT_ID: 'g', GAPSCAN_SSO_GOOGLE_CLIENT_SECRET: 'gs'}), /GAPSCAN_SECRET/);
  assert.throws(() => authSettingsFromEnv({...base, GAPSCAN_SSO_OIDC_ISSUER: 'http://idp.test', GAPSCAN_SSO_OIDC_CLIENT_ID: 'o', GAPSCAN_SSO_OIDC_CLIENT_SECRET: 'os'}), /https/);
  assert.throws(() => authSettingsFromEnv({...base, GAPSCAN_AUTH_EMAIL_LINKS: 'off'}), /at least one single sign-on provider/);
});

test('with email links off, only single sign-on is offered', async () => {
  const h = await harness();
  const app = buildApp({infra: h.infra, auth: {mode: 'magic-link', publicUrl: new URL(PUBLIC), mailer: {send: async () => {}}, allowedDomains: [], emailLinks: false,
    sso: createOidc({providers: [], secret: 'x'.repeat(40), publicUrl: new URL(PUBLIC)})}});
  try {
    assert.equal(JSON.parse((await app.inject({method: 'GET', url: '/v1/auth/providers'})).body).emailLinks, false);
    assert.equal((await app.inject({method: 'POST', url: '/v1/auth/link', payload: {email: 'a@b.test'}})).statusCode, 404);
  } finally { await app.close(); await h.close(); }
});
