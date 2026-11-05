import sql from 'mssql';
import type { DeletionActionsPage, DeletionActionStatus } from '@rayfin-app/shared';
import { AdmissionError, isUuid, maxRequesterLength, type ConnectionBaseline, type LogBatch, type Snapshot } from './admission.js';
import { validateActionCursor, type ActionCursor } from './actions.js';
import { object, type SqlTarget } from './metadata.js';

export const snapshotQuery = `
WITH latest AS (
    SELECT TOP (1) run_id, started_at, completed_at, connection_count
    FROM inventory.collection_runs
    WHERE status = 'complete'
    ORDER BY started_at DESC, run_id DESC
), counts AS (
    SELECT c.run_id, COUNT_BIG(*) AS actual_count,
        COUNT_BIG(DISTINCT c.connection_id) AS unique_count
    FROM inventory.connection_snapshots c
    INNER JOIN latest r ON r.run_id = c.run_id
    GROUP BY c.run_id
)
SELECT r.run_id, r.started_at, r.completed_at, r.connection_count,
    COALESCE(n.actual_count, 0) AS actual_count, COALESCE(n.unique_count, 0) AS unique_count,
    c.connection_id, c.display_name, c.connectivity_type, c.source_type,
    c.created_at, c.last_bound_at, c.last_credential_used_at
FROM latest r
LEFT JOIN counts n ON n.run_id = r.run_id
LEFT JOIN inventory.connection_snapshots c ON c.run_id = r.run_id
    AND LOWER(c.connection_id) IN (SELECT [value] FROM OPENJSON(@ConnectionIdsJson));`;

function timestamp(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new AdmissionError('SNAPSHOT_INCOMPLETE');
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new AdmissionError('SNAPSHOT_INCOMPLETE');
  return value;
}

function count(value: unknown): number {
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
    throw new AdmissionError('SNAPSHOT_INCOMPLETE');
  }
  return result;
}

export function decodeSnapshot(rows: readonly unknown[]): Snapshot | null {
  if (rows.length === 0) return null;
  const first = object(rows[0]);
  const connections: ConnectionBaseline[] = [];
  for (const value of rows) {
    const row = object(value);
    if (row.connection_id === null) continue;
    connections.push({
      connectionId: text(row.connection_id),
      displayName: text(row.display_name),
      connectivityType: text(row.connectivity_type),
      sourceType: text(row.source_type),
      createdAt: row.created_at === null ? null : timestamp(row.created_at),
      lastBoundAt: row.last_bound_at === null ? null : timestamp(row.last_bound_at),
      lastCredentialUsedAt: row.last_credential_used_at === null ? null : timestamp(row.last_credential_used_at),
    });
  }
  return {
    runId: text(first.run_id),
    startedAt: timestamp(first.started_at),
    completedAt: timestamp(first.completed_at),
    expectedCount: count(first.connection_count),
    actualCount: count(first.actual_count),
    uniqueCount: count(first.unique_count),
    connections,
  };
}

export function sqlConfig(target: SqlTarget, token: string): sql.config {
  if (typeof token !== 'string' || !token) throw new AdmissionError('RUNTIME_UNAVAILABLE');
  return {
    server: target.server,
    database: target.database,
    port: 1433,
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
  };
}

async function withPool<T>(
  target: SqlTarget, token: string, operation: (pool: sql.ConnectionPool) => Promise<T>,
): Promise<T> {
  const pool = new sql.ConnectionPool(sqlConfig(target, token));
  try {
    await pool.connect();
    return await operation(pool);
  } finally {
    await pool.close();
  }
}

export async function readSnapshot(
  target: SqlTarget, token: string, ids: readonly string[],
): Promise<Snapshot | null> {
  try {
    return await withPool(target, token, async pool => {
      const result = await pool.request()
        .input('ConnectionIdsJson', sql.NVarChar(sql.MAX), JSON.stringify(ids))
        .query<Record<string, unknown>>(snapshotQuery);
      return decodeSnapshot(result.recordset);
    });
  } catch {
    throw new AdmissionError('SNAPSHOT_UNAVAILABLE');
  }
}

export async function logRequests(target: SqlTarget, token: string, batch: LogBatch): Promise<unknown> {
  try {
    return await withPool(target, token, async pool => {
      const result = await pool.request()
        .input('BatchId', sql.UniqueIdentifier, batch.batchId)
        .input('SnapshotRunId', sql.UniqueIdentifier, batch.snapshotRunId)
        .input('RequestedBy', sql.NVarChar(maxRequesterLength), batch.requestedBy)
        .input('ConnectionsJson', sql.NVarChar(sql.MAX), JSON.stringify(batch.connections))
        .execute<Record<string, unknown>>('operations.LogDeletionRequests');
      if (result.recordset?.length !== 1) throw new AdmissionError('INVALID_MARKED_COUNT');
      return result.recordset[0].marked_count;
    });
  } catch (error) {
    if (error instanceof AdmissionError && error.code === 'INVALID_MARKED_COUNT') throw error;
    if (sqlErrorNumber(error) === 50006) throw new AdmissionError('ACTIVE_REQUEST_EXISTS');
    throw new AdmissionError('LOGGING_UNAVAILABLE');
  }
}

