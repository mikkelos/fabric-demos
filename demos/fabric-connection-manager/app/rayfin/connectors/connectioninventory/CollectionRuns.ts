import { entity, date, int, text, role } from '@microsoft/rayfin-core';
import { Source } from '@microsoft/rayfin-connectors';

@role('authenticated', ['read'])
@entity()
export class CollectionRuns extends Source({ schema: 'inventory', table: 'collection_runs', primaryKey: [] }) {
  @text({ column: 'run_id', max: 8000 }) runId!: string;
  @date({ column: 'started_at' }) startedAt!: Date;
  @date({ optional: true, column: 'completed_at' }) completedAt?: Date;
  @text({ max: 8000 }) status!: string;
  @int({ column: 'connection_count' }) connectionCount!: number;
  @int({ column: 'role_assignment_count' }) roleAssignmentCount!: number;
  @int({ column: 'owner_lookup_failure_count' }) ownerLookupFailureCount!: number;
  @int({ column: 'request_count' }) requestCount!: number;
  @text({ optional: true, column: 'error_code', max: 8000 }) errorCode?: string;
}
