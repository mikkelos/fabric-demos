import type { ConnectionSummary } from '@rayfin-app/shared';

export type ActivityStatus = 'recent' | 'review' | 'unknown';

export function credentialLabel(value: string | null): string {
  return value?.trim() || 'Unknown';
}

export function formatReportedBoolean(value: boolean | null | undefined): string {
  return value == null ? 'Not reported' : value ? 'Yes' : 'No';
}

export function credentialDistribution(connections: readonly ConnectionSummary[]) {
  const counts = new Map<string, number>();
  for (const connection of connections) {
    const label = credentialLabel(connection.credentialType);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({
    label, count, percentage: count / connections.length * 100,
  })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function lastActivity(connection: ConnectionSummary): number | null {
  const dates = [connection.lastBoundDateTime, connection.lastCredentialUsedDateTime]
    .filter((value): value is string => value !== null)
    .map(Date.parse)
    .filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : null;
}

export function activityStatus(
  connection: ConnectionSummary,
  days: number,
  now: number
): ActivityStatus {
  const activity = lastActivity(connection);
  if (activity === null) return 'unknown';
  // Creation is not usage, but a newly created connection should not be a review candidate.
  const created = connection.createdDateTime ? Date.parse(connection.createdDateTime) : NaN;
  const latest = Math.max(activity, Number.isFinite(created) ? created : activity);
  return now - latest >= days * 86_400_000 ? 'review' : 'recent';
}

export function connectivityLabel(value: string): string {
  const labels: Record<string, string> = {
    ShareableCloud: 'Shared cloud',
    PersonalCloud: 'Personal cloud',
    OnPremisesGateway: 'On-premises',
    OnPremisesGatewayPersonal: 'Personal gateway',
    VirtualNetworkGateway: 'Virtual network',
    StreamingVirtualNetworkGateway: 'Streaming VNet',
  };
  return labels[value] ?? value;
}

export function formatDate(value: string | number | null): string {
  if (value === null) return 'Not reported';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
    : 'Not reported';
}
