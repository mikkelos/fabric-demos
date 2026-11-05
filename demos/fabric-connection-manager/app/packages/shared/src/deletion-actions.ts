export const deletionActionStatuses = ['pending', 'processing', 'reconcile', 'deleted', 'cancelled'] as const;
export type DeletionActionStatus = typeof deletionActionStatuses[number];

export type DeletionActionState = {
  connectionId: string;
  connectionName: string;
  status: DeletionActionStatus;
  requestedAt: string;
  deletedAt: string | null;
  pendingRequestIds: string[];
};

export type DeletionActionsPage = {
  actions: DeletionActionState[];
  watermark: string;
  nextCursor: string | null;
};

export type DeletionCancellationInput = { requestIds: string[] };
export type DeletionCancellationResult = { cancelledCount: number };

export function validateCancellationRequest(input: unknown): asserts input is DeletionCancellationInput {
  if (!input || typeof input !== 'object' || !('requestIds' in input)
    || !Array.isArray(input.requestIds) || input.requestIds.length < 1 || input.requestIds.length > 100_000) {
    throw new Error('Select between 1 and 100,000 deletion requests to cancel.');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = new Set<string>();
  for (const id of input.requestIds) {
    if (typeof id !== 'string' || !uuid.test(id) || ids.has(id.toLowerCase())) {
      throw new Error('Cancellation requires unique, valid deletion request identities.');
    }
    ids.add(id.toLowerCase());
  }
}
