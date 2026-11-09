import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeZip} from '@gapscan/adapters';
import {configFromEnv, createInfra} from '@gapscan/infra';
import {buildApp} from '../src/app.ts';
import {createUsageHandler, githubRepo} from '../src/usage-job.ts';

const SYSTEM = `export interface ButtonProps { kind?: 'primary' | 'ghost'; size?: 'sm' | 'lg'; isBusy?: boolean; disabled?: boolean }
export function Button(props: ButtonProps) { return null; }
export interface ChipProps { tone?: 'success' | 'warning'; removable?: boolean }
export function Chip(props: ChipProps) { return null; }
export interface TextFieldProps { label: string; error?: boolean; disabled?: boolean }
export function TextField(props: TextFieldProps) { return null; }`;
const APP = {
  'acme-main/src/app/settings/page.tsx': `import {Button, TextField} from '@acme/ui';\nexport default () => <form><TextField label="Name" /><Button kind="primary" isBusy>Save</Button><Button kind="ghost">Cancel</Button></form>;`,
  'acme-main/src/app/home/page.tsx': `import {Button} from '@acme/ui';\nexport default () => <Button>Go</Button>;`,
  'acme-main/node_modules/x/index.js': `<Button/>`,
};

test('GitHub links parse; anything else is not a repository', () => {
  assert.deepEqual(githubRepo('https://github.com/acme/web'), {owner: 'acme', repo: 'web'});
  assert.deepEqual(githubRepo('https://github.com/acme/web.git'), {owner: 'acme', repo: 'web'});
  assert.deepEqual(githubRepo('https://github.com/acme/web/tree/release/2.0'), {owner: 'acme', repo: 'web', branch: 'release/2.0'});
  assert.equal(githubRepo('https://gitlab.com/acme/web'), null);
});

test('usage scan of a zipped app feeds GapScan: unused components drop out and call sites are priced', {timeout: 60_000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-usage-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const app = buildApp({infra});
  const json = async (method: string, url: string, payload?: object) => { const r = await app.inject({method: method as 'GET', url, ...(payload ? {payload} : {})}); return {status: r.statusCode, body: JSON.parse(r.body)}; };
  try {
    const project = (await json('POST', '/v1/projects', {name: 'Acme'})).body;
    await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'code', name: 'ui.tsx', content: SYSTEM});
    await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'file', name: 'acme-app.zip', role: 'application', base64: writeZip(APP).toString('base64')});
    assert.equal((await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'url', uri: 'https://example.com/app', role: 'application'})).status, 400, 'application links must be GitHub repositories');
    const {jobId} = (await json('POST', `/v1/projects/${project.id}/extractions`)).body;
    await infra.queue.idle();
    const edsId = (await json('GET', `/v1/jobs/${jobId}`)).body.resultId;
    const eds = (await json('GET', `/v1/extractions/${edsId}?include=full`)).body;
    assert.ok(!eds.evidence.some((e: {locator: string}) => /page\.tsx/.test(e.locator)), 'application code is not part of the design system');

    const usageJob = (await json('POST', `/v1/projects/${project.id}/usage`, {edsId})).body;
    await infra.queue.idle();
    assert.equal((await json('GET', `/v1/jobs/${usageJob.jobId}`)).body.status, 'completed');
    const usage = (await json('GET', `/v1/projects/${project.id}/usage`)).body;
    assert.equal(usage.filesScanned, 2, 'node_modules skipped, archive folder stripped');
    assert.equal(usage.screens, 2);
    const button = usage.components.find((c: {component: string}) => c.component === 'Button');
    assert.equal(button.usages, 3);
    assert.deepEqual(button.propUsages, {kind: 2, isBusy: 1});
    assert.equal(usage.components.find((c: {component: string}) => c.component === 'Chip').usages, 0);

    const scan = (await json('POST', '/v1/gapscans', {edsId, referenceId: 'mui-6.4.7'})).body;
    await infra.queue.idle();
    const report = (await json('GET', `/v1/gapscans/${(await json('GET', `/v1/jobs/${scan.jobId}`)).body.resultId}`)).body;
    assert.equal(report.items.find((i: {name: string}) => i.name === 'Button').usage.usages, 3);
    assert.ok(report.totals.consumer, 'consumer hours are part of the totals');
    assert.equal(report.totals.consumer.unusedExcluded, 1, 'Chip is not used, so it is not required work');
    assert.match(report.exclusions[1], /not used in the scanned application \(2 files\)/);

    // Codemod: approve the Button match, dry-run on the zipped app, download the script.
    const buttonItem = report.items.find((i: {name: string}) => i.name === 'Button');
    if (buttonItem.match.status !== 'confirmed') await json('PUT', `/v1/gapscans/${report.id}/matches/${buttonItem.match.sourceId}`, {targetId: buttonItem.match.targetId, by: 'lead@example.com'});
    const rules = (await json('GET', `/v1/gapscans/${report.id}/codemod/rules`)).body;
    assert.equal(rules.rules.components.find((c: {component: string}) => c.component === 'Button').jsx.package, '@mui/material');
    assert.equal((await json('GET', `/v1/gapscans/${report.id}/codemod`)).status, 404, 'no dry run yet');
    const codemodJob = (await json('POST', `/v1/gapscans/${report.id}/codemod`)).body;
    await infra.queue.idle();
    assert.equal((await json('GET', `/v1/jobs/${codemodJob.jobId}`)).body.status, 'completed');
    const run = (await json('GET', `/v1/gapscans/${report.id}/codemod`)).body;
    assert.deepEqual(run.files.map((f: {path: string}) => f.path), ['src/app/home/page.tsx', 'src/app/settings/page.tsx'], 'node_modules is never rewritten');
    const settings = run.files[1];
    assert.match(settings.diff, /\+import \{Button, TextField\} from '@mui\/material';/);
    assert.match(settings.diff, /\+.*<Button color="primary" loading>Save<\/Button><Button variant="text">Cancel<\/Button>/);
    assert.equal(run.hash, rules.hash);
    const script = await app.inject({method: 'GET', url: `/v1/gapscans/${report.id}/codemod.mjs`});
    assert.match(String(script.headers['content-type']), /^text\/javascript/);
    assert.match(String(script.headers['content-disposition']), /attachment; filename="gapscan-codemod.mjs"/);
    assert.ok(script.body.includes(`rules ${rules.hash}`));
  } finally { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); }
});

