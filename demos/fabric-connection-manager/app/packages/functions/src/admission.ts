export type FailureCode =
  | 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'IDENTITY_UNAVAILABLE'
  | 'METADATA_UNAVAILABLE' | 'INVALID_METADATA' | 'SNAPSHOT_UNAVAILABLE'
  | 'SNAPSHOT_CHANGED' | 'SNAPSHOT_STALE' | 'SNAPSHOT_INCOMPLETE'
  | 'SELECTION_MISMATCH' | 'LOGGING_UNAVAILABLE' | 'INVALID_MARKED_COUNT'
  | 'RUNTIME_UNAVAILABLE' | 'ACTIONS_UNAVAILABLE' | 'INVALID_ACTIONS_RESULT'
  | 'CANCELLATION_UNAVAILABLE' | 'CANCELLATION_CONFLICT' | 'INVALID_CANCELLATION_COUNT'
  | 'ACTIVE_REQUEST_EXISTS';

export class AdmissionError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = 'AdmissionError';
  }
}

export const maxRequesterLength = 2048;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);

export interface DeletionInput {
  requestId: string;
  snapshotRunId: string;
  selectedIdsJson: string;
}

export interface ConnectionBaseline {
  connectionId: string;
  displayName: string;
  connectivityType: string;
  sourceType: string;
  createdAt: string | null;
  lastBoundAt: string | null;
  lastCredentialUsedAt: string | null;
}

export interface Snapshot {
  runId: string;
  startedAt: string;
  completedAt: string;
  expectedCount: number;
  actualCount: number;
  uniqueCount: number;
  connections: ConnectionBaseline[];
}

export interface LogBatch {
  batchId: string;
  snapshotRunId: string;
  requestedBy: string;
  connections: ConnectionBaseline[];
}

export interface AdmissionDependencies {
  requester(): Promise<string>;
  snapshot(ids: readonly string[]): Promise<Snapshot | null>;
  log(batch: LogBatch): Promise<unknown>;
  now(): number;
}

export function validateInput(input: DeletionInput): {
  requestId: string; snapshotRunId: string; ids: string[];
} {
  if (!isUuid(input.requestId) || !isUuid(input.snapshotRunId)
    || typeof input.selectedIdsJson !== 'string' || input.selectedIdsJson.length > 20_000) {
    throw new AdmissionError('INVALID_REQUEST');
  }
  return {
    requestId: input.requestId.toLowerCase(),
    snapshotRunId: input.snapshotRunId.toLowerCase(),
    ids: validateSelectedIds(input.selectedIdsJson),
  };
}

export function validateSelectedIds(json: string): string[] {
  if (typeof json !== 'string' || json.length > 20_000) throw new AdmissionError('INVALID_REQUEST');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new AdmissionError('INVALID_REQUEST');
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new AdmissionError('INVALID_REQUEST');
  }
  const ids: string[] = [];
  for (const id of value) {
    if (!isUuid(id)) throw new AdmissionError('INVALID_REQUEST');
    ids.push(id.toLowerCase());
  }
  if (new Set(ids).size !== ids.length) throw new AdmissionError('INVALID_REQUEST');
  return ids;
}

export async function admitDeletion(
  input: DeletionInput,
  deps: AdmissionDependencies,
): Promise<{ requestId: string; markedCount: number }> {
  const request = validateInput(input);
  const requestedBy = await deps.requester();
  if (typeof requestedBy !== 'string' || requestedBy.trim() !== requestedBy
    || requestedBy.length === 0 || requestedBy.length > maxRequesterLength
    || /[\u0000-\u001f\u007f]/.test(requestedBy)) {
    throw new AdmissionError('UNAUTHENTICATED');
  }
  const snapshot = await deps.snapshot(request.ids);
  if (!snapshot) throw new AdmissionError('SNAPSHOT_UNAVAILABLE');
  if (!isUuid(snapshot.runId) || snapshot.runId.toLowerCase() !== request.snapshotRunId) {
    throw new AdmissionError('SNAPSHOT_CHANGED');
  }
  const startedAt = Date.parse(snapshot.startedAt);
  const completedAt = Date.parse(snapshot.completedAt);
  const now = deps.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
    || startedAt > completedAt || completedAt > now || startedAt > now
    || now - startedAt > 7 * 24 * 60 * 60 * 1000) {
    throw new AdmissionError('SNAPSHOT_STALE');
  }
  if (![snapshot.expectedCount, snapshot.actualCount, snapshot.uniqueCount]
    .every(count => Number.isSafeInteger(count) && count >= 0)
    || snapshot.expectedCount !== snapshot.actualCount
    || snapshot.actualCount !== snapshot.uniqueCount) {
    throw new AdmissionError('SNAPSHOT_INCOMPLETE');
  }
  const selected = new Set(request.ids);
  if (snapshot.connections.length !== selected.size) throw new AdmissionError('SELECTION_MISMATCH');
  for (const row of snapshot.connections) {
    if (!isUuid(row.connectionId) || !selected.delete(row.connectionId.toLowerCase())
      || typeof row.displayName !== 'string' || row.displayName.length > 1000
      || typeof row.connectivityType !== 'string' || row.connectivityType.length > 200
      || typeof row.sourceType !== 'string' || row.sourceType.length > 200
      || ![row.createdAt, row.lastBoundAt, row.lastCredentialUsedAt]
        .every(value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value))))) {
      throw new AdmissionError('SELECTION_MISMATCH');
    }
  }
  if (selected.size !== 0) throw new AdmissionError('SELECTION_MISMATCH');
  const markedCount = await deps.log({
    batchId: request.requestId,
    snapshotRunId: request.snapshotRunId,
    requestedBy,
    connections: snapshot.connections.map(row => ({
      connectionId: row.connectionId.toLowerCase(),
      displayName: row.displayName,
      connectivityType: row.connectivityType,
      sourceType: row.sourceType,
      createdAt: row.createdAt,
      lastBoundAt: row.lastBoundAt,
      lastCredentialUsedAt: row.lastCredentialUsedAt,
    })),
  });
  if (typeof markedCount !== 'number' || !Number.isSafeInteger(markedCount)
    || markedCount !== request.ids.length) {
    throw new AdmissionError('INVALID_MARKED_COUNT');
  }
  return { requestId: request.requestId, markedCount };
}
