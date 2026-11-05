import { NetworkError } from '@microsoft/rayfin-lib';
import type { ConnectionFailureCode, ConnectionRoleAssignment, ConnectionSummary } from '@rayfin-app/shared';
import type { CollectionRuns, ConnectionRoleAssignments, ConnectionSnapshots } from '../../../../rayfin/connectors/connectioninventory/schema';
import { getRayfinClient } from '@/lib/rayfin-client';

export class ConnectionLoadError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | null = null, cause?: unknown) {
    super(message, { cause });
    this.name = 'ConnectionLoadError';
  }
}

const runColumns = ['runId', 'startedAt', 'completedAt', 'status', 'connectionCount', 'roleAssignmentCount', 'ownerLookupFailureCount'] as const;
const connectionColumns = [
  'snapshotId', 'runId', 'connectionId', 'displayName', 'connectivityType', 'sourceType',
  'gatewayId', 'privacyLevel', 'credentialType', 'connectionEncryption', 'createdAt',
  'lastBoundAt', 'lastCredentialUsedAt', 'myLastBoundAt', 'myLastCredentialUsedAt',
  'ownerLookupStatus', 'ownerLookupErrorCode', 'ownerLookupRetryAfterSeconds',
  'endpoint', 'endpointCategory', 'singleSignOnType', 'skipTestConnection',
  'allowUsageInUserControlledCode', 'allowConnectionUsageInGateway',
] as const;
const assignmentColumns = ['snapshotAssignmentId', 'runId', 'connectionId', 'assignmentId', 'principalId', 'principalType', 'principalDisplayName', 'role'] as const;

export type SnapshotRun = Pick<CollectionRuns, typeof runColumns[number]>;
export type SnapshotConnection = Pick<ConnectionSnapshots, typeof connectionColumns[number]>;
export type SnapshotAssignment = Pick<ConnectionRoleAssignments, typeof assignmentColumns[number]>;
type Page<T> = { items: T[]; hasNextPage: boolean; endCursor?: string | null };

export type SnapshotReader = {
  latestRun(): Promise<SnapshotRun | null>;
  connections(runId: string, cursor?: string): Promise<Page<SnapshotConnection>>;
  assignments(runId: string, cursor?: string): Promise<Page<SnapshotAssignment>>;
};

export type ConnectionInventory = {
  connections: ConnectionSummary[];
  runId: string;
  collectedAt: string;
  startedAt: string;
  ownerLookupFailureCount: number;
};

async function connectorReader(): Promise<SnapshotReader> {
  const { connectioninventory: source } = (await getRayfinClient()).connectors;
  return {
    async latestRun() {
      const rows = await source.CollectionRuns.select([...runColumns])
        .where({ status: { eq: 'complete' } })
        .orderBy({ startedAt: 'desc', runId: 'desc' }).first(1).execute();
      return rows[0] ?? null;
    },
    connections(runId, cursor) {
      const query = source.ConnectionSnapshots.select([...connectionColumns])
        .where({ runId: { eq: runId } }).orderBy({ snapshotId: 'asc' }).first(500);
      return (cursor ? query.after(cursor) : query).executePaginated();
    },
    assignments(runId, cursor) {
      const query = source.ConnectionRoleAssignments.select([...assignmentColumns])
        .where({ runId: { eq: runId } }).orderBy({ snapshotAssignmentId: 'asc' }).first(500);
      return (cursor ? query.after(cursor) : query).executePaginated();
    },
  };
}

function inconsistent(): never {
  throw new ConnectionLoadError('The published snapshot is not fully visible or is inconsistent in the SQL endpoint. Wait for synchronization and refresh; no partial snapshot is displayed.');
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') inconsistent();
  return value;
}

function safeEndpointOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) inconsistent();
    return url.origin;
  } catch (error) {
    if (error instanceof ConnectionLoadError) throw error;
    return inconsistent();
  }
}

function iso(value: unknown): string | null {
  // SQL datetime2 has no suffix; the collector writes UTC.
  const date = value instanceof Date ? value
    : typeof value === 'string'
      ? new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function readPages<T>(read: (cursor?: string) => Promise<Page<T>>, expected: number): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < 1000; index++) {
    const page = await read(cursor);
    if (!Array.isArray(page.items) || typeof page.hasNextPage !== 'boolean') inconsistent();
    if (page.items.length > expected - rows.length) inconsistent();
    rows.push(...page.items);
    if (!page.hasNextPage) {
      if (rows.length !== expected) inconsistent();
      return rows;
    }
    if (!page.endCursor || seen.has(page.endCursor)) inconsistent();
    cursor = page.endCursor;
    seen.add(cursor);
  }
  throw new ConnectionLoadError('The snapshot exceeded the connector page limit. No partial snapshot is displayed.');
}

function failureCode(code: string | undefined): ConnectionFailureCode {
  switch (code) {
    case 'permission': case 'rate-limit': case 'timeout': case 'unavailable': case 'invalid-response':
      return code;
    default: return inconsistent();
  }
}

