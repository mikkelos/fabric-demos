import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const resourceVariables = {
  workspaceId: 'CONNECTION_MANAGER_WORKSPACE_ID',
  lakehouseId: 'CONNECTION_MANAGER_LAKEHOUSE_ID',
  sqlEndpointId: 'CONNECTION_MANAGER_SQL_ENDPOINT_ID',
  sqlDatabaseId: 'CONNECTION_MANAGER_SQL_DATABASE_ID',
};

export async function loadDeploymentConfig({ root = appRoot, env = process.env } = {}) {
  const envPath = path.resolve(root, env.RAYFIN_ENV_FILE || 'rayfin/.env');
  let fileValues;
  try {
    fileValues = parseEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read deployment environment file.', { cause: error });
    fileValues = {};
  }
  const values = { ...fileValues, ...env };
  const result = {};
  for (const [field, variable] of Object.entries(resourceVariables)) {
    const value = values[variable];
    if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      || value === '00000000-0000-0000-0000-000000000000') {
      throw new Error(`Set ${variable} to a nonzero resource UUID in the deployment environment.`);
    }
    result[field] = value.toLowerCase();
  }
  const origin = values.CONNECTION_MANAGER_APP_ORIGIN || 'http://localhost:5173';
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('CONNECTION_MANAGER_APP_ORIGIN must be an HTTPS origin or a local development origin.');
  }
  if (url.origin !== origin || url.hostname.includes('*') || url.username || url.password
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('CONNECTION_MANAGER_APP_ORIGIN must be an HTTPS origin or a local development origin.');
  }
  return { ...result, appOrigin: origin };
}

async function writeChanged(destination, content) {
  let previous;
  try {
    previous = await readFile(destination, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== content) await writeFile(destination, content, { encoding: 'utf8', mode: 0o600 });
}

export async function prepareDeployment({ root = appRoot, env = process.env } = {}) {
  const { appOrigin, ...resources } = await loadDeploymentConfig({ root, env });
  const template = await readFile(path.join(root, 'rayfin', 'rayfin.template.yml'), 'utf8');
  const values = { ...Object.fromEntries(Object.entries(resourceVariables).map(([key, variable]) =>
    [variable, resources[key]])), CONNECTION_MANAGER_APP_ORIGIN: appOrigin };
  const yaml = template.replace(/\$\{(CONNECTION_MANAGER_[A-Z_]+)\}/g, (_, variable) => {
    if (!(variable in values)) throw new Error(`Unknown deployment variable ${variable}.`);
    return values[variable];
  });
  if (yaml.includes('${CONNECTION_MANAGER_')) throw new Error('Unresolved deployment configuration.');
  await writeChanged(path.join(root, 'packages', 'functions', 'src', 'resources.generated.ts'),
    `// Generated from local deployment configuration. Do not commit.\nexport const resources = ${JSON.stringify(resources, null, 2)} as const;\n`);
  await writeChanged(path.join(root, 'rayfin', 'rayfin.yml'), yaml);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await prepareDeployment();
    console.log('Deployment configuration generated (values omitted).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
