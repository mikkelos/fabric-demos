import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '@microsoft/rayfin-lib';
import { loadConnections, type SnapshotAssignment, type SnapshotConnection, type SnapshotReader, type SnapshotRun } from './connections.service';

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@/lib/rayfin-client', () => ({ getRayfinClient: getClient }));

const started = new Date('2026-10-19T08:00:00Z');
const completed = new Date('2026-10-19T08:05:00Z');
const run: SnapshotRun = {
  runId: 'run-1', startedAt: started, completedAt: completed, status: 'complete',
  connectionCount: 1, roleAssignmentCount: 1, ownerLookupFailureCount: 0,
};
const row: SnapshotConnection = {
  snapshotId: 'run-1:connection-1', runId: 'run-1', connectionId: 'connection-1',
  displayName: 'Synthetic', connectivityType: 'ShareableCloud', sourceType: 'SQL',
  ownerLookupStatus: 'complete',
};
const assignment: SnapshotAssignment = {
  snapshotAssignmentId: 'run-1:connection-1:assignment-1', runId: 'run-1', connectionId: 'connection-1',
  assignmentId: 'assignment-1', principalId: 'principal-1', principalType: 'Group', role: 'Owner',
};
function reader(overrides: Partial<SnapshotReader> = {}): SnapshotReader {
  return {
    latestRun: vi.fn(async () => ({ ...run })),
    connections: vi.fn(async () => ({ items: [{ ...row }], hasNextPage: false })),
    assignments: vi.fn(async () => ({ items: [{ ...assignment }], hasNextPage: false })),
    ...overrides,
  };
}