test('public GitHub repositories are downloaded through the network guard, following the default branch', async () => {
  const requests: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    requests.push(String(url));
    if (String(url) === 'https://api.github.com/repos/acme/web') return new Response(JSON.stringify({default_branch: 'trunk'}), {status: 200});
    if (String(url) === 'https://codeload.github.com/acme/web/zip/refs/heads/trunk') return new Response(writeZip(APP), {status: 200});
    return new Response('{}', {status: 404});
  }) as typeof fetch;
  const dataDir = await mkdtemp(join(tmpdir(), 'gapscan-gh-'));
  const infra = await createInfra({...configFromEnv({}), dataDir});
  const guarded: string[] = [];
  const handler = createUsageHandler({store: infra.store, blobs: infra.blobs, fetch: fakeFetch, allowUrl: async url => { guarded.push(url.hostname); return true; }});
  infra.queue.register('usage', handler);
  const app = buildApp({infra, handlers: {usage: handler}});
  const json = async (method: string, url: string, payload?: object) => { const r = await app.inject({method: method as 'GET', url, ...(payload ? {payload} : {})}); return {status: r.statusCode, body: JSON.parse(r.body)}; };
  try {
    const project = (await json('POST', '/v1/projects', {name: 'Acme'})).body;
    await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'code', name: 'ui.tsx', content: SYSTEM});
    await json('POST', `/v1/projects/${project.id}/sources`, {kind: 'url', uri: 'https://github.com/acme/web', role: 'application'});
    const {jobId} = (await json('POST', `/v1/projects/${project.id}/extractions`)).body;
    await infra.queue.idle();
    const edsId = (await json('GET', `/v1/jobs/${jobId}`)).body.resultId;
    await json('POST', `/v1/projects/${project.id}/usage`, {edsId});
    await infra.queue.idle();
    const usage = (await json('GET', `/v1/projects/${project.id}/usage`)).body;
    assert.equal(usage.components.find((c: {component: string}) => c.component === 'Button').usages, 3);
    assert.deepEqual(requests, ['https://api.github.com/repos/acme/web', 'https://codeload.github.com/acme/web/zip/refs/heads/trunk']);
    assert.deepEqual(guarded, ['api.github.com', 'codeload.github.com'], 'every host passes the network guard');
  } finally { await app.close(); await infra.close(); await rm(dataDir, {recursive: true, force: true}); }
});
