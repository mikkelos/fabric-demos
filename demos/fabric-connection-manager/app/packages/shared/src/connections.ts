export type ConnectionSummary = {
  id: string;
  displayName: string;
  connectivityType: string;
  sourceType: string;
  gatewayId: string | null;
  privacyLevel: string | null;
  credentialType: string | null;
  connectionEncryption: string | null;
  createdDateTime: string | null;
  lastBoundDateTime: string | null;
  lastCredentialUsedDateTime: string | null;
  myLastBoundDateTime: string | null;
  myLastCredentialUsedDateTime: string | null;
  owners: ConnectionOwner[];
  roleAssignments: ConnectionRoleAssignment[];
  ownerStatus: ConnectionOwnerStatus;
  endpoint?: string | null;
  endpointCategory?: string | null;
  singleSignOnType?: string | null;
  skipTestConnection?: boolean | null;
  allowUsageInUserControlledCode?: boolean | null;
  allowConnectionUsageInGateway?: boolean | null;
};

export type ConnectionOwner = {
  id: string;
  type: string;
  displayName: string | null;
};

export type ConnectionRoleAssignment = {
  id: string;
  principal: ConnectionOwner;
  role: string;
};

export type ConnectionOwnerStatus =
  | { ok: true }
  | {
      ok: false;
      code: ConnectionFailureCode;
      message: string;
      retryAfterSeconds: number | null;
    };

export type ConnectionFailureCode =
  | 'invalid-input'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'timeout'
  | 'unavailable'
  | 'invalid-response';
