import type { DeletionActionsPage, DeletionCancellationResult } from '@rayfin-app/shared';
import { AdmissionError, isUuid, validateSelectedIds } from './admission.js';

export interface ActionCursor { afterId: string | null; watermark: string | null }
const maxBigInt = 9_223_372_036_854_775_807n;

export function validateActionCursor(afterId: string, watermark: string): ActionCursor {
  if (typeof afterId !== 'string' || typeof watermark !== 'string'
    || (afterId !== '' && !isUuid(afterId))
    || (afterId !== '' && watermark === '')
    || (watermark !== '' && (!/^(0|[1-9][0-9]{0,18})$/.test(watermark)
      || BigInt(watermark) > maxBigInt))) {
    throw new AdmissionError('INVALID_REQUEST');
  }
  return { afterId: afterId ? afterId.toLowerCase() : null, watermark: watermark || null };
}

export interface ActionsDependencies {
  requester(): Promise<string>;
  read(cursor: ActionCursor): Promise<DeletionActionsPage>;
  cancel(ids: readonly string[], requestedBy: string): Promise<unknown>;
}

export async function getActions(
  afterId: string, watermark: string, deps: ActionsDependencies,
): Promise<DeletionActionsPage> {
  const cursor = validateActionCursor(afterId, watermark);
  await deps.requester();
  return deps.read(cursor);
}

export async function cancelActions(
  selectedRequestIdsJson: string, deps: ActionsDependencies,
): Promise<DeletionCancellationResult> {
  const ids = validateSelectedIds(selectedRequestIdsJson);
  const requestedBy = await deps.requester();
  const cancelledCount = await deps.cancel(ids, requestedBy);
  if (typeof cancelledCount !== 'number' || !Number.isSafeInteger(cancelledCount)
    || cancelledCount !== ids.length) {
    throw new AdmissionError('INVALID_CANCELLATION_COUNT');
  }
  return { cancelledCount };
}
