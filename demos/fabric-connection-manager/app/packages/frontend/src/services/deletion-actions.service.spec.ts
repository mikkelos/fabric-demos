import { describe, expect, it, vi } from 'vitest';
import { validateCancellationRequest, type DeletionActionState } from '@rayfin-app/shared';
import {
  cancelDeletionRequests,
  DeletionActionsLoadError,
  DeletionCancellationError,
  loadDeletionActions,
} from './deletion-actions.service';

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const pending = (value: number): DeletionActionState => ({
  connectionId: id(value),
  connectionName: `Connection ${value}`,
  status: 'pending',
  requestedAt: '2026-10-19T10:00:00.000Z',
  deletedAt: null,
  pendingRequestIds: [id(value + 100_000)],
});
const page = (actions: DeletionActionState[], nextCursor: string | null = null, watermark = '42') =>
  ({ actions, nextCursor, watermark });

describe('DeletionActionsLoadError diagnostics', () => {
  const reference = '11111111-1111-4111-8111-111111111111';

  it.each(['UNAUTHENTICATED', 'IDENTITY_UNAVAILABLE', 'METADATA_UNAVAILABLE', 'ACTIONS_UNAVAILABLE', 'INVALID_ACTIONS_RESULT'])(
    'preserves the safe %s code and correlation reference without provider details',
    (failureCode) => {
      const cause = Object.assign(new Error(`Function failed: ${JSON.stringify({
        failureCode, correlationId: reference, privateDetails: 'synthetic-private-body',
      })}`), { status: 500 });
      expect(new DeletionActionsLoadError(cause).diagnostic)
        .toBe(`getDeletionActions: HTTP 500. Code: ${failureCode}. Reference: ${reference}.`);
    },
  );

  it('decodes escaped Function errors returned inside SDK error envelopes', () => {
    const message = JSON.stringify({ message: JSON.stringify({ failureCode: 'UNAUTHENTICATED', correlationId: reference }) });
    expect(new DeletionActionsLoadError(new Error(message)).diagnostic)
      .toBe(`getDeletionActions: Code: UNAUTHENTICATED. Reference: ${reference}.`);
  });

  it.each([
    'UNAUTHENTICATED', 'IDENTITY_UNAVAILABLE', 'INVALID_METADATA', 'METADATA_UNAVAILABLE',
    'RUNTIME_UNAVAILABLE', 'ACTIONS_UNAVAILABLE', 'INVALID_ACTIONS_RESULT', 'INVALID_REQUEST',
  ])('preserves the typed SDK %s code even when its message is replaced', failureCode => {
    const cause = Object.assign(new Error('private-provider-body'), {
      status: 500, workload: { errorCode: failureCode, invocationId: reference },
    });
    expect(new DeletionActionsLoadError(cause).diagnostic)
      .toBe(`getDeletionActions: HTTP 500. Code: ${failureCode}. Reference: ${reference}.`);
  });

  it('does not expose arbitrary structured SDK error codes', () => {
    const cause = Object.assign(new Error('private-provider-body'), {
      status: 500, workload: { errorCode: 'private-provider-code', invocationId: reference },
    });
    expect(new DeletionActionsLoadError(cause).diagnostic)
      .toBe(`getDeletionActions: HTTP 500. Reference: ${reference}.`);
  });

  it.each([
    'MISSING_TOKEN', 'INVALID_RUNTIME_CONTEXT', 'INVALID_TOKEN', 'TOKEN_EXPIRED',
    'TOKEN_NOT_ACTIVE', 'MISSING_REQUIRED_CLAIM', 'INVALID_SUBJECT', 'SUBJECT_TOO_LONG',
    'INVALID_SIGNATURE', 'SIGNING_KEY_NOT_FOUND', 'UNSUPPORTED_ALGORITHM', 'VERIFICATION_UNAVAILABLE',
  ])('surfaces only the safe caller check %s without token or claim values', identityFailure => {
    const cause = Object.assign(new Error(JSON.stringify({
      failureCode: 'UNAUTHENTICATED', correlationId: reference, identityFailure,
      privateDetails: 'private-provider-body',
    })), { status: 500 });
    expect(new DeletionActionsLoadError(cause).diagnostic)
      .toBe(`getDeletionActions: HTTP 500. Code: UNAUTHENTICATED. Caller check: ${identityFailure}. Reference: ${reference}.`);
  });

  it('suppresses unrecognized caller-check details', () => {
    const cause = new Error(JSON.stringify({
      failureCode: 'UNAUTHENTICATED', identityFailure: 'private-provider-body',
    }));
    expect(new DeletionActionsLoadError(cause).diagnostic)
      .toBe('getDeletionActions: Code: UNAUTHENTICATED.');
  });

  it('preserves safe platform failure metadata before the handler runs', () => {
    const cause = Object.assign(new Error('private-provider-body'), {
      status: 403, workload: { subErrorCode: 'Forbidden', invocationId: reference },
    });
    expect(new DeletionActionsLoadError(cause).diagnostic)
      .toBe(`getDeletionActions: HTTP 403. Platform: Forbidden. Reference: ${reference}.`);
  });

  it.each([
    new Error('Authorization: synthetic-private-body'),
    new Error('{"failureCode":"synthetic-private-body","correlationId":"not-a-uuid"}'),
    Object.assign(new Error('private-provider-body'), {
      status: '500', workload: { subErrorCode: 'synthetic-private-body', invocationId: '00000000-0000-0000-0000-000000000000' },
    }),
    null,
  ])('does not expose arbitrary errors, untrusted codes, invalid references or synthesized zero IDs %#', cause => {
    expect(new DeletionActionsLoadError(cause).diagnostic).toBeNull();
  });

  it('labels malformed successful responses as validation failures rather than transport failures', async () => {
    await expect(loadDeletionActions(async () => page([], null, 'bad')))
      .rejects.toMatchObject({ diagnostic: 'getDeletionActions: response validation failed. No partial status or history was accepted.' });
  });
});

