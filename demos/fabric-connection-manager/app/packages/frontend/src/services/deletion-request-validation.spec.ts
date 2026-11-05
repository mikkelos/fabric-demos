import { describe, expect, it } from 'vitest';
import { validateDeletionRequest, type DeletionRequestInput } from '@rayfin-app/shared';

const request = (): DeletionRequestInput => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  snapshotRunId: '00000000-0000-4000-8000-000000000002',
  connectionIds: ['00000000-0000-4000-8000-000000000003'],
});

describe('deletion request validation', () => {
  it('accepts a bounded explicit selection pinned to a snapshot', () => {
    expect(() => validateDeletionRequest(request())).not.toThrow();
  });

  it.each([null, {}, [], 'invalid', { ...request(), connectionIds: null }])('rejects malformed runtime payloads', (input) => {
    expect(() => validateDeletionRequest(input)).toThrow();
  });

  it.each(['requestId', 'snapshotRunId'] as const)('rejects invalid %s', (key) => {
    expect(() => validateDeletionRequest({ ...request(), [key]: 'invalid' })).toThrow(/identities/);
  });

  it('rejects empty and oversized selections', () => {
    expect(() => validateDeletionRequest({ ...request(), connectionIds: [] })).toThrow(/Select/);
    expect(() => validateDeletionRequest({ ...request(), connectionIds: Array<string>(100_001).fill(request().connectionIds[0]) })).toThrow(/Select/);
  });

  it('rejects malformed and case-insensitive duplicate identities', () => {
    expect(() => validateDeletionRequest({ ...request(), connectionIds: ['not-a-uuid'] })).toThrow(/unique/);
    const id = 'ABCDEF00-0000-4000-8000-000000000003';
    expect(() => validateDeletionRequest({ ...request(), connectionIds: [id, id.toLowerCase()] })).toThrow(/unique/);
  });
});
