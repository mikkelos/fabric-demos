export type DeletionRequestInput = {
  requestId: string;
  snapshotRunId: string;
  connectionIds: string[];
};

export type DeletionLogResult = {
  requestId: string;
  markedCount: number;
};

export const deletionEventTypes = [
  'marked_for_deletion',
  'deleted',
  'deletion_cancelled',
] as const;

export type DeletionEventType = typeof deletionEventTypes[number];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateDeletionRequest(input: unknown): asserts input is DeletionRequestInput {
  if (!input || typeof input !== 'object'
    || !('requestId' in input) || !('snapshotRunId' in input)
    || typeof input.requestId !== 'string' || typeof input.snapshotRunId !== 'string'
    || !uuid.test(input.requestId) || !uuid.test(input.snapshotRunId)) {
    throw new Error('Deletion logging requires valid request and snapshot identities.');
  }
  if (!('connectionIds' in input) || !Array.isArray(input.connectionIds)
    || input.connectionIds.length === 0 || input.connectionIds.length > 100_000) {
    throw new Error('Select between 1 and 100,000 connections to log for deletion.');
  }
  const unique = new Set<string>();
  for (const id of input.connectionIds) {
    if (typeof id !== 'string' || !uuid.test(id) || unique.has(id.toLowerCase())) {
      throw new Error('Deletion logging requires unique, valid connection identities.');
    }
    unique.add(id.toLowerCase());
  }
}
