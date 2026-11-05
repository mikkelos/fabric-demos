import { describe, expect, it, vi } from 'vitest';
import type { DeletionRequestInput } from '@rayfin-app/shared';
import { DeletionLogError, logForDeletion, type DeletionLogWriter } from './deletion-requests.service';

vi.mock('@/lib/rayfin-client', () => ({ getRayfinClient: vi.fn() }));

const input = (count = 1): DeletionRequestInput => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  snapshotRunId: '00000000-0000-4000-8000-000000000002',
  connectionIds: Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${(index + 10).toString(16).padStart(12, '0')}`),
});
const successful: DeletionLogWriter = async (batch) => ({
  requestId: batch.requestId,
  markedCount: JSON.parse(batch.selectedIdsJson).length,
});

describe('durable deletion logging', () => {
  it('chunks the complete selection and keeps the same request and snapshot identities', async () => {
    const write = vi.fn(successful);
    expect(await logForDeletion(input(1001), write)).toEqual({ requestId: input().requestId, markedCount: 1001 });
    expect(write.mock.calls.map(([batch]) => JSON.parse(batch.selectedIdsJson).length)).toEqual([500, 500, 1]);
    expect(write.mock.calls.every(([batch]) => batch.requestId === input().requestId && batch.snapshotRunId === input().snapshotRunId)).toBe(true);
  });

  it('accepts the SDK-parsed object and JSON string output forms', async () => {
    await expect(logForDeletion(input(), successful)).resolves.toMatchObject({ markedCount: 1 });
    await expect(logForDeletion(input(), async (batch) => JSON.stringify(await successful(batch)))).resolves.toMatchObject({ markedCount: 1 });
  });

  it.each([null, {}, { requestId: 'wrong', markedCount: 1 }, { requestId: input().requestId, markedCount: 0 }, 'invalid'])('rejects inconsistent acknowledgements', async (result) => {
    await expect(logForDeletion(input(), async () => result)).rejects.toBeInstanceOf(DeletionLogError);
  });

  it('reports partial persistence explicitly and retries with identical canonical chunks', async () => {
    const failure = new Error('network');
    const write = vi.fn(successful).mockImplementationOnce(successful).mockRejectedValueOnce(failure);
    const selection = input(501);
    await expect(logForDeletion(selection, write)).rejects.toMatchObject({ acknowledgedCount: 500, cause: failure });
    const first = write.mock.calls.map(([batch]) => batch);
    write.mockClear();
    await logForDeletion({ ...selection, connectionIds: [...selection.connectionIds].reverse() }, write);
    expect(write.mock.calls.map(([batch]) => batch)).toEqual(first);
  });

  it('performs no write for an invalid selection', async () => {
    const write = vi.fn(successful);
    await expect(logForDeletion({ ...input(), connectionIds: [] }, write)).rejects.toThrow(/Select/);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['SNAPSHOT_STALE', 'Run CollectConnectionInventory in Fabric'],
    ['SNAPSHOT_CHANGED', 'Refresh the inventory'],
    ['ACTIVE_REQUEST_EXISTS', 'already has a deletion request'],
  ])('shows safe actionable guidance for %s', async (code, guidance) => {
    const failure = Object.assign(new Error(`private-provider-detail {"failureCode":"${code}","correlationId":"11111111-1111-4111-8111-111111111111"}`), {
      status: 500,
    });
    const error = await logForDeletion(input(), async () => { throw failure; }).catch(cause => cause);
    expect(error).toBeInstanceOf(DeletionLogError);
    expect(error.diagnostic).toContain(guidance);
    expect(error.diagnostic).toContain('HTTP 500');
    expect(error.diagnostic).toContain('Reference: 11111111-1111-4111-8111-111111111111');
    expect(error.diagnostic).not.toContain('private-provider-detail');
  });

  it('does not expose arbitrary provider errors', async () => {
    const error = new DeletionLogError(0, new Error('private-provider-detail'));
    expect(error.diagnostic).toBeNull();
    expect(error.message).not.toContain('private-provider-detail');
  });
});
