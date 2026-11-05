import { describe, expect, it } from 'vitest';
import { decodeSnapshot, snapshotQuery, sqlConfig } from '../src/sql.js';

const fixture = () => ({
  run_id: '20000000-0000-4000-8000-000000000002',
  started_at: new Date('2026-10-19T10:00:00Z'),
  completed_at: new Date('2026-10-19T10:01:00Z'),
  connection_count: '1', actual_count: '1', unique_count: '1',
  connection_id: '30000000-0000-4000-8000-000000000003',
  display_name: 'Synthetic fixture', connectivity_type: 'ShareableCloud', source_type: 'SQL',
  created_at: null, last_bound_at: null, last_credential_used_at: null,
});

describe('SQL bridge boundaries', () => {
  it('uses encrypted certificate-validated SQL access-token authentication', () => {
    const config = sqlConfig({
      server: 'synthetic.database.fabric.microsoft.com', database: 'synthetic',
    }, 'synthetic-token');
    expect(config.options).toEqual({ encrypt: true, trustServerCertificate: false });
    expect(config.authentication).toEqual({
      type: 'azure-active-directory-access-token', options: { token: 'synthetic-token' },
    });
  });

  it('rejects absent SQL audience tokens', () => {
    expect(() => sqlConfig({ server: 'synthetic.invalid', database: 'synthetic' }, ''))
      .toThrow('RUNTIME_UNAVAILABLE');
  });

  it('pins counts and selection to the latest complete run in one parameterized statement', () => {
    expect(snapshotQuery).toContain("WHERE status = 'complete'");
    expect(snapshotQuery).toContain('ORDER BY started_at DESC, run_id DESC');
    expect(snapshotQuery).toContain('OPENJSON(@ConnectionIdsJson)');
    expect(snapshotQuery).toContain('c.run_id = r.run_id');
    expect(snapshotQuery).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/i);
    expect(snapshotQuery).not.toContain('SELECT *');
  });

  it('decodes baseline-only fields and exact numeric counts', () => {
    const row = fixture();
    const snapshot = decodeSnapshot([{ ...row, endpoint: 'ignored', credential: 'ignored' }]);
    expect(snapshot?.expectedCount).toBe(1);
    expect(snapshot?.connections[0]).toEqual({
      connectionId: row.connection_id, displayName: row.display_name,
      connectivityType: row.connectivity_type, sourceType: row.source_type,
      createdAt: null, lastBoundAt: null, lastCredentialUsedAt: null,
    });
  });

  it('decodes an absent complete run', () => {
    expect(decodeSnapshot([])).toBeNull();
  });

  it('decodes a manifest with no matching source rows without inventing a connection', () => {
    expect(decodeSnapshot([{ ...fixture(), connection_id: null }])?.connections).toEqual([]);
  });

  it.each(['-1', '1.5', '9007199254740992', 'private-provider-details'])(
    'rejects invalid source counts %j', connection_count => {
      expect(() => decodeSnapshot([{ ...fixture(), connection_count }])).toThrow('SNAPSHOT_INCOMPLETE');
    },
  );

  it('rejects malformed source timestamps', () => {
    expect(() => decodeSnapshot([{ ...fixture(), completed_at: 'invalid' }])).toThrow('SNAPSHOT_INCOMPLETE');
  });
});
