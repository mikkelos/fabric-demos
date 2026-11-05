import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '@rayfin-app/shared';
import { activityStatus, credentialDistribution, credentialLabel, formatReportedBoolean, lastActivity } from './connection-inventory';

const now = Date.parse('2026-10-09T00:00:00Z');
const base: ConnectionSummary = {
  id: 'test', displayName: 'Test', sourceType: 'SQL',
  connectivityType: 'ShareableCloud', gatewayId: null, privacyLevel: null,
  credentialType: null, connectionEncryption: null, createdDateTime: null,
  lastBoundDateTime: null, lastCredentialUsedDateTime: null,
  myLastBoundDateTime: null, myLastCredentialUsedDateTime: null,
  owners: [], roleAssignments: [], ownerStatus: { ok: true },
};

describe('stale usage review signals', () => {
  it('keeps missing usage unknown even when creation is old', () => {
    expect(activityStatus({ ...base, createdDateTime: '2020-01-01' }, 90, now)).toBe('unknown');
  });
  it('uses the later of binding and credential use', () => {
    const item = { ...base, lastBoundDateTime: '2020-01-01', lastCredentialUsedDateTime: '2026-10-01' };
    expect(lastActivity(item)).toBe(Date.parse('2026-10-01'));
    expect(activityStatus(item, 90, now)).toBe('recent');
  });
  it('applies the threshold inclusively at exactly 90 days', () => {
    const exact = new Date(now - 90 * 86_400_000).toISOString();
    expect(activityStatus({ ...base, lastBoundDateTime: exact }, 90, now)).toBe('review');
    expect(activityStatus({ ...base, lastBoundDateTime: new Date(Date.parse(exact) + 1).toISOString() }, 90, now)).toBe('recent');
  });
  it('excludes newly created connections with old reported usage', () => {
    expect(activityStatus({ ...base, lastBoundDateTime: '2020-01-01', createdDateTime: '2026-10-01' }, 90, now)).toBe('recent');
  });
  it('does not classify invalid or future dates as stale', () => {
    expect(activityStatus({ ...base, lastBoundDateTime: 'invalid' }, 90, now)).toBe('unknown');
    expect(activityStatus({ ...base, lastBoundDateTime: '2030-01-01' }, 90, now)).toBe('recent');
  });

  describe('credential distribution', () => {
    it('groups missing and blank credential metadata as unknown', () => {
      expect(credentialLabel(null)).toBe('Unknown');
      expect(credentialLabel('  ')).toBe('Unknown');
      expect(credentialDistribution([
        base, { ...base, credentialType: '' }, { ...base, credentialType: 'OAuth2' },
        { ...base, credentialType: ' OAuth2 ' },
      ])).toEqual([
        { label: 'OAuth2', count: 2, percentage: 50 },
        { label: 'Unknown', count: 2, percentage: 50 },
      ]);
    });

    describe('reported boolean metadata', () => {
      it('distinguishes explicitly false settings from absent metadata', () => {
        expect(formatReportedBoolean(true)).toBe('Yes');
        expect(formatReportedBoolean(false)).toBe('No');
        expect(formatReportedBoolean(null)).toBe('Not reported');
        expect(formatReportedBoolean(undefined)).toBe('Not reported');
      });
    });

    it('uses only the supplied scope as denominator and handles no matches', () => {
      expect(credentialDistribution([{ ...base, credentialType: 'Key' }])).toEqual([
        { label: 'Key', count: 1, percentage: 100 },
      ]);
      expect(credentialDistribution([])).toEqual([]);
    });
  });
});
