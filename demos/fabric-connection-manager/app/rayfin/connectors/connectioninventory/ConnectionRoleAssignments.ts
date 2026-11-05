import { entity, date, text, role } from '@microsoft/rayfin-core';
import { Source } from '@microsoft/rayfin-connectors';

@role('authenticated', ['read'])
@entity()
export class ConnectionRoleAssignments extends Source({ schema: 'inventory', table: 'connection_role_assignments', primaryKey: [] }) {
  @text({ column: 'snapshot_assignment_id', max: 8000 }) snapshotAssignmentId!: string;
  @text({ column: 'run_id', max: 8000 }) runId!: string;
  @text({ column: 'connection_id', max: 8000 }) connectionId!: string;
  @text({ column: 'assignment_id', max: 8000 }) assignmentId!: string;
  @text({ column: 'principal_id', max: 8000 }) principalId!: string;
  @text({ column: 'principal_type', max: 8000 }) principalType!: string;
  @text({ optional: true, column: 'principal_display_name', max: 8000 }) principalDisplayName?: string;
  @text({ max: 8000 }) role!: string;
  @date({ column: 'collected_at' }) collectedAt!: Date;
}
