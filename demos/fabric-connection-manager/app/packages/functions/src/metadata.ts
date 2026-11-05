import { AdmissionError, isUuid } from './admission.js';

import { resources } from './resources.generated.js';
export { resources };

export interface SqlTarget { server: string; database: string }
export interface SqlTargets { inventory: SqlTarget; queue: SqlTarget }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdmissionError('INVALID_METADATA');
  }
  return Object.fromEntries(Object.entries(value));
}

function host(value: unknown, suffix: string): string {
  if (typeof value !== 'string' || value.length > 258) {
    throw new AdmissionError('INVALID_METADATA');
  }
  const server = value.endsWith(',1433') ? value.slice(0, -5) : value;
  if (server.length > 253
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(server)
    || server.split('.').some(label => label.length > 63)
    || !server.toLowerCase().endsWith(suffix)) {
    throw new AdmissionError('INVALID_METADATA');
  }
  return server.toLowerCase();
}

export function parseTargets(lakehouse: unknown, database: unknown): SqlTargets {
  const lakehouseProps = object(object(lakehouse).properties);
  const endpoint = object(lakehouseProps.sqlEndpointProperties);
  if (!isUuid(endpoint.id) || endpoint.id.toLowerCase() !== resources.sqlEndpointId) {
    throw new AdmissionError('INVALID_METADATA');
  }
  return {
    inventory: {
      server: host(endpoint.connectionString, '.datawarehouse.fabric.microsoft.com'),
      database: endpoint.id,
    },
    queue: parseQueueTarget(database),
  };
}

export function parseQueueTarget(database: unknown): SqlTarget {
  const databaseProps = object(object(database).properties);
  const databaseName = databaseProps.databaseName;
  if (typeof databaseName !== 'string' || !databaseName.trim() || databaseName.length > 128
    || /[;\u0000-\u001f\u007f]/.test(databaseName)) {
    throw new AdmissionError('INVALID_METADATA');
  }
  return {
    server: host(databaseProps.serverFqdn, '.database.fabric.microsoft.com'),
    database: databaseName,
  };
}

async function readMetadata(token: string, path: string, fetcher: typeof fetch): Promise<unknown> {
  if (typeof token !== 'string' || !token) throw new AdmissionError('RUNTIME_UNAVAILABLE');
  try {
      const response = await fetcher(`https://api.fabric.microsoft.com/v1${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new AdmissionError('METADATA_UNAVAILABLE');
      const text = await response.text();
      if (text.length > 65_536) throw new AdmissionError('METADATA_UNAVAILABLE');
      return JSON.parse(text);
  } catch {
    throw new AdmissionError('METADATA_UNAVAILABLE');
  }
}

export async function discoverQueueTarget(
  token: string, fetcher: typeof fetch = fetch,
): Promise<SqlTarget> {
  return parseQueueTarget(await readMetadata(token,
    `/workspaces/${resources.workspaceId}/sqlDatabases/${resources.sqlDatabaseId}`, fetcher));
}

export async function discoverTargets(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<SqlTargets> {
  const base = `/workspaces/${resources.workspaceId}`;
  const [lakehouse, database] = await Promise.all([
    readMetadata(token, `${base}/lakehouses/${resources.lakehouseId}`, fetcher),
    readMetadata(token, `${base}/sqlDatabases/${resources.sqlDatabaseId}`, fetcher),
  ]);
  return parseTargets(lakehouse, database);
}
