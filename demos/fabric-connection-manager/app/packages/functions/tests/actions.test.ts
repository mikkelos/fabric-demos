import { describe, expect, it, vi } from 'vitest';
import { cancelActions, getActions, validateActionCursor, type ActionsDependencies } from '../src/actions.js';
import { decodeActions } from '../src/sql.js';

const id = '30000000-0000-4000-8000-000000000003';
const requestId = '40000000-0000-4000-8000-000000000004';
const deps = (): ActionsDependencies => ({
  requester: vi.fn(async () => 'verified-rayfin-subject'),
  read: vi.fn(async () => ({ actions: [], watermark: '0', nextCursor: null })),
  cancel: vi.fn(async () => 1),
});
const row = () => ({
  connection_id: id, connection_name: 'Synthetic fixture', status: 'pending',
  requested_at: new Date('2026-10-19T10:00:00Z'), deleted_at: null,
  pending_request_ids_json: JSON.stringify([requestId]),
});
const header = { watermark: '9223372036854775807', next_cursor: null };

describe('action cursors and authenticated boundaries', () => {
  it('accepts the empty first page and canonical signed-bigint watermarks', () => {
    expect(validateActionCursor('', '')).toEqual({ afterId: null, watermark: null });
    expect(validateActionCursor(id.toUpperCase(), '9223372036854775807'))
      .toEqual({ afterId: id, watermark: '9223372036854775807' });
    expect(validateActionCursor('', '0')).toEqual({ afterId: null, watermark: '0' });
  });

  it.each([
    [id, ''], ['invalid', '1'], ['', '-1'], ['', '9223372036854775808'],
    ['', '01'], ['', '+1'], ['', '1.0'], ['', '1e2'], ['', '0; DELETE'],
    ['', '1\n'], ['', ' '.repeat(10)], ['', '9'.repeat(100)],
  ])('rejects invalid cursors %j %j before any authenticated SQL work', async (afterId, watermark) => {
    const dependencies = deps();
    await expect(getActions(afterId, watermark, dependencies)).rejects.toThrow('INVALID_REQUEST');
    expect(dependencies.requester).not.toHaveBeenCalled();
    expect(dependencies.read).not.toHaveBeenCalled();
  });

  it('authenticates before reading and never accepts a client actor', async () => {
    const dependencies = deps();
    await getActions('', '', dependencies);
    expect(dependencies.requester).toHaveBeenCalledOnce();
    expect(dependencies.read).toHaveBeenCalledWith({ afterId: null, watermark: null });
    await expect(cancelActions(JSON.stringify([requestId]), dependencies))
      .resolves.toEqual({ cancelledCount: 1 });
    expect(dependencies.cancel).toHaveBeenCalledWith([requestId], 'verified-rayfin-subject');
  });

  it.each(['[]', '{}', '[null]', JSON.stringify([id, id.toUpperCase()]), JSON.stringify(Array(501).fill(id))])(
    'rejects malformed cancellation selections', async selected => {
      const dependencies = deps();
      await expect(cancelActions(selected, dependencies)).rejects.toThrow('INVALID_REQUEST');
      expect(dependencies.requester).not.toHaveBeenCalled();
    },
  );

  it.each([0, 2, -1, '1', null, undefined, Number.NaN, 1.5])('requires an exact cancellation count %j', async value => {
    const dependencies = deps();
    dependencies.cancel = vi.fn(async () => value);
    await expect(cancelActions(JSON.stringify([requestId]), dependencies))
      .rejects.toThrow('INVALID_CANCELLATION_COUNT');
  });

  it('does not access SQL when invocation verification fails', async () => {
    const dependencies = deps();
    dependencies.requester = vi.fn(async () => { throw new Error('UNAUTHENTICATED'); });
    await expect(getActions('', '', dependencies)).rejects.toThrow('UNAUTHENTICATED');
    await expect(cancelActions(JSON.stringify([id]), dependencies)).rejects.toThrow('UNAUTHENTICATED');
    expect(dependencies.read).not.toHaveBeenCalled();
    expect(dependencies.cancel).not.toHaveBeenCalled();
  });
});

describe('action SQL wire mapping', () => {
  it('maps a page without bigint precision loss and only necessary fields', () => {
    expect(decodeActions([header], [{ ...row(), private_field: 'ignored' }])).toEqual({
      watermark: header.watermark, nextCursor: null,
      actions: [{
        connectionId: id, connectionName: 'Synthetic fixture', status: 'pending',
        requestedAt: '2026-10-19T10:00:00.000Z', deletedAt: null, pendingRequestIds: [requestId],
      }],
    });
  });

  it('maps deletion history to the actual terminal event timestamp', () => {
    const deletedAt = new Date('2026-10-19T11:00:00Z');
    expect(decodeActions([header], [{
      ...row(), status: 'deleted', deleted_at: deletedAt, pending_request_ids_json: '[]',
    }]).actions[0].deletedAt).toBe(deletedAt.toISOString());
  });

  it.each(['processing', 'reconcile', 'cancelled'])('supports %s without cancellation identities', status => {
    expect(decodeActions([header], [{ ...row(), status, pending_request_ids_json: '[]' }]).actions[0])
      .toMatchObject({ status, deletedAt: null, pendingRequestIds: [] });
  });

  it.each([
    { status: 'processing' }, { status: 'deleted' }, { status: 'unknown' },
    { connection_id: 'invalid' }, { requested_at: null }, { deleted_at: new Date() },
    { pending_request_ids_json: '[null]' }, { pending_request_ids_json: JSON.stringify([id, id]) },
    { pending_request_ids_json: 'private-provider-message' },
  ])('rejects malformed or unsafe action records', values => {
    expect(() => decodeActions([header], [{ ...row(), ...values }])).toThrow('INVALID_ACTIONS_RESULT');
  });

  it('rejects duplicate connection IDs and oversized pages', () => {
    expect(() => decodeActions([header], [row(), row()])).toThrow('INVALID_ACTIONS_RESULT');
    expect(() => decodeActions([header], Array(501).fill(row()))).toThrow('INVALID_ACTIONS_RESULT');
  });

  it.each([
    [], [header, header], [{ ...header, watermark: '9223372036854775808' }],
    [{ ...header, watermark: '' }], [{ ...header, next_cursor: id }],
  ])('rejects invalid pagination headers', headers => {
    expect(() => decodeActions(headers, [])).toThrow('INVALID_ACTIONS_RESULT');
  });
});
