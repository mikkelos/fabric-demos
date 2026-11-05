import { validateDeletionRequest, type DeletionLogResult, type DeletionRequestInput } from '@rayfin-app/shared';
import { getRayfinClient } from '@/lib/rayfin-client';
import { functionFailureDiagnostic } from './function-diagnostics';

type BatchInput = { requestId: string; snapshotRunId: string; selectedIdsJson: string };
export type DeletionLogWriter = (input: BatchInput) => Promise<unknown>;

export class DeletionLogError extends Error {
  readonly diagnostic: string | null;

  constructor(readonly acknowledgedCount: number, cause: unknown) {
    super(`Deletion logging could not be confirmed for the full selection. ${acknowledgedCount} connection(s) were confirmed; the last batch may also have been stored. Retry the same selection to safely finish without duplicate events.`, { cause });
    this.name = 'DeletionLogError';
    this.diagnostic = functionFailureDiagnostic(cause, 'logForDeletion');
  }
}

function decodeResult(value: unknown, requestId: string, count: number): DeletionLogResult {
  const result: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!result || typeof result !== 'object' || !('requestId' in result) || !('markedCount' in result)
    || result.requestId !== requestId || result.markedCount !== count) {
    throw new Error('Deletion logging returned an inconsistent acknowledgement.');
  }
  return { requestId, markedCount: count };
}

async function invoke(input: BatchInput): Promise<unknown> {
  return (await getRayfinClient()).functions.logForDeletion.invoke(input, { timeoutMs: 120_000 });
}

export async function logForDeletion(input: DeletionRequestInput, write: DeletionLogWriter = invoke): Promise<DeletionLogResult> {
  validateDeletionRequest(input);
  const requestId = input.requestId.toLowerCase();
  const snapshotRunId = input.snapshotRunId.toLowerCase();
  const ids = input.connectionIds.map((id) => id.toLowerCase()).sort();
  let acknowledgedCount = 0;
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    try {
      const result = await write({ requestId, snapshotRunId, selectedIdsJson: JSON.stringify(batch) });
      acknowledgedCount += decodeResult(result, requestId, batch.length).markedCount;
    } catch (error) {
      throw new DeletionLogError(acknowledgedCount, error);
    }
  }
  return { requestId, markedCount: acknowledgedCount };
}
