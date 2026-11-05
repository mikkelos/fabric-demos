import {
  deletionActionStatuses,
  validateCancellationRequest,
  type DeletionActionState,
  type DeletionActionsPage,
  type DeletionCancellationInput,
  type DeletionCancellationResult,
} from '@rayfin-app/shared';
import { getRayfinClient } from '@/lib/rayfin-client';
import { functionFailureDiagnostic } from './function-diagnostics';

type PageInput = { afterId: string; watermark: string };
type CancelInput = { selectedRequestIdsJson: string };
export type DeletionActionsReader = (input: PageInput) => Promise<unknown>;
export type DeletionCancellationWriter = (input: CancelInput) => Promise<unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ActionSnapshotChangedError extends Error {}
class ActionResponseError extends Error {}

function statusFailureDiagnostic(cause: unknown): string | null {
  if (cause instanceof ActionResponseError || cause instanceof SyntaxError) {
    return 'getDeletionActions: response validation failed. No partial status or history was accepted.';
  }
  if (cause instanceof ActionSnapshotChangedError) {
    return 'getDeletionActions: cancellation eligibility changed during both reads. Refresh again after pending actions settle.';
  }
  return functionFailureDiagnostic(cause, 'getDeletionActions');
}

export class DeletionActionsLoadError extends Error {
  readonly diagnostic: string | null;

  constructor(cause: unknown) {
    super('Deletion status and history could not be loaded. Refresh before marking or cancelling requests.', { cause });
    this.name = 'DeletionActionsLoadError';
    this.diagnostic = statusFailureDiagnostic(cause);
  }
}

export class DeletionCancellationError extends Error {
  constructor(readonly acknowledgedCount: number, cause: unknown) {
    super(`Cancellation could not be confirmed for the full selection. ${acknowledgedCount} request(s) were confirmed cancelled; the last batch may also have completed. Retry the unchanged selection safely. Requests already processing or processed cannot be cancelled.`, { cause });
    this.name = 'DeletionCancellationError';
  }
}

function record(value: unknown): Record<string, unknown> {
  const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ActionResponseError('Invalid deletion action response.');
  }
  return Object.fromEntries(Object.entries(decoded));
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ActionResponseError('Invalid deletion action identity.');
  return value.toLowerCase();
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new ActionResponseError('Invalid deletion action timestamp.');
  }
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 10) !== value.slice(0, 10)) throw new ActionResponseError('Invalid deletion action date.');
  return normalized;
}

function decodePage(value: unknown): DeletionActionsPage {
  const page = record(value);
  if (typeof page.watermark !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(page.watermark)
    || BigInt(page.watermark) > 9223372036854775807n
    || !Array.isArray(page.actions) || page.actions.length > 500) {
    throw new ActionResponseError('Invalid deletion action page.');
  }
  const actions = page.actions.map((item): DeletionActionState => {
    const row = record(item);
    const status = deletionActionStatuses.find((candidate) => candidate === row.status);
    if (!status || typeof row.connectionName !== 'string' || row.connectionName.length > 1000
      || !Array.isArray(row.pendingRequestIds)) {
      throw new ActionResponseError('Invalid deletion action state.');
    }
    const pendingRequestIds = row.pendingRequestIds.map(identity);
    if (new Set(pendingRequestIds).size !== pendingRequestIds.length
      || (status !== 'pending' && pendingRequestIds.length !== 0)
      || (status !== 'deleted' && row.deletedAt !== null)) {
      throw new ActionResponseError('Inconsistent deletion action state.');
    }
    return {
      connectionId: identity(row.connectionId),
      connectionName: row.connectionName,
      status,
      requestedAt: timestamp(row.requestedAt),
      deletedAt: status === 'deleted' ? timestamp(row.deletedAt) : null,
      pendingRequestIds,
    };
  });
  const nextCursor = page.nextCursor === null ? null : identity(page.nextCursor);
  if (nextCursor !== null && nextCursor !== actions.at(-1)?.connectionId) {
    throw new ActionResponseError('Deletion action cursor does not match the last row.');
  }
  return { actions, watermark: page.watermark, nextCursor };
}

async function readPage(input: PageInput): Promise<unknown> {
  return (await getRayfinClient()).functions.getDeletionActions.invoke(input, { timeoutMs: 120_000 });
}

async function writeCancellation(input: CancelInput): Promise<unknown> {
  return (await getRayfinClient()).functions.cancelDeletionRequests.invoke(input, { timeoutMs: 120_000 });
}

async function readActionsSnapshot(read: DeletionActionsReader): Promise<DeletionActionState[]> {
  const actions: DeletionActionState[] = [];
  const seenConnections = new Set<string>();
  const seenRequests = new Set<string>();
  let cursor = '';
  let watermark = '';
  for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
    const page = decodePage(await read({ afterId: cursor, watermark }));
    if (watermark && page.watermark !== watermark) throw new ActionResponseError('Deletion action watermark changed.');
    watermark = page.watermark;
    for (const action of page.actions) {
      if (action.status === 'pending' && action.pendingRequestIds.length === 0) {
        throw new ActionSnapshotChangedError('Cancellation eligibility changed after the event watermark.');
      }
      if (seenConnections.has(action.connectionId)) throw new ActionResponseError('Duplicate deletion action connection.');
      seenConnections.add(action.connectionId);
      for (const requestId of action.pendingRequestIds) {
        if (seenRequests.has(requestId)) throw new ActionResponseError('Duplicate pending deletion request.');
        seenRequests.add(requestId);
        if (seenRequests.size > 100_000) throw new ActionResponseError('Too many pending deletion requests.');
      }
      actions.push(action);
    }
    if (page.nextCursor === null) return actions;
    if (page.nextCursor === cursor || page.actions.length === 0) throw new ActionResponseError('Deletion action cursor repeated.');
    cursor = page.nextCursor;
  }
  throw new ActionResponseError('Deletion action pagination exceeded its page limit.');
}

export async function loadDeletionActions(read: DeletionActionsReader = readPage): Promise<DeletionActionState[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readActionsSnapshot(read);
    } catch (error) {
      if (error instanceof ActionSnapshotChangedError && attempt === 0) continue;
      throw new DeletionActionsLoadError(error);
    }
  }
  throw new DeletionActionsLoadError(new Error('Deletion action status changed during refresh.'));
}

export async function cancelDeletionRequests(
  input: DeletionCancellationInput,
  write: DeletionCancellationWriter = writeCancellation,
): Promise<DeletionCancellationResult> {
  validateCancellationRequest(input);
  const requestIds = input.requestIds.map((id) => id.toLowerCase()).sort();
  let acknowledgedCount = 0;
  for (let offset = 0; offset < requestIds.length; offset += 500) {
    const batch = requestIds.slice(offset, offset + 500);
    try {
      const result = record(await write({ selectedRequestIdsJson: JSON.stringify(batch) }));
      if (result.cancelledCount !== batch.length) throw new Error('Inconsistent cancellation acknowledgement.');
      acknowledgedCount += batch.length;
    } catch (error) {
      throw new DeletionCancellationError(acknowledgedCount, error);
    }
  }
  return { cancelledCount: acknowledgedCount };
}
