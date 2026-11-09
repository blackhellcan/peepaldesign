import {configFromEnv, createInfra} from '@gapscan/infra';
import {aiSettingsFromEnv, createClaudeClient} from '@gapscan/drafting';
import {buildApp} from './app.ts';
import {authSettingsFromEnv} from './auth.ts';
import {createMailer} from './mailer.ts';
import {createOidc} from './oidc.ts';

// Settings are checked before anything connects, so a misconfigured deployment stops at once.
const settings = authSettingsFromEnv(), config = configFromEnv(), aiSettings = aiSettingsFromEnv();
const auth = settings.mode === 'off' ? settings : {...settings, mailer: await createMailer({mode: settings.mail, ...(settings.smtpUrl ? {smtpUrl: settings.smtpUrl} : {}), ...(settings.from ? {from: settings.from} : {})}),
  ...(settings.providers.length ? {sso: createOidc({providers: settings.providers, secret: settings.secret, publicUrl: settings.publicUrl})} : {})};
const infra = await createInfra(config);
const app = buildApp({infra, logger: true, auth, ...(aiSettings ? {ai: {...aiSettings, client: createClaudeClient()}} : {})});
const port = Number(process.env.PORT) || 4300, host = process.env.HOST || '127.0.0.1';

const shutdown = async () => { await app.close(); await infra.close(); process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({port, host});
