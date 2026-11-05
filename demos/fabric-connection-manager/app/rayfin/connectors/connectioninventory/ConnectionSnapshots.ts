import { entity, boolean, date, int, text, role } from '@microsoft/rayfin-core';
import { Source } from '@microsoft/rayfin-connectors';

@role('authenticated', ['read'])
@entity()
export class ConnectionSnapshots extends Source({ schema: 'inventory', table: 'connection_snapshots', primaryKey: [] }) {
  @text({ column: 'snapshot_id', max: 8000 }) snapshotId!: string;
  @text({ column: 'run_id', max: 8000 }) runId!: string;
  @date({ column: 'collected_at' }) collectedAt!: Date;
  @text({ column: 'connection_id', max: 8000 }) connectionId!: string;
  @text({ column: 'display_name', max: 8000 }) displayName!: string;
  @text({ column: 'connectivity_type', max: 8000 }) connectivityType!: string;
  @text({ column: 'source_type', max: 8000 }) sourceType!: string;
  @text({ optional: true, column: 'gateway_id', max: 8000 }) gatewayId?: string;
  @text({ optional: true, column: 'privacy_level', max: 8000 }) privacyLevel?: string;
  @text({ optional: true, column: 'credential_type', max: 8000 }) credentialType?: string;
  @text({ optional: true, column: 'connection_encryption', max: 8000 }) connectionEncryption?: string;
  @date({ optional: true, column: 'created_at' }) createdAt?: Date;
  @date({ optional: true, column: 'last_bound_at' }) lastBoundAt?: Date;
  @date({ optional: true, column: 'last_credential_used_at' }) lastCredentialUsedAt?: Date;
  @date({ optional: true, column: 'my_last_bound_at' }) myLastBoundAt?: Date;
  @date({ optional: true, column: 'my_last_credential_used_at' }) myLastCredentialUsedAt?: Date;
  @text({ column: 'owner_lookup_status', max: 8000 }) ownerLookupStatus!: string;
  @text({ optional: true, column: 'owner_lookup_error_code', max: 8000 }) ownerLookupErrorCode?: string;
  @int({ optional: true, column: 'owner_lookup_retry_after_seconds' }) ownerLookupRetryAfterSeconds?: number;
  @text({ optional: true, column: 'endpoint', max: 8000 }) endpoint?: string;
  @text({ optional: true, column: 'endpoint_category', max: 8000 }) endpointCategory?: string;
  @text({ optional: true, column: 'single_sign_on_type', max: 8000 }) singleSignOnType?: string;
  @boolean({ optional: true, column: 'skip_test_connection' }) skipTestConnection?: boolean;
  @boolean({ optional: true, column: 'allow_usage_in_user_controlled_code' }) allowUsageInUserControlledCode?: boolean;
  @boolean({ optional: true, column: 'allow_connection_usage_in_gateway' }) allowConnectionUsageInGateway?: boolean;
}