function sqlErrorNumber(error: unknown): unknown {
  return error && typeof error === 'object' && 'number' in error ? error.number : undefined;
}

function actionStatus(value: unknown): DeletionActionStatus {
  if (value === 'pending' || value === 'processing' || value === 'reconcile'
    || value === 'deleted' || value === 'cancelled') return value;
  throw new AdmissionError('INVALID_ACTIONS_RESULT');
}

function actionIds(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 20_000) throw new AdmissionError('INVALID_ACTIONS_RESULT');
  let ids: unknown;
  try {
    ids = JSON.parse(value);
  } catch {
    throw new AdmissionError('INVALID_ACTIONS_RESULT');
  }
  if (!Array.isArray(ids) || ids.length > 500) throw new AdmissionError('INVALID_ACTIONS_RESULT');
  const result: string[] = [];
  for (const id of ids) {
    if (!isUuid(id)) throw new AdmissionError('INVALID_ACTIONS_RESULT');
    result.push(id.toLowerCase());
  }
  if (new Set(result).size !== result.length) throw new AdmissionError('INVALID_ACTIONS_RESULT');
  return result;
}

export function decodeActions(headerRows: readonly unknown[], actionRows: readonly unknown[]): DeletionActionsPage {
  try {
    if (headerRows.length !== 1 || actionRows.length > 500) throw new AdmissionError('INVALID_ACTIONS_RESULT');
    const header = object(headerRows[0]);
    const watermark = text(header.watermark);
    validateActionCursor('', watermark);
    if (watermark === '') throw new AdmissionError('INVALID_ACTIONS_RESULT');
    const nextCursor = header.next_cursor === null ? null : text(header.next_cursor).toLowerCase();
    if (nextCursor !== null && !isUuid(nextCursor)) throw new AdmissionError('INVALID_ACTIONS_RESULT');
    const seen = new Set<string>();
    const actions = actionRows.map(value => {
      const row = object(value);
      const connectionId = text(row.connection_id).toLowerCase();
      if (!isUuid(connectionId) || seen.has(connectionId)) throw new AdmissionError('INVALID_ACTIONS_RESULT');
      seen.add(connectionId);
      const status = actionStatus(row.status);
      const pendingRequestIds = actionIds(row.pending_request_ids_json);
      const connectionName = text(row.connection_name);
      const deletedAt = row.deleted_at === null ? null : timestamp(row.deleted_at);
      if (connectionName.length > 1000 || (status !== 'pending' && pendingRequestIds.length !== 0)
        || (status === 'deleted') !== (deletedAt !== null)) {
        throw new AdmissionError('INVALID_ACTIONS_RESULT');
      }
      return {
        connectionId, connectionName, status, requestedAt: timestamp(row.requested_at), deletedAt, pendingRequestIds,
      };
    });
    if (nextCursor !== null && (actions.length !== 500 || actions.at(-1)?.connectionId !== nextCursor)) {
      throw new AdmissionError('INVALID_ACTIONS_RESULT');
    }
    return { actions, watermark, nextCursor };
  } catch {
    throw new AdmissionError('INVALID_ACTIONS_RESULT');
  }
}

export async function readActions(
  target: SqlTarget, token: string, cursor: ActionCursor,
): Promise<DeletionActionsPage> {
  try {
    return await withPool(target, token, async pool => {
      const result = await pool.request()
        .input('AfterId', sql.UniqueIdentifier, cursor.afterId)
        .input('Watermark', sql.BigInt, cursor.watermark)
        .execute<Record<string, unknown>>('operations.GetDeletionActions');
      const recordsets = result.recordsets;
      if (!Array.isArray(recordsets) || recordsets.length !== 2) throw new AdmissionError('INVALID_ACTIONS_RESULT');
      const page = decodeActions(recordsets[0], recordsets[1]);
      if (cursor.watermark !== null && page.watermark !== cursor.watermark) {
        throw new AdmissionError('INVALID_ACTIONS_RESULT');
      }
      return page;
    });
  } catch (error) {
    if (error instanceof AdmissionError && error.code === 'INVALID_ACTIONS_RESULT') throw error;
    throw new AdmissionError('ACTIONS_UNAVAILABLE');
  }
}

export async function cancelRequests(
  target: SqlTarget, token: string, ids: readonly string[], requestedBy: string,
): Promise<unknown> {
  try {
    return await withPool(target, token, async pool => {
      const result = await pool.request()
        .input('RequestedBy', sql.NVarChar(maxRequesterLength), requestedBy)
        .input('RequestIdsJson', sql.NVarChar(sql.MAX), JSON.stringify(ids))
        .execute<Record<string, unknown>>('operations.CancelDeletionRequests');
      if (result.recordset?.length !== 1) throw new AdmissionError('INVALID_CANCELLATION_COUNT');
      return result.recordset[0].cancelled_count;
    });
  } catch (error) {
    if (error instanceof AdmissionError && error.code === 'INVALID_CANCELLATION_COUNT') throw error;
    if (sqlErrorNumber(error) === 50005) throw new AdmissionError('CANCELLATION_CONFLICT');
    throw new AdmissionError('CANCELLATION_UNAVAILABLE');
  }
}
