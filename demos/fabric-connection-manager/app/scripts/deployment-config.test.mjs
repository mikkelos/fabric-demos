import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { loadDeploymentConfig, prepareDeployment, resourceVariables } from './deployment-config.mjs';

const directories = [];
const ids = Object.fromEntries(Object.keys(resourceVariables).map((field, index) =>
  [field, `${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`]));
const variables = Object.fromEntries(Object.entries(resourceVariables).map(([field, variable]) =>
  [variable, ids[field]]));

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connection-manager-config-'));
  directories.push(root);
  await mkdir(path.join(root, 'rayfin'));
  await mkdir(path.join(root, 'packages', 'functions', 'src'), { recursive: true });
  await writeFile(path.join(root, 'rayfin', '.env'),
    Object.entries(variables).map(([key, value]) => `${key}=${value}`).join('\n'));
  await writeFile(path.join(root, 'rayfin', 'rayfin.template.yml'),
    'workspace: ${CONNECTION_MANAGER_WORKSPACE_ID}\nendpoint: ${CONNECTION_MANAGER_SQL_ENDPOINT_ID}\norigin: ${CONNECTION_MANAGER_APP_ORIGIN}\n');
  return root;
}

test('reads ignored env values and normalizes resource IDs without logging them', async () => {
  const root = await fixture();
  assert.deepEqual(await loadDeploymentConfig({ root, env: {} }),
    { ...ids, appOrigin: 'http://localhost:5173' });
});

test('shell values override the selected env file; custom relative paths resolve from app root', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'alternate.env'), Object.entries(variables)
    .map(([key, value]) => `${key}=${value.toUpperCase()}`).join('\n'));
  const config = await loadDeploymentConfig({ root, env: {
    RAYFIN_ENV_FILE: 'alternate.env', CONNECTION_MANAGER_WORKSPACE_ID: ids.sqlDatabaseId,
  } });
  assert.equal(config.workspaceId, ids.sqlDatabaseId);
  assert.equal(config.sqlEndpointId, ids.sqlEndpointId);
});

test('supports a file-free CI environment with all variables explicitly supplied', async () => {
  const root = await fixture();
  assert.deepEqual(await loadDeploymentConfig({ root, env: {
    ...variables, RAYFIN_ENV_FILE: 'missing.env',
  } }), { ...ids, appOrigin: 'http://localhost:5173' });
});

for (const variable of Object.values(resourceVariables)) {
  for (const value of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', '../other']) {
    test(`rejects missing or malformed ${variable} without disclosing its value (${value.length})`, async () => {
      const root = await fixture();
      await assert.rejects(loadDeploymentConfig({ root, env: { [variable]: value } }),
        { message: `Set ${variable} to a nonzero resource UUID in the deployment environment.` });
    });
  }
}

for (const origin of ['https://app.example.test/path', 'https://user:password@app.example.test',
  'http://remote.example.test', 'https://app.example.test?query=private', 'not-a-url', 'https://*.example.test']) {
  test(`rejects unsafe or non-origin redirect input (${origin.length})`, async () => {
    const root = await fixture();
    await assert.rejects(loadDeploymentConfig({ root, env: { CONNECTION_MANAGER_APP_ORIGIN: origin } }),
      /CONNECTION_MANAGER_APP_ORIGIN must be/);
  });
}

test('generates server-only resource constants and resolved local YAML from a value-free template', async () => {
  const root = await fixture();
  const env = { CONNECTION_MANAGER_APP_ORIGIN: 'https://app.example.test' };
  await prepareDeployment({ root, env });
  const generated = await readFile(path.join(root, 'packages', 'functions', 'src', 'resources.generated.ts'), 'utf8');
  assert.ok(generated.includes(JSON.stringify(ids, null, 2)));
  assert.ok(!generated.includes('appOrigin'));
  const yaml = await readFile(path.join(root, 'rayfin', 'rayfin.yml'), 'utf8');
  assert.ok(yaml.includes(ids.workspaceId));
  assert.ok(yaml.includes(ids.sqlEndpointId));
  assert.ok(yaml.includes('https://app.example.test'));
  assert.ok(!yaml.includes('${'));
  const template = await readFile(path.join(root, 'rayfin', 'rayfin.template.yml'), 'utf8');
  assert.ok(template.includes('${CONNECTION_MANAGER_WORKSPACE_ID}'));
  assert.ok(!template.includes(ids.workspaceId));
});

test('invalid input fails before replacing a previously generated deployment', async () => {
  const root = await fixture();
  await prepareDeployment({ root, env: {} });
  const file = path.join(root, 'packages', 'functions', 'src', 'resources.generated.ts');
  const before = await readFile(file, 'utf8');
  await assert.rejects(prepareDeployment({ root, env: { CONNECTION_MANAGER_WORKSPACE_ID: '' } }));
  assert.equal(await readFile(file, 'utf8'), before);
});
