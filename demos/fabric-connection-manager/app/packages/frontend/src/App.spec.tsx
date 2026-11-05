import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSummary, DeletionActionState } from '@rayfin-app/shared';
import { ConnectionLoadError, loadConnections, type ConnectionInventory } from './services/connections.service';
import { DeletionLogError, logForDeletion } from '@/services/deletion-requests.service';
import { cancelDeletionRequests, DeletionActionsLoadError, DeletionCancellationError, loadDeletionActions } from '@/services/deletion-actions.service';
import App from './App';

vi.mock('@microsoft/fabric-visuals', () => ({
  useCssTheme: () => ({}),
  VegaVisual: () => <div />,
}));

vi.mock('./services/connections.service', async (original) => ({
  ...await original<typeof import('./services/connections.service')>(),
  loadConnections: vi.fn(),
}));

vi.mock('@/services/deletion-requests.service', async (original) => ({
  ...await original<typeof import('@/services/deletion-requests.service')>(),
  logForDeletion: vi.fn(),
}));

vi.mock('@/services/deletion-actions.service', async (original) => ({
  ...await original<typeof import('@/services/deletion-actions.service')>(),
  loadDeletionActions: vi.fn(),
  cancelDeletionRequests: vi.fn(),
  DeletionCancellationError: class extends Error {
    constructor(readonly acknowledgedCount: number, cause: unknown) {
      super(`Cancellation response unavailable; ${acknowledgedCount} requests confirmed.`, { cause });
    }
  },
}));

const nativeDialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
};

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

afterAll(() => {
  for (const method of ['showModal', 'close'] as const) {
    const descriptor = nativeDialogMethods[method];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  }
});

function connection(id: string, fields: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id, displayName: `Connection ${id}`, sourceType: 'SQL',
    connectivityType: 'ShareableCloud', gatewayId: null,
    privacyLevel: 'Organizational', credentialType: 'OAuth2',
    connectionEncryption: 'Encrypted', createdDateTime: null,
    lastBoundDateTime: null, lastCredentialUsedDateTime: null,
    myLastBoundDateTime: null, myLastCredentialUsedDateTime: null,
    owners: [], roleAssignments: [], ownerStatus: { ok: true }, ...fields,
  };
}

function inventory(connections: ConnectionSummary[]): ConnectionInventory {
  return { connections, runId: 'synthetic-run', collectedAt: '2026-10-19T08:00:00Z', startedAt: '2026-10-19T07:55:00Z', ownerLookupFailureCount: 0 };
}

function deletionAction(connectionId: string, status: DeletionActionState['status'] = 'pending', fields: Partial<DeletionActionState> = {}): DeletionActionState {
  return {
    connectionId, connectionName: `Connection ${connectionId}`, status,
    requestedAt: '2026-10-19T10:00:00Z',
    deletedAt: status === 'deleted' ? '2026-10-19T11:00:00Z' : null,
    pendingRequestIds: status === 'pending' ? [`request-${connectionId}`] : [],
    ...fields,
  };
}

