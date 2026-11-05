import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VegaVisual, type VegaVisualProps } from '@microsoft/fabric-visuals';
import type { ConnectionSummary } from '@rayfin-app/shared';
import { CredentialDistribution } from './credential-distribution';

vi.mock('@microsoft/fabric-visuals', () => ({
  useCssTheme: () => ({ brandForeground: 'theme-brand' }),
  VegaVisual: vi.fn(() => <div />),
}));

const connection: ConnectionSummary = {
  id: 'test', displayName: 'Test', sourceType: 'SQL', connectivityType: 'ShareableCloud',
  gatewayId: null, privacyLevel: null, credentialType: 'OAuth2', connectionEncryption: null,
  createdDateTime: null, lastBoundDateTime: null, lastCredentialUsedDateTime: null,
  myLastBoundDateTime: null, myLastCredentialUsedDateTime: null,
  owners: [], roleAssignments: [], ownerStatus: { ok: true },
};

describe('credential distribution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('provides exact accessible counts, shares, unknown meaning, and filter scope', () => {
    const onSelect = vi.fn();
    render(<CredentialDistribution connections={[connection, { ...connection, credentialType: null }]}
      loaded selectedCredential="" onSelect={onSelect} />);
    expect(screen.getByRole('region', { name: 'Credential distribution' })).toHaveTextContent('including credential type, before pagination');
    expect(screen.getByText(/Percentages use the 2 matching connections/)).toHaveTextContent('not the tenant total');
    expect(screen.getByText(/Unknown means credential metadata is missing/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filter credential type: OAuth2' })).toHaveTextContent('1 (50.0%)');
    fireEvent.click(screen.getByRole('button', { name: 'Filter credential type: Unknown' }));
    expect(onSelect).toHaveBeenCalledWith('Unknown');
    const chart = vi.mocked(VegaVisual).mock.calls[0]?.[0] as VegaVisualProps;
    expect(chart.spec).toMatchObject({ data: { name: 'credentialDistribution' } });
    expect(chart.data).toMatchObject({ credentialDistribution: { rows: [['OAuth2', 1, 50], ['Unknown', 1, 50]] } });
    expect(chart.theme).toMatchObject({ brandForeground: 'theme-brand' });
  });

  it('allows keyboard-equivalent controls to clear the selected credential filter', () => {
    const onSelect = vi.fn();
    render(<CredentialDistribution connections={[connection]} loaded selectedCredential="OAuth2" onSelect={onSelect} />);
    const button = screen.getByRole('button', { name: 'Filter credential type: OAuth2' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('1 (100.0%)');
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('uses chart credential predicates only and supports clearing chart selections', () => {
    const onSelect = vi.fn();
    render(<CredentialDistribution connections={[connection]} loaded selectedCredential="" onSelect={onSelect} />);
    const chart = vi.mocked(VegaVisual).mock.calls[0]?.[0] as VegaVisualProps;
    chart.onInteraction?.([{ action: 'select', selections: [{ predicates: [
      { type: 'set', name: 'count', values: [1] },
      { type: 'set', name: 'credential', values: ['OAuth2'] },
    ] }] }]);
    expect(onSelect).toHaveBeenLastCalledWith('OAuth2');
    onSelect.mockClear();
    chart.onInteraction?.([{ action: 'select', selections: [{ predicates: [{ type: 'set', name: 'credential', values: ['not-in-scope'] }] }] }]);
    expect(onSelect).not.toHaveBeenCalled();
    chart.onInteraction?.([{ action: 'clear' }]);
    expect(onSelect).toHaveBeenLastCalledWith('');
  });

  it('does not present an unloaded inventory as an empty distribution', () => {
    render(<CredentialDistribution connections={[]} loaded={false} selectedCredential="" onSelect={vi.fn()} />);
    expect(screen.getByText('Distribution available after the inventory loads.')).toBeVisible();
    expect(vi.mocked(VegaVisual)).not.toHaveBeenCalled();
  });

  it('does not render misleading zero shares or a chart when no connections match', () => {
    render(<CredentialDistribution connections={[]} loaded selectedCredential="" onSelect={vi.fn()} />);
    expect(screen.getByText('No connections match the current filters.')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(vi.mocked(VegaVisual)).not.toHaveBeenCalled();
  });
});
