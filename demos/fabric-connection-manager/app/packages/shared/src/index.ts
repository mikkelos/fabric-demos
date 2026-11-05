/**
 * Entity map shared by the data registration package and typed browser client.
 *
 * It remains empty while the data service is disabled. Data capabilities add
 * entity keys here so every runtime consumes the same schema contract.
 */
export type UniversalAppSchema = Record<string, never>;

export type {
  ConnectionSummary,
  ConnectionFailureCode,
  ConnectionOwner,
  ConnectionRoleAssignment,
  ConnectionOwnerStatus,
} from './connections.js';

export { deletionEventTypes, validateDeletionRequest } from './deletion-requests.js';
export type { DeletionEventType, DeletionRequestInput, DeletionLogResult } from './deletion-requests.js';
export { deletionActionStatuses, validateCancellationRequest } from './deletion-actions.js';
export type {
  DeletionActionStatus,
  DeletionActionState,
  DeletionActionsPage,
  DeletionCancellationInput,
  DeletionCancellationResult,
} from './deletion-actions.js';