describe('loadDeletionActions', () => {
  it('pins pages to the first event watermark and accepts SDK JSON strings', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(page([pending(1)], id(1))))
      .mockResolvedValueOnce(page([pending(2)]));
    expect(await loadDeletionActions(read)).toEqual([pending(1), pending(2)]);
    expect(read.mock.calls).toEqual([
      [{ afterId: '', watermark: '' }],
      [{ afterId: id(1), watermark: '42' }],
    ]);
  });

  it('distinguishes a verified empty history from a failed read', async () => {
    expect(await loadDeletionActions(async () => page([], null, '0'))).toEqual([]);
    await expect(loadDeletionActions(async () => { throw new Error('Unavailable'); }))
      .rejects.toBeInstanceOf(DeletionActionsLoadError);
  });

  it('returns confirmed deleted rows with normalized timestamps', async () => {
    const deleted = { ...pending(1), status: 'deleted', deletedAt: '2026-10-19T11:00:00Z', pendingRequestIds: [] };
    const result = await loadDeletionActions(async () => ({ actions: [deleted], nextCursor: null, watermark: '99' }));
    expect(result[0]).toMatchObject({ status: 'deleted', deletedAt: '2026-10-19T11:00:00.000Z' });
  });

  it.each([
    { ...page([pending(1)]), watermark: '-1' },
    { ...page([pending(1)]), watermark: '01' },
    { ...page([pending(1)]), watermark: '9223372036854775808' },
    { ...page([pending(1)]), nextCursor: id(2) },
    { ...page([pending(1)]), nextCursor: undefined },
    { ...page([pending(1)]), actions: [{ ...pending(1), status: 'unknown' }] },
    { ...page([pending(1)]), actions: [{ ...pending(1), connectionId: 'bad' }] },
    { ...page([pending(1)]), actions: [{ ...pending(1), requestedAt: '2026-02-30T10:00:00Z' }] },
    { ...page([pending(1)]), actions: [{ ...pending(1), requestedAt: 'not a date' }] },
    { ...page([pending(1)]), actions: [{ ...pending(1), pendingRequestIds: [id(2), id(2).toUpperCase()] }] },
    { ...page([pending(1)]), actions: [{ ...pending(1), status: 'processing' }] },
    { ...page([pending(1)]), actions: [{ ...pending(1), deletedAt: '2026-10-19T11:00:00Z' }] },
    { ...page([pending(1)]), actions: [{ ...pending(1), status: 'deleted', pendingRequestIds: [] }] },
    { ...page([pending(1)]), actions: Array.from({ length: 501 }, (_, index) => pending(index)) },
    null,
    '{invalid',
  ])('rejects malformed/inconsistent pages rather than showing a false empty state %#', async (invalid) => {
    await expect(loadDeletionActions(async () => invalid)).rejects.toBeInstanceOf(DeletionActionsLoadError);
  });

  it('rejects a changed watermark on later pages', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([pending(1)], id(1)))
      .mockResolvedValueOnce(page([pending(2)], null, '43'));
    await expect(loadDeletionActions(read)).rejects.toBeInstanceOf(DeletionActionsLoadError);
  });

  it('restarts once at a fresh watermark when a pending request was cancelled after the pinned cut', async () => {
    const cancelled: DeletionActionState = { ...pending(1), status: 'cancelled', pendingRequestIds: [] };
    const read = vi.fn()
      .mockResolvedValueOnce(page([{ ...pending(1), pendingRequestIds: [] }]))
      .mockResolvedValueOnce(page([cancelled], null, '43'));
    expect(await loadDeletionActions(read)).toEqual([cancelled]);
    expect(read.mock.calls).toEqual([
      [{ afterId: '', watermark: '' }],
      [{ afterId: '', watermark: '' }],
    ]);
  });

  it('fails closed after a second eligibility change rather than retrying indefinitely', async () => {
    const read = vi.fn(async () => page([{ ...pending(1), pendingRequestIds: [] }]));
    await expect(loadDeletionActions(read)).rejects.toBeInstanceOf(DeletionActionsLoadError);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate connections across pages', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([pending(1)], id(1)))
      .mockResolvedValueOnce(page([pending(1)]));
    await expect(loadDeletionActions(read)).rejects.toBeInstanceOf(DeletionActionsLoadError);
  });

  it('rejects a request mapped to two connections', async () => {
    const read = vi.fn().mockResolvedValue(page([pending(1), { ...pending(2), pendingRequestIds: pending(1).pendingRequestIds }]));
    await expect(loadDeletionActions(read)).rejects.toBeInstanceOf(DeletionActionsLoadError);
  });

  it('does not return partial state when a later page fails', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([pending(1)], id(1))).mockRejectedValueOnce(new Error('Lost page'));
    await expect(loadDeletionActions(read)).rejects.toBeInstanceOf(DeletionActionsLoadError);
  });

  it('bounds continuation even for a server repeatedly issuing new cursors', async () => {
    let count = 0;
    const read = vi.fn(async () => {
      count += 1;
      return page([pending(count)], id(count));
    });
    await expect(loadDeletionActions(read)).rejects.toBeInstanceOf(DeletionActionsLoadError);
    expect(read).toHaveBeenCalledTimes(200);
  });

  it('accepts the full 100,000-connection bound in 200 complete pages', async () => {
    let pageNumber = 0;
    const read = vi.fn(async () => {
      const rows = Array.from({ length: 500 }, (_, index) => pending(pageNumber * 500 + index + 1));
      pageNumber += 1;
      return page(rows, pageNumber === 200 ? null : rows[499].connectionId);
    });
    const result = await loadDeletionActions(read);
    expect(result).toHaveLength(100_000);
    expect(result.at(-1)?.connectionId).toBe(id(100_000));
    expect(read).toHaveBeenCalledTimes(200);
  });
});