export async function loadConnections(reader?: SnapshotReader): Promise<ConnectionInventory> {
  try {
    const source = reader ?? await connectorReader();
    const run = await source.latestRun();
    if (!run) throw new ConnectionLoadError('No completed inventory snapshot exists. Run CollectConnectionInventory and wait for SQL endpoint synchronization.');
    const collectedAt = iso(run.completedAt);
    const startedAt = iso(run.startedAt);
    if (run.status !== 'complete' || !run.runId || !collectedAt || !startedAt) inconsistent();
    for (const [value, limit] of [[run.connectionCount, 100_000], [run.roleAssignmentCount, 200_000], [run.ownerLookupFailureCount, run.connectionCount]]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
        throw new ConnectionLoadError('The published snapshot has invalid counts or exceeds the dashboard limits. No partial snapshot is displayed.');
      }
    }
    // Pin both table reads to this manifest, even if a new run completes mid-read.
    const [rows, assignments] = await Promise.all([
      readPages((cursor) => source.connections(run.runId, cursor), run.connectionCount),
      readPages((cursor) => source.assignments(run.runId, cursor), run.roleAssignmentCount),
    ]);
    const byId = new Map<string, ConnectionSummary>();
    let failures = 0;
    for (const row of rows) {
      if (row.runId !== run.runId || !row.connectionId || row.snapshotId !== `${run.runId}:${row.connectionId}`
        || byId.has(row.connectionId) || !row.displayName || !row.connectivityType || !row.sourceType
        || !['complete', 'failed'].includes(row.ownerLookupStatus)) inconsistent();
      const retry = row.ownerLookupRetryAfterSeconds ?? null;
      if (retry !== null && (!Number.isSafeInteger(retry) || retry < 0)) inconsistent();
      const ownerStatus = row.ownerLookupStatus === 'complete' ? { ok: true as const } : {
        ok: false as const, code: failureCode(row.ownerLookupErrorCode),
        message: `The collector could not read access assignments (${row.ownerLookupErrorCode}).`,
        retryAfterSeconds: retry,
      };
      if (!ownerStatus.ok) failures++;
      byId.set(row.connectionId, {
        id: row.connectionId, displayName: row.displayName, connectivityType: row.connectivityType,
        sourceType: row.sourceType, gatewayId: row.gatewayId ?? null, privacyLevel: row.privacyLevel ?? null,
        credentialType: row.credentialType ?? null, connectionEncryption: row.connectionEncryption ?? null,
        createdDateTime: iso(row.createdAt), lastBoundDateTime: iso(row.lastBoundAt),
        lastCredentialUsedDateTime: iso(row.lastCredentialUsedAt), myLastBoundDateTime: iso(row.myLastBoundAt),
        myLastCredentialUsedDateTime: iso(row.myLastCredentialUsedAt),
        endpoint: safeEndpointOrigin(row.endpoint), endpointCategory: row.endpointCategory ?? null,
        singleSignOnType: row.singleSignOnType ?? null,
        skipTestConnection: nullableBoolean(row.skipTestConnection),
        allowUsageInUserControlledCode: nullableBoolean(row.allowUsageInUserControlledCode),
        allowConnectionUsageInGateway: nullableBoolean(row.allowConnectionUsageInGateway),
        owners: [], roleAssignments: [], ownerStatus,
      });
    }

    if (failures !== run.ownerLookupFailureCount) inconsistent();
    const assignmentIds = new Set<string>();
    const owners = new Map<string, Set<string>>();
    for (const row of assignments) {
      const connection = byId.get(row.connectionId);
      if (row.runId !== run.runId || !row.assignmentId || !row.principalId || !row.principalType || !row.role
        || row.snapshotAssignmentId !== `${run.runId}:${row.connectionId}:${row.assignmentId}`
        || assignmentIds.has(row.snapshotAssignmentId) || !connection?.ownerStatus.ok) inconsistent();
      assignmentIds.add(row.snapshotAssignmentId);
      const assignment: ConnectionRoleAssignment = {
        id: row.assignmentId, role: row.role,
        principal: { id: row.principalId, type: row.principalType, displayName: row.principalDisplayName ?? null },
      };
      connection.roleAssignments.push(assignment);
      if (row.role === 'Owner') {
        const key = `${row.principalType}:${row.principalId}`;
        const seen = owners.get(row.connectionId) ?? new Set<string>();
        if (!seen.has(key)) connection.owners.push(assignment.principal);
        seen.add(key);
        owners.set(row.connectionId, seen);
      }
    }
    return { connections: [...byId.values()], runId: run.runId, collectedAt, startedAt, ownerLookupFailureCount: failures };
  } catch (error) {
    if (error instanceof ConnectionLoadError) throw error;
    const guidance = error instanceof NetworkError && error.status === 401 ? 'Sign in again; the app session was rejected.'
      : error instanceof NetworkError && error.status === 403 ? 'Check app access and the connector identity permissions on the inventory Lakehouse.'
      : 'Check the deployed connectioninventory connector and its SQL endpoint permissions, then retry.';
    throw new ConnectionLoadError(`The inventory snapshot connector could not read the Lakehouse. ${guidance}`, null, error);
  }
}