describe('connection dashboard', () => {
  beforeEach(() => {
    vi.mocked(loadDeletionActions).mockReset();
    vi.mocked(loadDeletionActions).mockResolvedValue([]);
    vi.mocked(cancelDeletionRequests).mockReset();
    vi.mocked(cancelDeletionRequests).mockImplementation(async (request) => ({ cancelledCount: request.requestIds.length }));
    vi.mocked(logForDeletion).mockReset();
    vi.mocked(logForDeletion).mockImplementation(async (request) => ({
      requestId: request.requestId, markedCount: request.connectionIds.length,
    }));
    vi.mocked(loadConnections).mockReset();
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      connection('a', { displayName: 'Finance', lastCredentialUsedDateTime: '2020-01-01T00:00:00Z' }),
      connection('b', { displayName: 'Operations', sourceType: 'Web', connectivityType: 'OnPremisesGateway', gatewayId: 'gateway-1' }),
    ]));
  });

  it('shows only safe Function failure identifiers while keeping commands disabled', async () => {
    const reference = '11111111-1111-4111-8111-111111111111';
    const cause = Object.assign(new Error(JSON.stringify({
      failureCode: 'IDENTITY_UNAVAILABLE', correlationId: reference,
      privateDetails: 'synthetic-provider-body-must-not-be-displayed',
    })), { status: 500 });
    vi.mocked(loadDeletionActions).mockRejectedValueOnce(new DeletionActionsLoadError(cause));
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('getDeletionActions: HTTP 500. Code: IDENTITY_UNAVAILABLE.');
    expect(alert).toHaveTextContent(`Reference: ${reference}`);
    expect(alert).not.toHaveTextContent('synthetic-provider-body');
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel deletion request' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh deletion status' })).toBeEnabled();
  });

  it('reloads actual status after marking and shows a selectable pending badge, note, and request time', async () => {
    vi.mocked(loadDeletionActions).mockResolvedValueOnce([]).mockResolvedValueOnce([deletionAction('a')]);
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    expect(await screen.findByText('Pending deletion')).toHaveClass('bg-pending-deletion', 'text-pending-deletion-foreground');
    expect(screen.getByText('Pending deletion')).not.toHaveClass('bg-review');
    expect(loadDeletionActions).toHaveBeenCalledTimes(2);
    const row = screen.getByRole('button', { name: 'Finance' }).closest('tr')!;
    expect(row).toHaveClass('bg-secondary');
    expect(within(row).getByText('Review stale usage')).toBeVisible();
    expect(within(row).getByText('Pending requests can be selected for cancellation.')).toBeVisible();
    expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-10-19T10:00:00Z');
    const checkbox = screen.getByRole('checkbox', { name: 'Select Finance (a)' });
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel deletion request' })).not.toBeDisabled();
  });

  it('blocks processed states, permits cancelled connections to be re-marked, and fails closed for mixed selections', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory(['pending', 'processing', 'reconcile', 'deleted', 'cancelled'].map((id) => connection(id))));
    vi.mocked(loadDeletionActions).mockResolvedValue([
      deletionAction('pending'), deletionAction('processing', 'processing'), deletionAction('reconcile', 'reconcile'),
      deletionAction('deleted', 'deleted'), deletionAction('cancelled', 'cancelled'),
    ]);
    render(<App />);
    await screen.findByText('Pending deletion');
    for (const id of ['processing', 'reconcile', 'deleted']) {
      const checkbox = screen.getByRole('checkbox', { name: `Select Connection ${id} (${id})` });
      expect(checkbox).toBeDisabled();
      expect(checkbox).toHaveAccessibleDescription(/Selection unavailable/);
    }
    const all = screen.getByRole('checkbox', { name: 'Select all filtered connections' });
    fireEvent.click(all);
    expect(screen.getByText('2 selected of 5 filtered connections (all pages).')).toBeVisible();
    expect(all).toBeChecked();
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel deletion request' })).toBeDisabled();
    expect(screen.getByText(/Mixed selections cannot perform either operation/)).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Connection pending (pending)' }));
    expect(all).toBePartiallyChecked();
    expect(screen.getByRole('button', { name: 'log for deletion' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel deletion request' })).toBeDisabled();
  });

  it('selects all selectable filtered rows beyond page one, excluding processed rows and other source filters', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      ...Array.from({ length: 30 }, (_, index) => connection(String(index).padStart(2, '0'))),
      connection('outside', { sourceType: 'Web' }),
    ]));
    vi.mocked(loadDeletionActions).mockResolvedValue([
      deletionAction('00', 'processing'), deletionAction('01', 'deleted'), deletionAction('03'),
    ]);
    render(<App />);
    await screen.findByRole('button', { name: 'Connection 00' });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'SQL' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all filtered connections' }));
    expect(screen.getByText('28 selected of 30 filtered connections (all pages).')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select Connection 00 (00)' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Connection 01 (01)' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('checkbox', { name: 'Select Connection 29 (29)' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Connection 03 (03)' }));
    expect(screen.getByRole('button', { name: 'log for deletion' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    await screen.findByText('27 connections persisted in the deletion log. No connections were deleted.');
    const ids = vi.mocked(logForDeletion).mock.calls[0]?.[0].connectionIds;
    expect(ids).toHaveLength(27);
    for (const id of ['00', '01', '03', 'outside']) expect(ids).not.toContain(id);
    expect(ids).toContain('29');
  });

  it('cancels only captured unique request IDs, preserves that payload on failure, and reloads actual cancellation state', async () => {
    vi.mocked(loadDeletionActions).mockResolvedValueOnce([
      deletionAction('a', 'pending', { pendingRequestIds: ['request-a', 'shared'] }),
      deletionAction('b', 'pending', { pendingRequestIds: ['shared', 'request-b'] }),
    ]).mockResolvedValueOnce([deletionAction('a', 'cancelled'), deletionAction('b', 'cancelled')]);
    vi.mocked(cancelDeletionRequests).mockRejectedValueOnce(new DeletionCancellationError(0, new Error('The cancellation response was unavailable.')));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all filtered connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel deletion request' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm request cancellation' });
    expect(dialog).toHaveTextContent('Cancel the captured pending requests for 2 selected connections');
    expect(dialog).toHaveTextContent('This action does not delete any connections');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(cancelDeletionRequests).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('retry uses the same captured request IDs');
    expect(cancelDeletionRequests).toHaveBeenCalledWith({ requestIds: ['request-a', 'request-b', 'shared'] });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'cancel deletion request' })).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'cancel deletion request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    await screen.findByText('3 deletion requests cancelled. No connections were deleted.');
    expect(vi.mocked(cancelDeletionRequests).mock.calls[1]?.[0]).toEqual(vi.mocked(cancelDeletionRequests).mock.calls[0]?.[0]);
    expect(await screen.findAllByText('Deletion cancelled')).toHaveLength(2);
    expect(loadDeletionActions).toHaveBeenCalledTimes(2);
    expect(logForDeletion).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).not.toBeChecked();
  });

  it('prevents cancellation duplicates, refresh, page changes, and escape while a cancellation is in flight', async () => {
    vi.mocked(loadDeletionActions).mockResolvedValue([deletionAction('a')]);
    let resolve: ((result: { cancelledCount: number }) => void) | undefined;
    vi.mocked(cancelDeletionRequests).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel deletion request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(screen.getByRole('button', { name: 'Cancelling requests...' })).toBeDisabled();
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent('Saving to database... Please wait for confirmation. No connections are being deleted.');
    expect(screen.getByRole('button', { name: 'Refresh connections' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deleted' })).toBeDisabled();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelling requests...' }));
    expect(cancelDeletionRequests).toHaveBeenCalledTimes(1);
    await act(async () => resolve?.({ cancelledCount: 1 }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('loads status independently, disables commands on first-load failure, and does not fake an empty deleted history', async () => {
    let reject: ((failure: unknown) => void) | undefined;
    vi.mocked(loadDeletionActions).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel deletion request' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Deleted' }));
    expect(screen.getByText('Confirmed deletion count unavailable')).toBeVisible();
    expect(screen.queryByText('0 distinct connections deleted')).toBeNull();
    await act(async () => reject?.(new Error('private provider body')));
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable, not empty');
    expect(screen.queryByText('private provider body')).toBeNull();
    expect(screen.getByText(/an empty history has not been confirmed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' }))
      .toHaveAccessibleDescription('Deletion checkboxes are disabled until deletion status is successfully refreshed.');
    expect(screen.getByRole('checkbox', { name: 'Select all filtered connections' }))
      .toHaveAccessibleDescription(/Deletion checkboxes are disabled/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh deletion status' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).not.toBeDisabled());
    expect(screen.queryByText('Deletion checkboxes are disabled until deletion status is successfully refreshed.')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeChecked();
    expect(loadConnections).toHaveBeenCalledTimes(1);
  });

  it('refreshes inventory and status independently and preserves stale known status and history with commands disabled', async () => {
    vi.mocked(loadDeletionActions).mockResolvedValueOnce([deletionAction('a'), deletionAction('gone', 'deleted')])
      .mockRejectedValueOnce(new Error('Status refresh failed.'));
    render(<App />);
    await screen.findByText('Pending deletion');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Previous deletion status and history remain visible and may be stale');
    expect(loadConnections).toHaveBeenCalledTimes(2);
    expect(loadDeletionActions).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Pending deletion')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Deleted' }));
    expect(screen.getByText('1 distinct connections deleted (last known)')).toBeVisible();
    expect(screen.getByText('Connection gone')).toBeVisible();
  });

  it.each(['mark', 'cancel'] as const)('reports persisted %s success separately from a subsequent status-refresh failure', async (operation) => {
    vi.mocked(loadDeletionActions).mockResolvedValueOnce(operation === 'mark' ? [] : [deletionAction('a')])
      .mockRejectedValueOnce(new Error('Status refresh failed.'));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name: operation === 'mark' ? 'log for deletion' : 'cancel deletion request' }));
    fireEvent.click(screen.getByRole('button', { name: operation === 'mark' ? 'Confirm logging' : 'Confirm cancellation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Deletion status could not be refreshed');
    expect(screen.getByRole('status')).toHaveTextContent(operation === 'mark' ? '1 connections persisted' : '1 deletion requests cancelled');
    expect(screen.queryByText(/Logging could not be confirmed/)).toBeNull();
    expect(screen.queryByText(/Cancellation could not be confirmed/)).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh deletion status' }));
    await screen.findByRole('checkbox', { name: 'Select Finance (a)' });
    expect(operation === 'mark' ? logForDeletion : cancelDeletionRequests).toHaveBeenCalledTimes(1);
  });

  it('shows a separate Deleted page based only on confirmed events, independent of inventory filters and snapshot membership', async () => {
    vi.mocked(loadDeletionActions).mockResolvedValue([
      deletionAction('old', 'deleted', { connectionName: 'Old confirmed name', deletedAt: '2026-10-18T12:00:00Z' }),
      deletionAction('new', 'deleted', { connectionName: 'New confirmed name', deletedAt: '2026-10-19T12:00:00Z' }),
      deletionAction('a'), deletionAction('b', 'cancelled'),
    ]);
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Web' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deleted' }));
    expect(screen.getByRole('heading', { name: 'Deleted' })).toHaveFocus();
    expect(screen.getByText('2 distinct connections deleted')).toBeVisible();
    const rows = within(screen.getByRole('table', { name: 'Confirmed deleted connections' })).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1].textContent)).toEqual(['new', 'old']);
    expect(rows[0]).toHaveTextContent('New confirmed name');
    expect(rows[0].querySelector('time')).toHaveAttribute('datetime', '2026-10-19T12:00:00Z');
    expect(screen.queryByRole('button', { name: 'Finance' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    expect(screen.getByLabelText('Source')).toHaveValue('Web');
    expect(screen.getByRole('button', { name: 'Operations' })).toBeVisible();
  });

  it('keeps confirmed deletion history available when the independent inventory snapshot read fails', async () => {
    vi.mocked(loadConnections).mockRejectedValueOnce(new ConnectionLoadError('Snapshot read unavailable.'));
    vi.mocked(loadDeletionActions).mockResolvedValue([
      deletionAction('confirmed', 'deleted', { connectionName: 'Recorded deletion' }),
    ]);
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Snapshot read unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Deleted' }));
    expect(screen.getByText('1 distinct connections deleted')).toBeVisible();
    expect(screen.getByRole('table', { name: 'Confirmed deleted connections' })).toHaveTextContent('Recorded deletion');
    expect(screen.getByText(/across all inventory filters/)).toBeVisible();
    expect(screen.getByText(/Unlogged admin deletions are not audit records/)).toBeVisible();
  });

  it('does not infer deletions from an empty snapshot or cancellation-only audit records', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([]));
    vi.mocked(loadDeletionActions).mockResolvedValue([deletionAction('cancelled-verification', 'cancelled')]);
    render(<App />);
    await screen.findByText('No tenant connections returned');
    fireEvent.click(screen.getByRole('button', { name: 'Deleted' }));
    expect(screen.getByText('0 distinct connections deleted')).toBeVisible();
    expect(screen.getByText('No confirmed deletions recorded.')).toBeVisible();
    expect(screen.queryByRole('table', { name: 'Confirmed deleted connections' })).toBeNull();
  });

  it('selects the full filtered context beyond the current page and logs only after confirmation', async () => {
    const sqlConnections = Array.from({ length: 30 }, (_, index) => connection(String(index).padStart(2, '0')));
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      ...sqlConnections, connection('outside', { sourceType: 'Web' }),
    ]));
    render(<App />);
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    await screen.findByRole('button', { name: 'Connection 00' });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'SQL' } });
    const all = screen.getByRole('checkbox', { name: 'Select all filtered connections' });
    fireEvent.click(all);
    expect(all).toBeChecked();
    expect(all).not.toBePartiallyChecked();
    expect(screen.getByText('30 selected of 30 filtered connections (all pages).')).toBeVisible();
    expect(screen.getAllByRole('checkbox')).toHaveLength(26);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('checkbox', { name: 'Select Connection 29 (29)' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm deletion logging' });
    expect(dialog).toHaveTextContent('Log 30 selected connections from the current 30 filtered connections across all pages.');
    expect(dialog).toHaveTextContent('No connections are deleted now');
    expect(dialog).toHaveTextContent('no admin deletion API is called');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(logForDeletion).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm logging' }));
    expect(await screen.findByText('30 connections persisted in the deletion log. No connections were deleted.')).toBeVisible();
    expect(logForDeletion).toHaveBeenCalledExactlyOnceWith({
      requestId: expect.any(String), snapshotRunId: 'synthetic-run', connectionIds: sqlConnections.map((item) => item.id),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    expect(screen.getByText('0 selected of 30 filtered connections (all pages).')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select Connection 29 (29)' })).not.toBeChecked();
  });

  it('keeps partial selection across pages and sorting, and supports select-all and clear-all', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory(Array.from({ length: 26 }, (_, index) =>
      connection(String(index).padStart(2, '0')))));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection 00' });
    const all = screen.getByRole('checkbox', { name: 'Select all filtered connections' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Connection 00 (00)' }));
    expect(all).toBePartiallyChecked();
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('checkbox', { name: 'Select Connection 25 (25)' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Connection 25 (25)' }));
    expect(screen.getByText('2 selected of 26 filtered connections (all pages).')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'activity' } });
    fireEvent.change(screen.getByLabelText('Search source options'), { target: { value: 'sql' } });
    expect(screen.getByRole('checkbox', { name: 'Select Connection 00 (00)' })).toBeChecked();
    expect(screen.getByText('2 selected of 26 filtered connections (all pages).')).toBeVisible();
    fireEvent.click(all);
    expect(all).toBeChecked();
    expect(all).not.toBePartiallyChecked();
    fireEvent.click(all);
    expect(all).not.toBeChecked();
    expect(all).not.toBePartiallyChecked();
    expect(all).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('0 selected of 26 filtered connections (all pages).')).toBeVisible();
  });

  it.each([
    ['Search connections', 'Fin'], ['Source', 'SQL'], ['Connectivity', 'ShareableCloud'],
    ['Credential type', 'OAuth2'], ['Activity', 'review'], ['Stale usage threshold', '30'],
  ])('clears selection when the %s filter context changes without restoring it on revert', async (label, value) => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    const filter = screen.getByLabelText(label);
    const previous = (filter as HTMLInputElement | HTMLSelectElement).value;
    fireEvent.change(filter, { target: { value } });
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    fireEvent.change(filter, { target: { value: previous } });
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).not.toBeChecked();
  });

  it.each(['Clear filters', 'Show stale usage', 'Filter credential type: OAuth2'])('clears selection through %s', async (name) => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).not.toBeChecked();
  });

  it('clears selection immediately when refresh starts and keeps a stale display unavailable for logging', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    let reject: ((reason: unknown) => void) | undefined;
    vi.mocked(loadConnections).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }));
    expect(screen.getByText('0 selected of 2 filtered connections (all pages).')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    await act(async () => reject?.(new ConnectionLoadError('Refresh read failed.')));
    expect(screen.getByRole('alert')).toHaveTextContent('may be out of date');
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select all filtered connections' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'log for deletion' })).toBeDisabled();
    expect(logForDeletion).not.toHaveBeenCalled();
    vi.mocked(loadConnections).mockResolvedValueOnce({ ...inventory([connection('new')]), runId: 'new-run' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const fresh = await screen.findByRole('checkbox', { name: 'Select Connection new (new)' });
    expect(fresh).not.toBeChecked();
    expect(fresh).not.toBeDisabled();
    fireEvent.click(fresh);
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    await screen.findByText('1 connections persisted in the deletion log. No connections were deleted.');
    expect(logForDeletion).toHaveBeenCalledWith(expect.objectContaining({ snapshotRunId: 'new-run', connectionIds: ['new'] }));
  });

  it('cancels confirmation without calling the service or discarding the selection', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'log for deletion' })).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeChecked();
    expect(logForDeletion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(logForDeletion).not.toHaveBeenCalled();
  });

  it('preserves selection and the same request ID after an unconfirmed failure and reports the persisted count', async () => {
    vi.mocked(logForDeletion).mockRejectedValueOnce(new Error('private provider body'));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Logging could not be confirmed');
    expect(screen.queryByText('private provider body')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeChecked();
    const firstRequest = vi.mocked(logForDeletion).mock.calls[0]?.[0];
    expect(firstRequest?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry logging' }));
    await screen.findByText('1 connections persisted in the deletion log. No connections were deleted.');
    expect(vi.mocked(logForDeletion).mock.calls[1]?.[0]).toEqual(firstRequest);
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).not.toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports confirmed partial logging and preserves the original selection for a safe retry', async () => {
    const connections = Array.from({ length: 501 }, (_, index) => connection(`bulk-${index}`));
    vi.mocked(loadConnections).mockResolvedValueOnce(inventory(connections));
    vi.mocked(logForDeletion).mockRejectedValueOnce(new DeletionLogError(500, new Error('private provider body')));
    render(<App />);
    await screen.findByRole('checkbox', { name: 'Select all filtered connections' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all filtered connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('500 connection(s) confirmed saved');
    expect(alert).toHaveTextContent('the last batch may also have been saved');
    expect(alert).toHaveTextContent('Displayed deletion status may be out of date');
    expect(alert).not.toHaveTextContent('private provider body');
    const firstRequest = vi.mocked(logForDeletion).mock.calls[0]?.[0];
    expect(firstRequest?.connectionIds).toHaveLength(501);
    expect(screen.getByRole('checkbox', { name: 'Select all filtered connections' })).toBeChecked();
    expect(loadDeletionActions).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry logging' }));
    await waitFor(() => expect(logForDeletion).toHaveBeenCalledTimes(2));
    expect(vi.mocked(logForDeletion).mock.calls[1]?.[0]).toEqual(firstRequest);
  });

  it('explains that stale inventory requires another collector run, not repeated logging', async () => {
    vi.mocked(logForDeletion).mockRejectedValueOnce(new DeletionLogError(0,
      new Error('SNAPSHOT_STALE: {"failureCode":"SNAPSHOT_STALE"} private provider body')));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('SNAPSHOT_STALE');
    expect(alert).toHaveTextContent('Run CollectConnectionInventory in Fabric');
    expect(alert).not.toHaveTextContent('private provider body');
    expect(screen.getByRole('checkbox', { name: 'Select Finance (a)' })).toBeChecked();
  });

  it('changes the request ID after a failed selection is modified, even if the original IDs are reselected', async () => {
    vi.mocked(logForDeletion).mockRejectedValueOnce(new Error('Write failed.'));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    const checkbox = screen.getByRole('checkbox', { name: 'Select Finance (a)' });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    await screen.findByRole('alert');
    const firstId = vi.mocked(logForDeletion).mock.calls[0]?.[0].requestId;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    await screen.findByText('1 connections persisted in the deletion log. No connections were deleted.');
    expect(vi.mocked(logForDeletion).mock.calls[1]?.[0].requestId).not.toBe(firstId);
  });

  it('prevents duplicate submissions and disables refresh while persistence is pending', async () => {
    let resolve: ((result: Awaited<ReturnType<typeof logForDeletion>>) => void) | undefined;
    vi.mocked(logForDeletion).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Finance (a)' }));
    fireEvent.click(screen.getByRole('button', { name: 'log for deletion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm logging' }));
    expect(screen.getByRole('button', { name: 'Saving to database...' })).toBeDisabled();
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent('Saving to database... Please wait for confirmation. No connections are being deleted.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh connections' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Saving to database...' }));
    expect(logForDeletion).toHaveBeenCalledTimes(1);
    const requestId = vi.mocked(logForDeletion).mock.calls[0]?.[0].requestId;
    if (!requestId) throw new Error('Deletion request missing');
    await act(async () => resolve?.({ requestId, markedCount: 1 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('1 connections persisted in the deletion log. No connections were deleted.')).toBeVisible();
  });

  it('filters unknown credential metadata and resets pagination and clear-all state', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      ...Array.from({ length: 26 }, (_, index) => connection(String(index).padStart(2, '0'))),
      connection('unknown', { credentialType: null }),
      connection('blank', { credentialType: ' ' }),
    ]));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection 00' });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.change(screen.getByLabelText('Credential type'), { target: { value: 'Unknown' } });
    expect(screen.getByText('Page 1 of 1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connection unknown' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connection blank' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filter credential type: Unknown' })).toHaveTextContent('2 (100.0%)');
    expect(screen.queryByRole('button', { name: 'Filter credential type: OAuth2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connection 00' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show visible connections' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Show visible connections' }));
    expect(screen.getByLabelText('Credential type')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Connection 00' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filter credential type: OAuth2' })).toHaveTextContent('26 (92.9%)');
    expect(screen.getByText(/Percentages use the 28 matching connections/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Credential type'), { target: { value: 'OAuth2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByLabelText('Credential type')).toHaveValue('');
  });

  it('shows safe endpoint metadata as text and searches the endpoint and its category', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      connection('sql', { endpoint: 'https://example.database.windows.net:8443', endpointCategory: 'Database source',
        singleSignOnType: 'None', skipTestConnection: false,
        allowUsageInUserControlledCode: true, allowConnectionUsageInGateway: false }),
      connection('missing'),
    ]));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection sql' });
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'DATABASE.WINDOWS' } });
    expect(screen.getByRole('button', { name: 'Connection sql' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connection missing' })).toBeNull();
    expect(within(screen.getByRole('table')).queryByRole('link', { name: /example.database/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'Database source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connection sql' }));
    const details = screen.getByRole('region', { name: 'Connection sql' });
    expect(within(details).getByText('https://example.database.windows.net:8443')).toBeVisible();
    expect(within(details).getByText('Endpoint origin (path omitted)')).toBeVisible();
    expect(within(details).getByText('Database source')).toBeVisible();
    expect(within(details).getByText('Organizational')).toBeVisible();
    for (const [label, value] of [
      ['Single sign-on type', 'None'], ['Skip test connection', 'No'],
      ['Usage in user-controlled code allowed', 'Yes'], ['Connection usage in gateway allowed', 'No'],
    ]) {
      expect(within(details).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connection missing' }));
    const missing = screen.getByRole('region', { name: 'Connection missing' });
    for (const label of ['Endpoint origin (path omitted)', 'Single sign-on type', 'Skip test connection',
      'Usage in user-controlled code allowed', 'Connection usage in gateway allowed']) {
      expect(within(missing).getByText(label).nextElementSibling).toHaveTextContent('Not reported');
    }
  });

  it('wires distribution selection to credential filtering while preserving source, search, and activity scope', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      ...Array.from({ length: 26 }, (_, index) => connection(String(index).padStart(2, '0'))),
      connection('unknown', { credentialType: null }),
      connection('web', { sourceType: 'Web', credentialType: 'Key' }),
    ]));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection 00' });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'SQL' } });
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'Connection' } });
    fireEvent.change(screen.getByLabelText('Activity'), { target: { value: 'unknown' } });
    expect(screen.queryByRole('button', { name: 'Filter credential type: Key' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter credential type: OAuth2' })).toHaveTextContent('26 (96.3%)');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 2')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Filter credential type: Unknown' }));
    expect(screen.getByText('Page 1 of 1')).toBeVisible();
    expect(screen.getByLabelText('Credential type')).toHaveValue('Unknown');
    expect(screen.getByRole('button', { name: 'Connection unknown' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filter credential type: Unknown' })).toHaveTextContent('1 (100.0%)');
    expect(screen.getByText(/Percentages use the 1 matching connections/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Filter credential type: Unknown' }));
    expect(screen.getByLabelText('Credential type')).toHaveValue('');
    expect(screen.getByLabelText('Source')).toHaveValue('SQL');
    expect(screen.getByLabelText('Search connections')).toHaveValue('Connection');
    expect(screen.getByLabelText('Activity')).toHaveValue('unknown');
    expect(screen.getByRole('button', { name: 'Filter credential type: OAuth2' })).toHaveTextContent('26 (96.3%)');
    expect(screen.queryByRole('button', { name: 'Filter credential type: Key' })).toBeNull();
  });

  it('pins the leading signal and connection identity with opaque themed surfaces', async () => {
    render(<App />);
    const finance = await screen.findByRole('button', { name: 'Finance' });
    const row = finance.closest('tr')!;
    const [signal, identity] = within(row).getAllByRole('cell');
    expect(signal).toHaveTextContent('Review stale usage');
    expect(signal).toHaveClass('sticky', 'left-0', 'z-10', 'w-48', 'min-w-48', 'max-w-48', 'bg-card');
    expect(identity).toHaveTextContent('Finance');
    expect(identity).toHaveTextContent('a');
    expect(identity).toHaveClass('md:sticky', 'md:left-48', 'z-10', 'bg-card');
    const header = screen.getByRole('columnheader', { name: /Review signal/ });
    expect(header).toHaveClass('sticky', 'left-0', 'z-20', 'w-48', 'bg-secondary');
    expect(screen.queryByRole('group', { name: 'Inactivity review' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Stale connections' })).toBeNull();
    expect(screen.getByText(/It does not prove inactivity/)).toBeVisible();
  });

  it('shows an honest initial loading state and the inventory', async () => {
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading and validating the latest completed inventory snapshot');
    expect(await screen.findByRole('button', { name: 'Finance' })).toBeVisible();
    expect(screen.getByText('Snapshot visibility.')).toBeVisible();
    expect(screen.getByText(/Snapshot collected/)).toBeVisible();
    expect(screen.getByText(/It does not call the admin APIs/)).toBeVisible();
    expect(within(screen.getByRole('table')).getByText('Review stale usage')).toBeVisible();
    expect(within(screen.getByRole('table')).getByText('Usage unknown')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Deleted' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^delete(?: connections?)?$/i })).toBeNull();
  });

  it('provides API information on every summary and inventory card', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    for (const label of ['Visible connections', 'Gateway footprint', 'Stale usage', 'Usage unknown', 'Connection inventory']) {
      const button = screen.getByRole('button', { name: `API information for ${label}` });
      fireEvent.click(button);
      expect(screen.getByRole('tooltip')).toHaveTextContent('GET https://api.fabric.microsoft.com/v1/admin/connections');
      fireEvent.click(button);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Finance' }));
    expect(screen.getByRole('button', { name: 'API information for Connection details' })).toBeVisible();
  });

  it('combines stale usage with table filters and restores the full list via visible connections', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Web' } });
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'Operations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show stale usage' }));
    expect(screen.getByLabelText('Activity')).toHaveValue('review');
    expect(screen.getByLabelText('Source')).toHaveValue('Web');
    expect(screen.getByLabelText('Search connections')).toHaveValue('Operations');
    expect(screen.getByText('No matching connections')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Operations' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Review stale usage (90+ days)');
    expect(screen.getByRole('heading', { name: 'Connection inventory' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Show visible connections' }));
    expect(screen.getByRole('button', { name: 'Operations' })).toBeVisible();
    expect(screen.getByLabelText('Activity')).toHaveValue('');
    expect(screen.getByLabelText('Source')).toHaveValue('');
    expect(screen.getByLabelText('Search connections')).toHaveValue('');
  });

  it('searches source options without changing the selected filter or inventory', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.change(screen.getByLabelText('Search source options'), { target: { value: 'we' } });
    expect(within(screen.getByLabelText('Source')).queryByRole('option', { name: 'SQL' })).toBeNull();
    expect(within(screen.getByLabelText('Source')).getByRole('option', { name: 'Web' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Finance' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Web' } });
    fireEvent.change(screen.getByLabelText('Search source options'), { target: { value: 'sql' } });
    expect(screen.getByLabelText('Source')).toHaveValue('Web');
    expect(screen.getByRole('button', { name: 'Operations' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByLabelText('Search source options')).toHaveValue('');
  });

  it('cross-filters summary counts and percentages using the full inventory denominator', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    const review = screen.getByRole('button', { name: 'Show stale usage' });
    const unknown = screen.getByRole('button', { name: 'Show usage unknown' });
    expect(review).toHaveTextContent('50.0% of total connections');
    expect(unknown).toHaveTextContent('50.0% of total connections');
    expect(within(screen.getByRole('group', { name: 'Gateway footprint' })).getByText('1')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Web' } });
    expect(review).toHaveTextContent('0.0% of total connections');
    expect(unknown).toHaveTextContent('50.0% of total connections');
    expect(screen.getByRole('button', { name: 'Show visible connections' })).toHaveTextContent('1');
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'missing' } });
    expect(unknown).toHaveTextContent('0.0% of total connections');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(screen.getByLabelText('Connectivity'), { target: { value: 'ShareableCloud' } });
    expect(within(screen.getByRole('group', { name: 'Gateway footprint' })).getByText('0')).toBeVisible();
    expect(unknown).toHaveTextContent('0.0% of total connections');
    expect(review).toHaveTextContent('50.0% of total connections');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(screen.getByLabelText('Activity'), { target: { value: 'unknown' } });
    expect(review).toHaveTextContent('0.0% of total connections');
    expect(unknown).toHaveTextContent('50.0% of total connections');
  });

  it('uses the same status color tokens on cards and table labels', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    for (const name of ['Show stale usage']) {
      expect(screen.getByRole('button', { name }).parentElement).toHaveClass('bg-review', 'text-review-foreground');
    }
    expect(within(screen.getByRole('table')).getByText('Review stale usage')).toHaveClass('bg-review', 'text-review-foreground');
    expect(screen.getByRole('button', { name: 'Show usage unknown' }).parentElement).toHaveClass('bg-muted', 'text-muted-foreground');
    expect(within(screen.getByRole('table')).getByText('Usage unknown')).toHaveClass('bg-muted', 'text-muted-foreground');
  });

  it('keeps stale-card filtering aligned with the threshold and excludes unknown usage', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      connection('recent', { lastBoundDateTime: new Date(Date.now() - 45 * 86_400_000).toISOString() }),
      connection('unknown'),
    ]));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection recent' });
    fireEvent.click(screen.getByRole('button', { name: 'Show stale usage' }));
    expect(screen.getByText('No matching connections')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Stale usage threshold'), { target: { value: '30' } });
    expect(screen.getByRole('button', { name: 'Connection recent' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connection unknown' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('30+ days');
    fireEvent.click(screen.getByRole('button', { name: 'Show usage unknown' }));
    expect(screen.getByRole('button', { name: 'Connection unknown' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connection recent' })).toBeNull();
  });

  it('resets table pagination when choosing the stale usage card', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory(Array.from({ length: 26 }, (_, index) =>
      connection(String(index).padStart(2, '0'), { lastBoundDateTime: '2020-01-01T00:00:00Z' }))));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection 00' });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('button', { name: 'Show stale usage' })).toHaveTextContent('100.0% of total connections');
    fireEvent.click(screen.getByRole('button', { name: 'Show stale usage' }));
    expect(screen.getByText('Page 1 of 2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connection 00' })).toBeVisible();
  });

  it('combines search and filters and distinguishes no matches', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Web' } });
    expect(screen.queryByRole('button', { name: 'Finance' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Operations' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'missing' } });
    expect(screen.getByText('No matching connections')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'Finance' })).toBeVisible();
  });

  it('opens and closes metadata details', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    const details = screen.getByRole('region', { name: 'Operations' });
    expect(within(details).getByText('gateway-1')).toBeVisible();
    expect(within(details).getByText('Encrypted')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close connection details' }));
    expect(screen.queryByRole('region', { name: 'Operations' })).toBeNull();
  });

  it('shows credential usage separately from binding and does not relabel app-caller usage as me', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      connection('a', { lastBoundDateTime: '2026-10-09T10:00:00Z', lastCredentialUsedDateTime: '2020-01-01T12:00:00Z',
        myLastCredentialUsedDateTime: '2021-02-03T12:00:00Z' }),
    ]));
    render(<App />);
    const name = await screen.findByRole('button', { name: 'Connection a' });
    const row = name.closest('tr');
    expect(row).not.toBeNull();
    if (!row) throw new Error('Connection row missing');
    const cells = within(row).getAllByRole('cell');
    expect(cells[7]).toHaveAttribute('title', '2020-01-01T12:00:00Z');
    expect(cells[8]).toHaveTextContent('Unavailable in app mode');
    expect(within(row).getByText('Recent activity')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Last used - anyone (UTC)' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Last used - me (UTC)' })).toBeVisible();
    fireEvent.click(name);
    const details = screen.getByRole('region', { name: 'Connection a' });
    expect(within(details).getByText('Last used - calling identity (UTC)')).toBeVisible();
    expect(within(details).getByText(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
      .format(new Date('2021-02-03T12:00:00Z')))).toBeVisible();
  });

  it('shows current owners with principal IDs when names are not supplied', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      connection('owned', { owners: [
        { id: 'owner-user', type: 'User', displayName: 'Example owner' },
        { id: 'owner-group', type: 'Group', displayName: null },
      ] }),
      connection('forbidden', { ownerStatus: { ok: false, code: 'permission', message: 'Connection owner access required.', retryAfterSeconds: null } }),
    ]));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection owned' });
    expect(within(screen.getByRole('table')).getByText('Example owner')).toBeVisible();
    expect(within(screen.getByRole('table')).getByText('Group: owner-group')).toBeVisible();
    expect(within(screen.getByRole('table')).getByText('Owners unavailable: Connection owner access required.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'API information for Connection owners' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('/v1/admin/connections/{connectionId}/roleAssignments');
    expect(screen.getByRole('tooltip')).toHaveTextContent('not the original creator');
  });

  it('shows all admin access assignments in details and distinguishes lookup failures', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([
      connection('access', { roleAssignments: [
        { id: 'owner-assignment', principal: { id: 'owner-id', type: 'User', displayName: 'Owner example' }, role: 'Owner' },
        { id: 'user-assignment', principal: { id: 'group-id', type: 'Group', displayName: null }, role: 'UserWithReshare' },
        { id: 'tenant-assignment', principal: { id: 'tenant-id', type: 'EntireTenant', displayName: null }, role: 'User' },
      ] }),
      connection('failed', { ownerStatus: { ok: false, code: 'permission', message: 'Admin read access required.', retryAfterSeconds: null } }),
    ]));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connection access' }));
    const access = screen.getByRole('table', { name: 'Connection access assignments' });
    expect(within(access).getByText('Owner example')).toBeVisible();
    expect(within(access).getByText('owner-id')).toBeVisible();
    expect(within(access).getByText('UserWithReshare')).toBeVisible();
    expect(within(access).getByText('EntireTenant')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'API information for Connection access' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('/v1/admin/connections/{connectionId}/roleAssignments');
    fireEvent.click(screen.getByRole('button', { name: 'API information for Connection access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connection failed' }));
    expect(screen.getByText('Access assignments unavailable: Admin read access required.')).toBeVisible();
    expect(screen.queryByText('No access assignments reported.')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Connection access assignments' })).toBeNull();
  });

  it('distinguishes an empty tenant inventory', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory([]));
    render(<App />);
    expect(await screen.findByText('No tenant connections returned')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show stale usage' })).toHaveTextContent('0.0% of total connections');
  });

  it('preserves the previous inventory with an explicit warning after a failed refresh', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Finance' });
    vi.mocked(loadConnections).mockRejectedValueOnce(new ConnectionLoadError('Permission required.'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('may be out of date');
    expect(screen.getByRole('button', { name: 'Finance' })).toBeVisible();
    vi.mocked(loadConnections).mockResolvedValue(inventory([]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No tenant connections returned');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows published collection failures separately from dashboard read errors', async () => {
    vi.mocked(loadConnections).mockResolvedValueOnce({
      ...inventory([connection('failed', { ownerStatus: { ok: false, code: 'permission', message: 'Collector permission required.', retryAfterSeconds: null } })]),
      ownerLookupFailureCount: 1,
    });
    render(<App />);
    expect(await screen.findByText(/Inventory collection completed, but access assignments/)).toHaveTextContent('1 connections');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sanitizes unexpected invocation errors and permits retry', async () => {
    vi.mocked(loadConnections).mockRejectedValueOnce(new Error('private provider body'));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('inventory snapshot connector could not read');
    expect(screen.queryByText('private provider body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Finance' });
  });

  it('paginates and resets the page when filtering', async () => {
    vi.mocked(loadConnections).mockResolvedValue(inventory(Array.from({ length: 26 }, (_, index) =>
      connection(String(index).padStart(2, '0')))));
    render(<App />);
    await screen.findByRole('button', { name: 'Connection 00' });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('button', { name: 'Connection 25' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connection 00' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: 'Connection 00' } });
    expect(screen.getByRole('button', { name: 'Connection 00' })).toBeVisible();
    expect(screen.getByText('Page 1 of 1')).toBeVisible();
  });

  it('does not update after unmount during a pending request', async () => {
    let resolve: ((value: ConnectionInventory) => void) | undefined;
    vi.mocked(loadConnections).mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<App />);
    view.unmount();
    await act(async () => resolve?.(inventory([])));
    expect(screen.queryByText('No tenant connections returned')).toBeNull();
  });
});
