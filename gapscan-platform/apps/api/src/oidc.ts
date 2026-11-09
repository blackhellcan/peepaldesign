// Single sign-on with OpenID Connect (Google, Microsoft Entra ID, or any OIDC provider): the
// authorization-code flow with PKCE. The provider's ID token is verified here (signature against its
// published keys, issuer, audience, nonce, expiry) and only a verified email signs anyone in.
import {createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, constants} from 'node:crypto';
import type {JsonWebKey} from 'node:crypto';

export type OidcProvider = {id: string; name: string; issuer: string; clientId: string; clientSecret: string;
  // Accept the email claim without email_verified: only for a provider tied to one organisation that manages its users' addresses.
  trustEmail: boolean};
export class SsoError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'SsoError'; this.code = code; }
}

// Providers come from settings; a provider without both a client ID and secret is not offered.
export function ssoProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): OidcProvider[] {
  const providers: OidcProvider[] = [];
  if (env.GAPSCAN_SSO_GOOGLE_CLIENT_ID && env.GAPSCAN_SSO_GOOGLE_CLIENT_SECRET)
    providers.push({id: 'google', name: 'Google', issuer: 'https://accounts.google.com', clientId: env.GAPSCAN_SSO_GOOGLE_CLIENT_ID, clientSecret: env.GAPSCAN_SSO_GOOGLE_CLIENT_SECRET, trustEmail: false});
  if (env.GAPSCAN_SSO_MICROSOFT_CLIENT_ID && env.GAPSCAN_SSO_MICROSOFT_CLIENT_SECRET) {
    const tenant = env.GAPSCAN_SSO_MICROSOFT_TENANT ?? '';
    // Multi-tenant endpoints accept any Microsoft account, whose email claim nobody vouches for.
    if (!tenant || /^(common|organizations|consumers)$/i.test(tenant)) throw new Error('GAPSCAN_SSO_MICROSOFT_TENANT must be your directory (tenant) ID, not common, organizations or consumers.');
    providers.push({id: 'microsoft', name: 'Microsoft', issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, clientId: env.GAPSCAN_SSO_MICROSOFT_CLIENT_ID,
      clientSecret: env.GAPSCAN_SSO_MICROSOFT_CLIENT_SECRET, trustEmail: env.GAPSCAN_SSO_MICROSOFT_TRUST_EMAIL === '1'});
  }
  if (env.GAPSCAN_SSO_OIDC_ISSUER && env.GAPSCAN_SSO_OIDC_CLIENT_ID && env.GAPSCAN_SSO_OIDC_CLIENT_SECRET) {
    if (!/^https:\/\//.test(env.GAPSCAN_SSO_OIDC_ISSUER)) throw new Error('GAPSCAN_SSO_OIDC_ISSUER must be an https:// address.');
    providers.push({id: 'oidc', name: env.GAPSCAN_SSO_OIDC_NAME || 'Single sign-on', issuer: env.GAPSCAN_SSO_OIDC_ISSUER.replace(/\/$/, ''), clientId: env.GAPSCAN_SSO_OIDC_CLIENT_ID,
      clientSecret: env.GAPSCAN_SSO_OIDC_CLIENT_SECRET, trustEmail: env.GAPSCAN_SSO_OIDC_TRUST_EMAIL === '1'});
  }
  if (providers.length && (env.GAPSCAN_SECRET ?? '').length < 32) throw new Error('Single sign-on needs GAPSCAN_SECRET: at least 32 random characters, used to sign the short-lived sign-in cookie.');
  return providers;
}

type Discovery = {issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string};
const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const ALGS: Record<string, {hash: string; kty: string; options?: {padding?: number; dsaEncoding?: 'ieee-p1363'}}> = {
  RS256: {hash: 'sha256', kty: 'RSA'}, RS384: {hash: 'sha384', kty: 'RSA'}, RS512: {hash: 'sha512', kty: 'RSA'},
  PS256: {hash: 'sha256', kty: 'RSA', options: {padding: constants.RSA_PKCS1_PSS_PADDING}},
  ES256: {hash: 'sha256', kty: 'EC', options: {dsaEncoding: 'ieee-p1363'}}, ES384: {hash: 'sha384', kty: 'EC', options: {dsaEncoding: 'ieee-p1363'}},
};

export type OidcOptions = {providers: OidcProvider[]; secret: string; publicUrl: URL; fetch?: typeof fetch; allowHttp?: boolean; now?: () => number};
export function createOidc({providers, secret, publicUrl, fetch: fetchImpl = fetch, allowHttp = false, now = () => Date.now()}: OidcOptions) {
  const discovery = new Map<string, {value: Discovery; at: number}>(), keys = new Map<string, {value: JsonWebKey[]; at: number}>();
  const get = async (url: string) => {
    if (!(url.startsWith('https://') || (allowHttp && url.startsWith('http://')))) throw new SsoError('provider', 'The sign-in provider gave an address that is not https.');
    const response = await fetchImpl(url, {signal: AbortSignal.timeout(10_000), headers: {accept: 'application/json'}});
    if (!response.ok) throw new SsoError('provider', `The sign-in provider answered ${response.status}.`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const configOf = async (provider: OidcProvider): Promise<Discovery> => {
    const cached = discovery.get(provider.id);
    if (cached && now() - cached.at < 3_600_000) return cached.value;
    const value = await get(`${provider.issuer}/.well-known/openid-configuration`) as Discovery;
    // The document must describe this issuer, or its tokens can't be checked against it.
    if (value.issuer !== provider.issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) throw new SsoError('provider', 'The sign-in provider’s configuration does not match its address.');
    discovery.set(provider.id, {value, at: now()});
    return value;
  };
  const keysOf = async (config: Discovery, refresh = false) => {
    const cached = keys.get(config.jwks_uri);
    if (cached && !refresh && now() - cached.at < 3_600_000) return cached.value;
    const value = ((await get(config.jwks_uri)).keys ?? []) as JsonWebKey[];
    keys.set(config.jwks_uri, {value, at: now()});
    return value;
  };
  const provider = (id: string) => { const p = providers.find(x => x.id === id); if (!p) throw new SsoError('unknown', 'That sign-in option is not set up.'); return p; };
  const redirectUri = (p: OidcProvider) => new URL(`/v1/auth/sso/${p.id}/callback`, publicUrl).href;
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

  return {
    list: () => providers.map(p => ({id: p.id, name: p.name})),
    // The state is returned for single-use storage; nonce and PKCE verifier ride in a signed cookie.
    async start(id: string) {
      const p = provider(id), config = await configOf(p);
      const state = b64url(randomBytes(24)), nonce = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
      const url = new URL(config.authorization_endpoint);
      for (const [k, v] of Object.entries({response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri(p), scope: 'openid email profile', state, nonce,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account'})) url.searchParams.set(k, v);
      const payload = b64url(JSON.stringify({p: p.id, s: state, n: nonce, v: verifier, e: now() + 600_000}));
      return {url: url.href, state, cookie: `${payload}.${sign(payload)}`};
    },
    // Returns the verified email. Every failure is an SsoError with a message fit to show.
    async finish(id: string, query: {code?: string; state?: string; error?: string}, cookie: string | undefined): Promise<{email: string; state: string}> {
      const p = provider(id);
      if (query.error) throw new SsoError('cancelled', 'Sign-in was cancelled at the provider.');
      const [payload, mac] = (cookie ?? '').split('.');
      const expected = payload ? Buffer.from(sign(payload)) : Buffer.alloc(0), got = Buffer.from(mac ?? '');
      if (!payload || got.length !== expected.length || !timingSafeEqual(got, expected)) throw new SsoError('state', 'This sign-in didn’t start here, or took too long. Start again.');
      const saved = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {p: string; s: string; n: string; v: string; e: number};
      if (saved.p !== p.id || saved.s !== query.state || saved.e < now() || !query.code) throw new SsoError('state', 'This sign-in didn’t start here, or took too long. Start again.');
      const config = await configOf(p);
      const body = new URLSearchParams({grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(p), client_id: p.clientId, client_secret: p.clientSecret, code_verifier: saved.v});
      if (!(config.token_endpoint.startsWith('https://') || (allowHttp && config.token_endpoint.startsWith('http://')))) throw new SsoError('provider', 'The sign-in provider gave an address that is not https.');
      const response = await fetchImpl(config.token_endpoint, {method: 'POST', body, headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'}, signal: AbortSignal.timeout(10_000)});
      const tokens = await response.json().catch(() => ({})) as {id_token?: string};
      if (!response.ok || !tokens.id_token) throw new SsoError('code', 'The sign-in provider didn’t accept this sign-in. Start again.');
      const claims = await verifyIdToken(tokens.id_token, p, config, saved.n);
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
      const verified = claims.email_verified === true || claims.email_verified === 'true' || claims.xms_edov === true || p.trustEmail;
      if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new SsoError('email', 'The provider didn’t share an email address. Allow access to your email and try again.');
      if (!verified) throw new SsoError('email', 'The provider hasn’t verified this email address, so it can’t be used to sign in.');
      return {email, state: saved.s};
    },
  };

  async function verifyIdToken(jwt: string, p: OidcProvider, config: Discovery, nonce: string): Promise<Record<string, unknown>> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new SsoError('token', 'The provider’s sign-in token is malformed.');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as {alg?: string; kid?: string};
    // Only asymmetric algorithms: never "none", never a shared-secret HMAC.
    const alg = ALGS[header.alg ?? ''];
    if (!alg) throw new SsoError('token', 'The provider’s sign-in token uses an algorithm that isn’t accepted.');
    let jwk = (await keysOf(config)).find(k => (k as {kid?: string}).kid === header.kid && k.kty === alg.kty);
    if (!jwk) jwk = (await keysOf(config, true)).find(k => (k as {kid?: string}).kid === header.kid && k.kty === alg.kty);   // keys rotate
    if (!jwk) throw new SsoError('token', 'The provider’s sign-in token was signed with an unknown key.');
    const ok = verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), {key: createPublicKey({key: jwk, format: 'jwk'}), ...alg.options}, Buffer.from(parts[2]!, 'base64url'));
    if (!ok) throw new SsoError('token', 'The provider’s sign-in token failed its signature check.');
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud], t = now() / 1000;
    if (claims.iss !== config.issuer) throw new SsoError('token', 'The sign-in token came from a different issuer.');
    if (!aud.includes(p.clientId) || (aud.length > 1 && claims.azp !== p.clientId)) throw new SsoError('token', 'The sign-in token was issued for a different application.');
    if (typeof claims.exp !== 'number' || claims.exp < t - 60) throw new SsoError('token', 'The sign-in token has expired. Start again.');
    if (typeof claims.iat === 'number' && claims.iat > t + 300) throw new SsoError('token', 'The sign-in token is dated in the future.');
    if (claims.nonce !== nonce) throw new SsoError('token', 'The sign-in token doesn’t belong to this sign-in. Start again.');
    return claims;
  }
}
export type Oidc = ReturnType<typeof createOidc>;