describe('published snapshot inventory', () => {
  beforeEach(() => getClient.mockReset());

  it('maps complete rows and owner principals and reports collection freshness', async () => {
    const source = reader();
    const result = await loadConnections(source);
    expect(result.runId).toBe('run-1');
    expect(result.collectedAt).toBe(completed.toISOString());
    expect(result.connections[0]).toMatchObject({
      id: 'connection-1', displayName: 'Synthetic', createdDateTime: null,
      owners: [{ id: 'principal-1', type: 'Group', displayName: null }],
      ownerStatus: { ok: true },
    });
    expect(source.latestRun).toHaveBeenCalledTimes(1);
    expect(source.connections).toHaveBeenCalledWith('run-1', undefined);
    expect(source.assignments).toHaveBeenCalledWith('run-1', undefined);
  });

  it('distinguishes an empty complete snapshot from no collected snapshot', async () => {
    await expect(loadConnections(reader({ latestRun: async () => null }))).rejects.toThrow('No completed inventory snapshot');
    const empty = await loadConnections(reader({
      latestRun: async () => ({ ...run, connectionCount: 0, roleAssignmentCount: 0 }),
      connections: async () => ({ items: [], hasNextPage: false }),
      assignments: async () => ({ items: [], hasNextPage: false }),
    }));
    expect(empty.connections).toEqual([]);
    expect(empty.collectedAt).toBe(completed.toISOString());
  });

  it('maps security metadata and strips endpoint paths, credentials and queries again on read', async () => {
    const result = await loadConnections(reader({
      connections: async () => ({
        items: [{ ...row, endpoint: 'https://user:synthetic@example.invalid/private?key=synthetic#token',
          endpointCategory: 'HTTP', singleSignOnType: 'None', skipTestConnection: false,
          allowUsageInUserControlledCode: true, allowConnectionUsageInGateway: false }],
        hasNextPage: false,
      }),
    }));
    expect(result.connections[0]).toMatchObject({
      endpoint: 'https://example.invalid', endpointCategory: 'HTTP', singleSignOnType: 'None',
      skipTestConnection: false, allowUsageInUserControlledCode: true, allowConnectionUsageInGateway: false,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic#token');
  });

  it('rejects unsafe stored endpoint schemes rather than showing a clickable value', async () => {
    await expect(loadConnections(reader({
      connections: async () => ({ items: [{ ...row, endpoint: 'javascript:alert(1)' }], hasNextPage: false }),
    }))).rejects.toThrow('inconsistent');
  });

  it('keeps absent security metadata unknown instead of treating it as disabled', async () => {
    const result = await loadConnections(reader());
    expect(result.connections[0]).toMatchObject({
      endpoint: null, endpointCategory: null, singleSignOnType: null,
      skipTestConnection: null, allowUsageInUserControlledCode: null, allowConnectionUsageInGateway: null,
    });
  });

  it('preserves explicit lookup failures without claiming successful empty roles', async () => {
    const result = await loadConnections(reader({
      latestRun: async () => ({ ...run, roleAssignmentCount: 0, ownerLookupFailureCount: 1 }),
      connections: async () => ({ items: [{ ...row, ownerLookupStatus: 'failed', ownerLookupErrorCode: 'permission' }], hasNextPage: false }),
      assignments: async () => ({ items: [], hasNextPage: false }),
    }));
    expect(result.ownerLookupFailureCount).toBe(1);
    expect(result.connections[0].ownerStatus).toMatchObject({ ok: false, code: 'permission' });
  });

  it('pins every page to the selected run and follows opaque cursors', async () => {
    const connections = vi.fn<SnapshotReader['connections']>()
      .mockResolvedValueOnce({ items: [row], hasNextPage: true, endCursor: 'opaque+/=' })
      .mockResolvedValueOnce({ items: [{ ...row, snapshotId: 'run-1:second', connectionId: 'second' }], hasNextPage: false });
    const source = reader({ latestRun: async () => ({ ...run, connectionCount: 2 }), connections });
    expect((await loadConnections(source)).connections).toHaveLength(2);
    expect(connections.mock.calls).toEqual([['run-1', undefined], ['run-1', 'opaque+/=']]);
  });

  it('loads an enterprise-sized snapshot through bounded connector pages', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      ...row, connectionId: `connection-${i}`, snapshotId: `run-1:connection-${i}`,
    }));
    const connections = vi.fn<SnapshotReader['connections']>(async (_runId, cursor) => {
      const offset = Number(cursor ?? 0);
      const end = offset + 500;
      return { items: rows.slice(offset, end), hasNextPage: end < rows.length, endCursor: String(end) };
    });
    const result = await loadConnections(reader({
      latestRun: async () => ({ ...run, connectionCount: rows.length, roleAssignmentCount: 0 }),
      connections, assignments: async () => ({ items: [], hasNextPage: false }),
    }));
    expect(result.connections).toHaveLength(5001);
    expect(connections).toHaveBeenCalledTimes(11);
    expect(connections.mock.calls.every(([runId]) => runId === 'run-1')).toBe(true);
  });

  it.each([0, 2])('rejects incomplete or extra connection rows against manifest count %s', async (connectionCount) => {
    await expect(loadConnections(reader({
      latestRun: async () => ({ ...run, connectionCount }),
    }))).rejects.toThrow('not fully visible or is inconsistent');
  });

  it('rejects assignment count mismatches independently', async () => {
    await expect(loadConnections(reader({
      assignments: async () => ({ items: [], hasNextPage: false }),
    }))).rejects.toThrow('not fully visible');
  });

  it('rejects duplicate connections and run mixing', async () => {
    for (const extra of [row, { ...row, snapshotId: 'run-2:second', runId: 'run-2', connectionId: 'second' }]) {
      await expect(loadConnections(reader({
        latestRun: async () => ({ ...run, connectionCount: 2 }),
        connections: async () => ({ items: [row, extra], hasNextPage: false }),
      }))).rejects.toThrow('inconsistent');
    }
  });

  it('rejects duplicate and orphaned assignments', async () => {
    await expect(loadConnections(reader({
      latestRun: async () => ({ ...run, roleAssignmentCount: 2 }),
      assignments: async () => ({ items: [assignment, assignment], hasNextPage: false }),
    }))).rejects.toThrow('inconsistent');
    await expect(loadConnections(reader({
      assignments: async () => ({ items: [{ ...assignment, connectionId: 'missing' }], hasNextPage: false }),
    }))).rejects.toThrow('inconsistent');
  });

  it('checks lookup-failure counts and rejects unknown status/error codes', async () => {
    for (const ownerLookupStatus of ['unknown', 'failed']) {
      await expect(loadConnections(reader({
        connections: async () => ({ items: [{ ...row, ownerLookupStatus, ownerLookupErrorCode: 'private-error' }], hasNextPage: false }),
      }))).rejects.toThrow('inconsistent');
    }
    await expect(loadConnections(reader({
      latestRun: async () => ({ ...run, ownerLookupFailureCount: 1 }),
    }))).rejects.toThrow('inconsistent');
  });

  it.each([NaN, -1, 100_001, 1.5])('rejects unsafe connection counts %s before reading tables', async (connectionCount) => {
    const source = reader({ latestRun: async () => ({ ...run, connectionCount }) });
    await expect(loadConnections(source)).rejects.toThrow('invalid counts');
    expect(source.connections).not.toHaveBeenCalled();
  });

  it.each([null, 'repeat'])('rejects missing or repeated page cursors %s', async (endCursor) => {
    await expect(loadConnections(reader({
      connections: async () => ({ items: [], hasNextPage: true, endCursor }),
    }))).rejects.toThrow('inconsistent');
  });

  it('never returns earlier pages after a later connector read fails', async () => {
    const connections = vi.fn<SnapshotReader['connections']>()
      .mockResolvedValueOnce({ items: [row], hasNextPage: true, endCursor: 'next' })
      .mockRejectedValueOnce(new Error('private provider response'));
    await expect(loadConnections(reader({ connections }))).rejects.toThrow('snapshot connector could not read');
    await expect(loadConnections(reader({ latestRun: async () => { throw new Error('private provider response'); } })))
      .rejects.not.toThrow('private provider');
  });

  it.each([[401, 'Sign in again'], [403, 'connector identity permissions'], [503, 'SQL endpoint permissions']])(
    'provides safe connector guidance for HTTP %s', async (status, message) => {
      getClient.mockRejectedValueOnce(new NetworkError('private provider response', status));
      await expect(loadConnections()).rejects.toThrow(message);
    },
  );

  it('uses only typed connector reads by default, not Functions or admin APIs', async () => {
    function query<T>(items: T[]) {
      return {
        select: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(), first: vi.fn().mockReturnThis(),
        execute: vi.fn(async () => items),
        executePaginated: vi.fn(async () => ({ items, hasNextPage: false })),
      };
    }
    const runs = query([run]);
    const connections = query([row]);
    const assignments = query([assignment]);
    getClient.mockResolvedValueOnce({ connectors: { connectioninventory: {
      CollectionRuns: runs, ConnectionSnapshots: connections, ConnectionRoleAssignments: assignments,
    } } });
    expect((await loadConnections()).connections).toHaveLength(1);
    expect(runs.where).toHaveBeenCalledWith({ status: { eq: 'complete' } });
    expect(runs.orderBy).toHaveBeenCalledWith({ startedAt: 'desc', runId: 'desc' });
    expect(connections.where).toHaveBeenCalledWith({ runId: { eq: 'run-1' } });
    expect(assignments.where).toHaveBeenCalledWith({ runId: { eq: 'run-1' } });
  });
});
