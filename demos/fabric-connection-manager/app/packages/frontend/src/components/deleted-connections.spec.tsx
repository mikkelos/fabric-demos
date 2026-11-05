import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DeletionActionState } from '@rayfin-app/shared';
import { DeletedConnections } from './deleted-connections';

function deleted(connectionId: string, deletedAt = '2026-10-19T12:00:00Z'): DeletionActionState {
  return { connectionId, connectionName: `Deleted ${connectionId}`, status: 'deleted',
    requestedAt: '2026-10-19T10:00:00Z', deletedAt, pendingRequestIds: [] };
}

describe('confirmed deleted connections', () => {
  it('counts distinct connections and sorts newest first, then by ID, using only confirmed deleted states', () => {
    render(<DeletedConnections loading={false} stale={false} actions={[
      deleted('b'), deleted('a'), deleted('a', '2026-10-19T09:00:00Z'), deleted('newest', '2026-10-19T13:00:00Z'),
      { ...deleted('pending'), status: 'pending', deletedAt: null, pendingRequestIds: ['request'] },
      { ...deleted('cancelled'), status: 'cancelled', deletedAt: null },
    ]} />);
    expect(screen.getByText('3 distinct connections deleted')).toBeVisible();
    const rows = within(screen.getByRole('table', { name: 'Confirmed deleted connections' })).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1].textContent)).toEqual(['newest', 'a', 'b']);
    expect(rows[0].querySelector('time')).toHaveAttribute('datetime', '2026-10-19T13:00:00Z');
    expect(screen.queryByText('Deleted pending')).toBeNull();
    expect(screen.queryByText('Deleted cancelled')).toBeNull();
  });

  it('paginates in groups of 25 and clamps the page after refreshed data shrinks', () => {
    const actions = Array.from({ length: 26 }, (_, index) => deleted(String(index).padStart(2, '0')));
    const view = render(<DeletedConnections loading={false} stale={false} actions={actions} />);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(26);
    expect(screen.getByRole('button', { name: 'Previous deleted page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next deleted page' }));
    expect(screen.getByText('Deleted page 2 of 2')).toBeVisible();
    expect(screen.getByText('Deleted 25')).toBeVisible();
    expect(screen.queryByText('Deleted 00')).toBeNull();
    view.rerender(<DeletedConnections loading={false} stale={false} actions={[deleted('00')]} />);
    expect(screen.getByText('Deleted page 1 of 1')).toBeVisible();
    expect(screen.getByText('Deleted 00')).toBeVisible();
  });

  it('does not turn loading or unavailable history into a fake zero', () => {
    const view = render(<DeletedConnections loading stale={false} actions={null} />);
    expect(screen.getByText('Confirmed deletion count unavailable')).toBeVisible();
    expect(screen.getByText('Loading confirmed deletion history...')).toBeVisible();
    expect(screen.queryByText('No confirmed deletions recorded.')).toBeNull();
    view.rerender(<DeletedConnections loading={false} stale actions={null} />);
    expect(screen.getByText(/an empty history has not been confirmed/)).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('0 distinct connections deleted')).toBeNull();
  });

  it('keeps last-known confirmed events visible and explicitly stale after a refresh failure', () => {
    render(<DeletedConnections loading={false} stale actions={[deleted('a')]} />);
    expect(screen.getByText('1 distinct connections deleted (last known)')).toBeVisible();
    expect(screen.getByText(/last successfully loaded deletion history/)).toBeVisible();
    expect(screen.getByText('Deleted a')).toBeVisible();
  });

  it('shows an honest empty state only after a successful empty result', () => {
    render(<DeletedConnections loading={false} stale={false} actions={[]} />);
    expect(screen.getByText('0 distinct connections deleted')).toBeVisible();
    expect(screen.getByText('No confirmed deletions recorded.')).toBeVisible();
  });
});
