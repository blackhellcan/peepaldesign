import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openZip} from '@gapscan/adapters';
import {configFromEnv, createInfra} from '@gapscan/infra';
import {buildApp} from '../src/app.ts';

const CSS = ':root{--color-ink-100:#d1d8db;--color-ink-900:#283237;--color-brand-main:#005eff;--color-brand-dark:#2836e0} .btn{background:var(--color-brand-main);color:#fff;padding:8px 16px;border-radius:4px} .btn-outline{border:1px solid #283237}';

test('an extraction reads as a design-system page, and exports to Figma only on request', {timeout: 60_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-ds-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const app = buildApp({infra});
  const get = (url: string) => app.inject({method: 'GET', url});
  try {
    const project = JSON.parse((await app.inject({method: 'POST', url: '/v1/projects', payload: {name: 'Acme'}})).body);
    await app.inject({method: 'POST', url: `/v1/projects/${project.id}/sources`, payload: {kind: 'code', name: 'tokens.css', content: CSS}});
    const {jobId} = JSON.parse((await app.inject({method: 'POST', url: `/v1/projects/${project.id}/extractions`})).body);
    await infra.queue.idle();
    const edsId = JSON.parse((await get(`/v1/jobs/${jobId}`)).body).resultId;

    const doc = JSON.parse((await get(`/v1/extractions/${edsId}/design-system`)).body);
    assert.deepEqual(doc.colors.groups.map((g: {name: string}) => g.name), ['Ink', 'Brand']);

    const page = await get(`/v1/extractions/${edsId}/design-system.html`);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.doesNotMatch(page.body, /<script/i, 'the page has no scripts');
    assert.match(page.body, /<title>Acme design system<\/title>|<title>[^<]+ design system<\/title>/);
    assert.match(page.body, /href="figma-export.json" download>Export to Figma/);

    const plan = await get(`/v1/extractions/${edsId}/figma-export.json`);
    assert.match(String(plan.headers['content-disposition']), /^attachment; filename=".+\.figma\.json"$/);
    assert.equal(JSON.parse(plan.body).format, 'gapscan-figma/1');

    const zip = await get('/v1/figma-plugin.zip');
    assert.equal(zip.headers['content-type'], 'application/zip');
    const archive = openZip(new Uint8Array(zip.rawPayload));
    assert.deepEqual(archive.entries.map(e => e.name).sort(), ['gapscan-importer/code.js', 'gapscan-importer/manifest.json', 'gapscan-importer/ui.html']);
    assert.equal(JSON.parse(archive.read('gapscan-importer/manifest.json').toString()).networkAccess.allowedDomains[0], 'none', 'the plugin fetches nothing');
  } finally { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('saved websites can be looked up, and an extraction can ask to read them again', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-saved-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const app = buildApp({infra});
  try {
    assert.equal((await app.inject({method: 'GET', url: '/v1/saved-sites?url=http://localhost:3000/'})).statusCode, 400, 'only public https addresses');
    assert.deepEqual(JSON.parse((await app.inject({method: 'GET', url: '/v1/saved-sites?url=https://example.com/'})).body), {url: 'https://example.com/', saved: null});
    const project = JSON.parse((await app.inject({method: 'POST', url: '/v1/projects', payload: {name: 'Acme'}})).body);
    await app.inject({method: 'POST', url: `/v1/projects/${project.id}/sources`, payload: {kind: 'code', name: 'a.css', content: '.btn{color:#000}'}});
    const {jobId} = JSON.parse((await app.inject({method: 'POST', url: `/v1/projects/${project.id}/extractions`, payload: {refresh: true}})).body);
    assert.deepEqual((await infra.store.getJob(jobId))?.payload, {refresh: true});
    await infra.queue.idle();
  } finally { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); }
});
