const failureCodes = new Set([
  'UNAUTHENTICATED', 'IDENTITY_UNAVAILABLE', 'INVALID_METADATA', 'METADATA_UNAVAILABLE',
  'RUNTIME_UNAVAILABLE', 'ACTIONS_UNAVAILABLE', 'INVALID_ACTIONS_RESULT', 'INVALID_REQUEST',
  'SNAPSHOT_UNAVAILABLE', 'SNAPSHOT_CHANGED', 'SNAPSHOT_STALE', 'SNAPSHOT_INCOMPLETE',
  'SELECTION_MISMATCH', 'LOGGING_UNAVAILABLE', 'INVALID_MARKED_COUNT', 'ACTIVE_REQUEST_EXISTS',
]);
const platformFailureCodes = new Set(['Unauthorized', 'Forbidden', 'NotFound', 'InvalidInput', 'BadRequest']);
const identityFailureChecks = new Set([
  'MISSING_TOKEN', 'INVALID_RUNTIME_CONTEXT', 'INVALID_TOKEN', 'TOKEN_EXPIRED',
  'TOKEN_NOT_ACTIVE', 'MISSING_REQUIRED_CLAIM', 'INVALID_SUBJECT', 'SUBJECT_TOO_LONG',
  'INVALID_SIGNATURE', 'SIGNING_KEY_NOT_FOUND', 'UNSUPPORTED_ALGORITHM', 'VERIFICATION_UNAVAILABLE',
  'CRYPTO_UNAVAILABLE', 'KEY_IMPORT_FAILED',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function functionFailureDiagnostic(cause: unknown, operation: string): string | null {
  if (!cause || typeof cause !== 'object') return null;
  const error = Object.fromEntries(Object.entries(cause));
  const workload = error.workload && typeof error.workload === 'object'
    ? Object.fromEntries(Object.entries(error.workload)) : {};
  const parts: string[] = [];
  if (typeof error.status === 'number' && Number.isInteger(error.status)
    && error.status >= 400 && error.status <= 599) {
    parts.push(`HTTP ${error.status}.`);
  }
  const message = cause instanceof Error ? cause.message.slice(0, 8192).replaceAll('\\"', '"') : '';
  const code = [message.match(/"failureCode"\s*:\s*"([A-Z_]+)"/)?.[1], workload.errorCode]
    .find((value): value is string => typeof value === 'string' && failureCodes.has(value));
  const correlation = message.match(/"correlationId"\s*:\s*"([0-9a-f-]{36})"/i)?.[1];
  const identityFailure = message.match(/"identityFailure"\s*:\s*"([A-Z_]+)"/)?.[1];
  if (code) parts.push(`Code: ${code}.`);
  else if (typeof workload.subErrorCode === 'string' && platformFailureCodes.has(workload.subErrorCode)) {
    parts.push(`Platform: ${workload.subErrorCode}.`);
  }
  if ((code === 'UNAUTHENTICATED' || code === 'IDENTITY_UNAVAILABLE')
    && identityFailure && identityFailureChecks.has(identityFailure)) {
    parts.push(`Caller check: ${identityFailure}.`);
  }
  const reference = correlation && uuid.test(correlation) ? correlation : workload.invocationId;
  if (typeof reference === 'string' && uuid.test(reference)
    && reference !== '00000000-0000-0000-0000-000000000000') {
    parts.push(`Reference: ${reference.toLowerCase()}.`);
  }
  if (operation === 'logForDeletion') {
    if (code === 'SNAPSHOT_STALE') {
      parts.push('Inventory must be less than seven days old. Run CollectConnectionInventory in Fabric, refresh the inventory in the app, and select the connection again.');
    } else if (code === 'SNAPSHOT_CHANGED') {
      parts.push('A newer collection is available. Refresh the inventory and select the connection again.');
    } else if (code === 'ACTIVE_REQUEST_EXISTS') {
      parts.push('A selected connection already has a deletion request or recorded deletion. Refresh deletion status.');
    }
  }
  return parts.length ? `${operation}: ${parts.join(' ')}` : null;
}
