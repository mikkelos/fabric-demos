import { describe, expect, it, vi } from 'vitest';
import {
  admitDeletion, maxRequesterLength, validateInput, type AdmissionDependencies, type DeletionInput, type Snapshot,
} from '../src/admission.js';

const requestId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000002';
const id = '30000000-0000-4000-8000-000000000003';
const otherId = '40000000-0000-4000-8000-000000000004';
const now = Date.parse('2026-10-19T12:00:00Z');
const input = (): DeletionInput => ({
  requestId, snapshotRunId: runId, selectedIdsJson: JSON.stringify([id]),
});
function fixtures(): { deps: AdmissionDependencies; snapshot: Snapshot } {
  const snapshot: Snapshot = {
    runId, startedAt: '2026-10-19T10:00:00Z', completedAt: '2026-10-19T10:01:00Z',
    expectedCount: 1, actualCount: 1, uniqueCount: 1,
    connections: [{
      connectionId: id, displayName: 'Synthetic fixture', connectivityType: 'ShareableCloud',
      sourceType: 'SQL', createdAt: null, lastBoundAt: null, lastCredentialUsedAt: null,
    }],
  };
  return { snapshot, deps: {
    requester: vi.fn(async () => 'verified-rayfin-subject'),
    snapshot: vi.fn(async () => snapshot),
    log: vi.fn(async () => 1),
    now: () => now,
  } };
}

describe('deletion admission', () => {
  it('logs only authoritative baseline fields and the verified Rayfin subject', async () => {
    const { deps } = fixtures();
    const maliciousInput = { ...input(), requestedBy: 'spoofed-actor', displayName: 'spoofed-name' };
    await expect(admitDeletion(maliciousInput, deps)).resolves.toEqual({ requestId, markedCount: 1 });
    expect(deps.log).toHaveBeenCalledWith({
      batchId: requestId, snapshotRunId: runId, requestedBy: 'verified-rayfin-subject',
      connections: [{
        connectionId: id, displayName: 'Synthetic fixture', connectivityType: 'ShareableCloud',
        sourceType: 'SQL', createdAt: null, lastBoundAt: null, lastCredentialUsedAt: null,
      }],
    });
  });

  it.each([
    { ...input(), requestId: '' },
    { ...input(), requestId: '00000000-0000-0000-0000-000000000000' },
    { ...input(), snapshotRunId: 'not-a-uuid' },
    { ...input(), selectedIdsJson: '[' },
    { ...input(), selectedIdsJson: '{}' },
    { ...input(), selectedIdsJson: '[]' },
    { ...input(), selectedIdsJson: JSON.stringify([id, id.toUpperCase()]) },
    { ...input(), selectedIdsJson: JSON.stringify([{ id }]) },
    { ...input(), selectedIdsJson: JSON.stringify([null]) },
    { ...input(), selectedIdsJson: JSON.stringify(Array(501).fill(id)) },
  ])('rejects malformed input without resolving identity or touching SQL', async value => {
    const { deps } = fixtures();
    await expect(admitDeletion(value, deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(deps.requester).not.toHaveBeenCalled();
    expect(deps.snapshot).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('accepts exactly 500 unique IDs and normalizes casing', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `abcdef00-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    expect(validateInput({ ...input(), selectedIdsJson: JSON.stringify(ids.map(value => value.toUpperCase())) }).ids)
      .toEqual(ids);
  });

  it.each([201, maxRequesterLength])('logs a full verified requester of %i characters without truncation', async length => {
    const { deps } = fixtures();
    const subject = 'a'.repeat(length);
    deps.requester = vi.fn(async () => subject);
    await expect(admitDeletion(input(), deps)).resolves.toEqual({ requestId, markedCount: 1 });
    expect(deps.log).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: subject }));
  });

  it.each(['', '  ', 'anonymous\n', 'x'.repeat(maxRequesterLength + 1)])('rejects malformed trusted requester %j', async subject => {
    const { deps } = fixtures();
    deps.requester = vi.fn(async () => subject);
    await expect(admitDeletion(input(), deps)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(deps.snapshot).not.toHaveBeenCalled();
  });

  it('requires the latest complete run to match the requested run', async () => {
    const { deps, snapshot } = fixtures();
    snapshot.runId = otherId;
    await expect(admitDeletion(input(), deps)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('rejects absent complete run', async () => {
    const { deps } = fixtures();
    deps.snapshot = vi.fn(async () => null);
    await expect(admitDeletion(input(), deps)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' });
  });

  it.each([
    ['2026-10-12T11:59:59Z', '2026-10-12T12:01:00Z'],
    ['invalid', '2026-10-19T10:01:00Z'],
    ['2026-10-19T10:00:00Z', '2026-10-19T12:00:01Z'],
    ['2026-10-19T10:00:00Z', '2026-10-19T09:00:00Z'],
  ])('rejects stale, malformed, future, or reversed snapshot timestamps', async (startedAt, completedAt) => {
    const { deps, snapshot } = fixtures();
    Object.assign(snapshot, { startedAt, completedAt });
    await expect(admitDeletion(input(), deps)).rejects.toMatchObject({ code: 'SNAPSHOT_STALE' });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it.each([
    { expectedCount: 2 }, { actualCount: 2 }, { uniqueCount: 0 },
    { expectedCount: -1 }, { expectedCount: 1.5 }, { expectedCount: Number.NaN },
  ])('requires manifest, source count and distinct source count to agree', async counts => {
    const { deps, snapshot } = fixtures();
    Object.assign(snapshot, counts);
    await expect(admitDeletion(input(), deps)).rejects.toMatchObject({ code: 'SNAPSHOT_INCOMPLETE' });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it.each(['missing', 'foreign', 'duplicate', 'partial'])('rejects %s selection rows', async kind => {
    const { deps, snapshot } = fixtures();
    const row = snapshot.connections[0];
    let selectedInput = input();
    if (kind === 'missing') snapshot.connections = [];
    if (kind === 'foreign') snapshot.connections = [{ ...row, connectionId: otherId }];
    if (kind === 'duplicate') snapshot.connections = [row, row];
    if (kind === 'partial') selectedInput = { ...input(), selectedIdsJson: JSON.stringify([id, otherId]) };
    await expect(admitDeletion(selectedInput, deps)).rejects.toMatchObject({ code: 'SELECTION_MISMATCH' });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it.each([0, 2, -1, 1.5, '1', null, undefined, Number.NaN])('rejects invalid marked count %j', async result => {
    const { deps } = fixtures();
    deps.log = vi.fn(async () => result);
    await expect(admitDeletion(input(), deps)).rejects.toMatchObject({ code: 'INVALID_MARKED_COUNT' });
  });

  it('returns the full matched count for an idempotent retry', async () => {
    const { deps } = fixtures();
    await expect(admitDeletion(input(), deps)).resolves.toEqual({ requestId, markedCount: 1 });
    await expect(admitDeletion(input(), deps)).resolves.toEqual({ requestId, markedCount: 1 });
    expect(deps.log).toHaveBeenCalledTimes(2);
  });
});