describe('cancelDeletionRequests', () => {
  const malformedInputs: unknown[] = [null, undefined, {}, [], { requestIds: 'not an array' },
    { requestIds: [null] }, { requestIds: [42] }];
  it.each(malformedInputs)('validates malformed runtime cancellation input %#', (input) => {
    expect(() => validateCancellationRequest(input)).toThrow();
  });

  it('cancels exact immutable request IDs in deterministic batches of 500', async () => {
    const requestIds = Array.from({ length: 1001 }, (_, index) => id(index + 1)).reverse();
    const write = vi.fn(async (input: { selectedRequestIdsJson: string }) =>
      ({ cancelledCount: JSON.parse(input.selectedRequestIdsJson).length }));
    expect(await cancelDeletionRequests({ requestIds }, write)).toEqual({ cancelledCount: 1001 });
    expect(write.mock.calls.map(([input]) => JSON.parse(input.selectedRequestIdsJson).length)).toEqual([500, 500, 1]);
    expect(write.mock.calls.flatMap(([input]) => JSON.parse(input.selectedRequestIdsJson))).toEqual([...requestIds].sort());
  });

  it('accepts a JSON string acknowledgement', async () => {
    expect(await cancelDeletionRequests({ requestIds: [id(1)] }, async () => '{"cancelledCount":1}'))
      .toEqual({ cancelledCount: 1 });
  });

  it('reports acknowledged progress and retries precisely the same request identities', async () => {
    const requestIds = Array.from({ length: 501 }, (_, index) => id(index + 1));
    const write = vi.fn().mockResolvedValueOnce({ cancelledCount: 500 }).mockRejectedValueOnce(new Error('Busy'));
    await expect(cancelDeletionRequests({ requestIds }, write)).rejects.toMatchObject({
      name: 'DeletionCancellationError',
      acknowledgedCount: 500,
    });
    const retry = vi.fn(async (input: { selectedRequestIdsJson: string }) =>
      ({ cancelledCount: JSON.parse(input.selectedRequestIdsJson).length }));
    await cancelDeletionRequests({ requestIds: [...requestIds].reverse() }, retry);
    expect(retry.mock.calls.map(([input]) => input)).toEqual(write.mock.calls.map(([input]) => input));
  });

  it.each([null, {}, { cancelledCount: 0 }, { cancelledCount: 2 }, { cancelledCount: '1' }, '{invalid'])(
    'rejects inconsistent acknowledgements %#', async (invalid) => {
    await expect(cancelDeletionRequests({ requestIds: [id(1)] }, async () => invalid))
      .rejects.toBeInstanceOf(DeletionCancellationError);
    });

  it.each([
    { requestIds: [] },
    { requestIds: ['bad'] },
    { requestIds: [id(1), id(1).toUpperCase()] },
    { requestIds: Array.from({ length: 100_001 }, (_, index) => id(index)) },
  ])('rejects invalid input before any write %#', async (input) => {
    const write = vi.fn();
    await expect(cancelDeletionRequests(input, write)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
