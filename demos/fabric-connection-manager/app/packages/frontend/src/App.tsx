//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownUp, ChevronLeft, ChevronRight, Database, Link2, RefreshCw, Search, X } from 'lucide-react';
import type { ConnectionSummary, DeletionActionState } from '@rayfin-app/shared';
import { activityStatus, connectivityLabel, credentialLabel, formatDate, formatReportedBoolean, lastActivity, type ActivityStatus } from './lib/connection-inventory';
import { ConnectionLoadError, loadConnections, type ConnectionInventory } from './services/connections.service';
import { DeletionLogError, logForDeletion } from '@/services/deletion-requests.service';
import { cancelDeletionRequests, DeletionActionsLoadError, DeletionCancellationError, loadDeletionActions } from '@/services/deletion-actions.service';
import { ApiInfo } from './components/api-info';
import { ConnectionIdentity } from './components/connection-identity';
import { CredentialDistribution } from './components/credential-distribution';
import { DeletedConnections } from './components/deleted-connections';
import { ThemeSelector } from './components/theme-selector';

const control = 'rounded-lg border border-input bg-card px-300 py-200 text-300 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
const statusLabels = { recent: 'Recent activity', review: 'Review stale usage', unknown: 'Usage unknown' };
const pageSize = 25;
const deletionLabels = {
  pending: 'Pending deletion', processing: 'Deletion processing', reconcile: 'Reconciliation required',
  deleted: 'Confirmed deleted', cancelled: 'Deletion cancelled',
};
const deletionNotes = {
  pending: 'Pending requests can be selected for cancellation.',
  processing: 'Selection unavailable: deletion is already processing.',
  reconcile: 'Selection unavailable: the deletion outcome requires reconciliation.',
  deleted: 'Selection unavailable: deletion is confirmed; this inventory snapshot may be older.',
  cancelled: 'The request was cancelled. This connection can be logged again.',
};

function App() {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<ConnectionInventory | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pageView, setPageView] = useState<'inventory' | 'deleted'>('inventory');
  const [deletionActions, setDeletionActions] = useState<DeletionActionState[] | null>(null);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const actionsLoadVersion = useRef(0);
  const [search, setSearch] = useState('');
  const [connectivity, setConnectivity] = useState('');
  const [source, setSource] = useState('');
  const [credential, setCredential] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');
  const [status, setStatus] = useState<ActivityStatus | ''>('');
  const [days, setDays] = useState(90);
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<'mark' | 'cancel' | null>(null);
  const [logging, setLogging] = useState(false);
  const [loggingError, setLoggingError] = useState<string | null>(null);
  const [loggedCount, setLoggedCount] = useState<number | null>(null);
  const [cancelledCount, setCancelledCount] = useState<number | null>(null);
  const pendingDeletionRequest = useRef<Parameters<typeof logForDeletion>[0] | null>(null);
  const pendingCancellation = useRef<Parameters<typeof cancelDeletionRequests>[0] | null>(null);
  const loggingInFlight = useRef(false);
  const deletionDialog = useRef<HTMLDialogElement>(null);
  const deletionLogButton = useRef<HTMLButtonElement>(null);
  const deletionCancelButton = useRef<HTMLButtonElement>(null);
  const cancelLogging = useRef<HTMLButtonElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const inventoryHeading = useRef<HTMLHeadingElement>(null);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    pendingDeletionRequest.current = null;
    pendingCancellation.current = null;
    setConfirmation(null);
    setLoggingError(null);
    setLoggedCount(null);
    setCancelledCount(null);
  }, []);

  const reloadDeletionActions = useCallback((isActive: () => boolean = () => true) => {
    const version = ++actionsLoadVersion.current;
    return loadDeletionActions().then((actions) => {
      if (!isActive() || actionsLoadVersion.current !== version) return;
      setDeletionActions(actions);
      setActionsError(null);
    }).catch((failure: unknown) => {
      if (!isActive() || actionsLoadVersion.current !== version) return;
      console.error('Deletion status refresh failed');
      const detail = failure instanceof DeletionActionsLoadError ? failure.diagnostic : null;
      setActionsError(`Deletion status could not be refreshed. Logging and cancellation are disabled until status refresh succeeds.${detail ? ` ${detail}` : ''}`);
    }).finally(() => {
      if (isActive() && actionsLoadVersion.current === version) setActionsLoading(false);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void reloadDeletionActions(() => active);
    return () => { active = false; };
  }, [refreshKey, reloadDeletionActions]);

  useEffect(() => {
    let active = true;
    loadConnections().then((result) => {
      if (!active) return;
      const now = Date.now();
      clearSelection();
      setConnections(result.connections);
      setSnapshot(result);
      setLoadedAt(now);
      setClock(now);
      setRetryAt(0);
      setLoading(false);
    }).catch((failure: unknown) => {
      if (!active) return;
      console.error('Connection inventory load failed', 'snapshot-connector');
      setError(failure instanceof ConnectionLoadError
        ? failure.message
        : 'The inventory snapshot connector could not read the Lakehouse. Check sign-in, connector deployment, and source permissions, then retry.');
      const now = Date.now();
      setClock(now);
      setRetryAt(failure instanceof ConnectionLoadError && failure.retryAfterSeconds
        ? now + failure.retryAfterSeconds * 1000 : 0);
      setLoading(false);
    });
    return () => { active = false; };
  }, [refreshKey, clearSelection]);

  useEffect(() => {
    if (retryAt <= clock) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt, clock]);

  useEffect(() => {
    if (selectedId) detailHeading.current?.focus();
  }, [selectedId]);

  useEffect(() => {
    if (!confirmation) return;
    deletionDialog.current?.showModal();
    cancelLogging.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    if (pageView === 'inventory') inventoryHeading.current?.focus();
  }, [pageView]);

  const inventory = connections ?? [];
  const now = loadedAt ?? clock;
  const query = search.trim().toLowerCase();
  const filtered = inventory.filter((connection) =>
    (!query || [connection.displayName, connection.id, connection.sourceType, connection.gatewayId ?? '', connection.endpoint ?? '', connection.endpointCategory ?? ''].some((value) => value.toLowerCase().includes(query))) &&
    (!connectivity || connection.connectivityType === connectivity) &&
    (!source || connection.sourceType === source) &&
    (!credential || credentialLabel(connection.credentialType) === credential) &&
    (!status || activityStatus(connection, days, now) === status)
  ).sort((a, b) => sort === 'activity'
    ? (lastActivity(b) ?? -Infinity) - (lastActivity(a) ?? -Infinity) || a.displayName.localeCompare(b.displayName)
    : a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  const reviewCount = filtered.filter((connection) => activityStatus(connection, days, now) === 'review').length;
  const unknownCount = filtered.filter((connection) => activityStatus(connection, days, now) === 'unknown').length;
  const gateways = new Set(filtered.map((connection) => connection.gatewayId).filter(Boolean));
  const sourceOptions = [...new Set(inventory.map((connection) => connection.sourceType))].sort()
    .filter((value) => value === source || value.toLowerCase().includes(sourceSearch.trim().toLowerCase()));
  function percentage(count: number) {
    return `${inventory.length ? (count / inventory.length * 100).toFixed(1) : '0.0'}% of total connections`;
  }
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = inventory.find((connection) => connection.id === selectedId);
  const remaining = Math.max(0, Math.ceil((retryAt - clock) / 1000));
  const actionById = new Map((deletionActions ?? []).map((action) => [action.connectionId, action]));
  function selectable(id: string) {
    const action = actionById.get(id);
    return !action || action.status === 'pending' || action.status === 'cancelled';
  }
  const selectableFiltered = filtered.filter((connection) => selectable(connection.id));
  const deletionStatusUnavailable = actionsLoading || actionsError !== null || deletionActions === null;
  const selectionDisabled = loading || error !== null || snapshot === null || logging
    || deletionStatusUnavailable;
  const canMark = selectedIds.length > 0 && selectedIds.every((id) =>
    !actionById.has(id) || actionById.get(id)?.status === 'cancelled');
  const canCancel = selectedIds.length > 0 && selectedIds.every((id) => {
    const action = actionById.get(id);
    return action?.status === 'pending' && action.pendingRequestIds.length > 0;
  });
  const allFilteredSelected = selectableFiltered.length > 0 && selectedIds.length === selectableFiltered.length;
  const partlySelected = selectedIds.length > 0 && !allFilteredSelected;

  function changeSelection(ids: string[]) {
    setSelectedIds(ids.sort());
    pendingDeletionRequest.current = null;
    pendingCancellation.current = null;
    setLoggingError(null);
    setLoggedCount(null);
    setCancelledCount(null);
  }

  function closeLoggingDialog() {
    if (loggingInFlight.current) return;
    deletionDialog.current?.close();
    setConfirmation(null);
    (confirmation === 'cancel' ? deletionCancelButton : deletionLogButton).current?.focus();
  }

  async function submitDeletionLog() {
    if (selectionDisabled || !canMark || !snapshot || loggingInFlight.current) return;
    loggingInFlight.current = true;
    setLogging(true);
    setLoggingError(null);
    try {
      const request = pendingDeletionRequest.current ?? {
        requestId: crypto.randomUUID(),
        snapshotRunId: snapshot.runId,
        connectionIds: [...selectedIds],
      };
      pendingDeletionRequest.current = request;
      const result = await logForDeletion(request);
      if (pendingDeletionRequest.current === request) {
        deletionDialog.current?.close();
        clearSelection();
        setLoggedCount(result.markedCount);
        inventoryHeading.current?.focus();
        setActionsLoading(true);
        await reloadDeletionActions();
      }
    } catch (failure: unknown) {
      console.error('Deletion request logging failed');
      const detail = failure instanceof DeletionLogError ? failure.diagnostic : null;
      const progress = failure instanceof DeletionLogError && failure.acknowledgedCount > 0
        ? `${failure.acknowledgedCount} connection(s) confirmed saved; the last batch may also have been saved. Displayed deletion status may be out of date. `
        : '';
      setLoggingError(`Logging could not be confirmed. ${progress}${detail ?? 'Retry the same selection to reuse the request ID and avoid duplicate logging.'} Your selection is unchanged.`);
    } finally {
      loggingInFlight.current = false;
      setLogging(false);
    }
  }

  function openCancellation() {
    if (selectionDisabled || !canCancel) return;
    pendingCancellation.current ??= {
      requestIds: [...new Set(selectedIds.flatMap((id) => actionById.get(id)?.pendingRequestIds ?? []))].sort(),
    };
    setConfirmation('cancel');
  }

  async function submitCancellation() {
    const request = pendingCancellation.current;
    if (selectionDisabled || !canCancel || !request || loggingInFlight.current) return;
    loggingInFlight.current = true;
    setLogging(true);
    setLoggingError(null);
    try {
      const result = await cancelDeletionRequests(request);
      if (pendingCancellation.current === request) {
        deletionDialog.current?.close();
        clearSelection();
        setCancelledCount(result.cancelledCount);
        inventoryHeading.current?.focus();
        setActionsLoading(true);
        await reloadDeletionActions();
      }
    } catch (failure: unknown) {
      console.error('Deletion request cancellation failed');
      setLoggingError(failure instanceof DeletionCancellationError
        ? `${failure.message} Your selection is unchanged; retry uses the same captured request IDs.`
        : 'Cancellation could not be confirmed. Your selection is unchanged; retry uses the same captured request IDs.');
    } finally {
      loggingInFlight.current = false;
      setLogging(false);
    }
  }

  function refresh() {
    if (loggingInFlight.current) return;
    clearSelection();
    setLoading(true);
    setActionsLoading(true);
    setActionsError(null);
    setError(null);
    setRefreshKey((key) => key + 1);
  }

  function clearFilters() {
    clearSelection();
    setSearch('');
    setConnectivity('');
    setSource('');
    setCredential('');
    setSourceSearch('');
    setStatus('');
    setPage(0);
  }

  function filterByCard(activity: ActivityStatus | '') {
    clearSelection();
    if (activity === '') clearFilters();
    setStatus(activity);
    setPage(0);
    setSelectedId(null);
    inventoryHeading.current?.focus();
  }

  return (
    <div className="min-h-full bg-background font-base">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-400 px-600 py-400">
          <div className="flex items-center gap-300">
            <span className="rounded-xl bg-primary p-200 text-primary-foreground"><Link2 aria-hidden="true" size={24} /></span>
            <div><p className="font-heading text-400 font-semibold">Fabric Connection Manager</p><p className="text-200 text-muted-foreground">Tenant-wide admin connections / Read-only inventory</p></div>
          </div>
          <ThemeSelector />
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-600 px-400 py-600 sm:px-600 lg:py-800">
        <div className="flex flex-wrap items-end justify-between gap-400">
          <div>
            <p className="mb-200 text-200 font-semibold uppercase tracking-widest text-primary">Connections overview</p>
            <h1 className="font-heading text-hero-800 font-semibold tracking-tight">Know what connects your data.</h1>
            <p className="mt-200 text-300 text-muted-foreground">Explore connectivity, authentication metadata, and reported usage in one place.</p>
          </div>
          <button className={`${control} flex items-center gap-200 bg-primary text-primary-foreground`} onClick={refresh} disabled={loading || actionsLoading || logging || remaining > 0}>
            <RefreshCw size={16} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading connections' : remaining > 0 ? `Retry in ${remaining}s` : 'Refresh connections'}
          </button>
        </div>

        <ConnectionIdentity />
        <p className="text-200 text-muted-foreground">Refresh reads the latest completed Lakehouse snapshot. It does not call the admin APIs or start collection.</p>
        {snapshot && snapshot.ownerLookupFailureCount > 0 && <p className="rounded-lg border border-border bg-muted p-300 text-300">
          Inventory collection completed, but access assignments could not be collected for {snapshot.ownerLookupFailureCount.toLocaleString()} connections. Those rows show an explicit lookup failure.
        </p>}

        {error && <div role="alert" className="rounded-xl border border-destructive bg-card p-400 text-300">
          <p className="font-semibold text-destructive">Unable to {connections ? 'refresh' : 'load'} connections</p>
          <p className="mt-200">{error}</p>
          {connections && <p className="mt-200 font-semibold">The previous inventory remains visible and may be out of date.</p>}
          <button className={`${control} mt-300`} onClick={refresh} disabled={loading || actionsLoading || logging || remaining > 0}>{remaining > 0 ? `Retry in ${remaining}s` : 'Try again'}</button>
        </div>}

        {actionsLoading && <p className="text-300 text-muted-foreground" aria-live="polite">Loading deletion status. Logging and cancellation are unavailable while status is being verified.</p>}
        {actionsError && <div role="alert" className="rounded-xl border border-destructive bg-card p-400 text-300">
          <p className="font-semibold text-destructive">{actionsError}</p>
          <p className="mt-200">{deletionActions === null
            ? 'Pending state and confirmed deletion history are unavailable, not empty.'
            : 'Previous deletion status and history remain visible and may be stale.'}</p>
          <button type="button" className={`${control} mt-300`} disabled={actionsLoading || logging}
            onClick={() => { clearSelection(); setActionsLoading(true); setActionsError(null); void reloadDeletionActions(); }}>Refresh deletion status</button>
        </div>}
        <nav aria-label="Connection pages" className="flex gap-300">
          <button type="button" className={`${control} ${pageView === 'inventory' ? 'border-primary text-primary' : ''}`}
            aria-current={pageView === 'inventory' ? 'page' : undefined} disabled={logging}
            onClick={() => { clearSelection(); setSelectedId(null); setPageView('inventory'); }}>Inventory</button>
          <button type="button" className={`${control} ${pageView === 'deleted' ? 'border-primary text-primary' : ''}`}
            aria-current={pageView === 'deleted' ? 'page' : undefined} disabled={logging}
            onClick={() => { clearSelection(); setSelectedId(null); setPageView('deleted'); }}>Deleted</button>
        </nav>
        <div hidden={pageView !== 'inventory'} className="space-y-600">
        <section aria-label="Inventory summary" className="grid gap-400 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Visible connections', value: filtered.length, icon: Link2, note: connections ? `${inventory.length} total tenant connections` : 'Inventory not loaded', description: 'Count of unique connection IDs matching the current table filters in the verified published snapshot.', filter: '' as const },
            { label: 'Gateway footprint', value: gateways.size, icon: Database, note: 'Distinct reported gateway IDs', description: 'Count of distinct non-empty gatewayId values matching the table filters. No separate gateway API is called.' },
            { label: 'Stale usage', value: reviewCount, icon: Activity, note: `Latest reported usage is ${days}+ days old`, description: 'Matching connections with an old lastBoundDateTime or lastCredentialUsedDateTime in connectionRecency. Uses the latest valid date and excludes newly created connections. This does not prove inactivity or that deletion is safe. Percentage uses the complete inventory.', filter: 'review' as const },
            { label: 'Usage unknown', value: unknownCount, icon: ArrowDownUp, note: 'No binding or credential usage date', description: 'Connections without a valid reported lastBoundDateTime or lastCredentialUsedDateTime in connectionRecency.', filter: 'unknown' as const },
          ].map(({ label, value, icon: Icon, note, description, filter }) => <div key={label} role="group" aria-label={label} className={`rounded-xl border p-500 ${filter === 'review' ? 'bg-review text-review-foreground' : filter === 'unknown' ? 'bg-muted text-muted-foreground' : 'bg-card'} ${filter && status === filter ? 'border-primary ring-1 ring-primary' : 'border-border'}`}>
            <div className={`flex items-center justify-between gap-200 text-300 ${filter ? '' : 'text-muted-foreground'}`}><h2>{label}</h2><div className="flex items-center gap-100"><Icon size={18} aria-hidden="true" /><ApiInfo label={label} description={description} /></div></div>
            {filter !== undefined ? <button type="button" onClick={() => filterByCard(filter)}
              aria-label={`Show ${label.toLowerCase()}`} aria-controls="connection-inventory"
              aria-pressed={status === filter && (filter !== '' || (!search && !connectivity && !source && !credential))}
              disabled={!connections || loading}
              className="mt-300 w-full rounded-lg text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
              <span className="block font-numeric text-hero-900 font-semibold">{connections ? value.toLocaleString() : '--'}</span>
              {filter && <span className="mt-100 block text-200 font-semibold">{connections ? percentage(value) : '--% of total connections'}</span>}
              <span className={`mt-300 block text-200 ${filter ? '' : 'text-muted-foreground'}`}>{note}</span>
              <span className={`mt-200 block text-200 font-semibold ${filter ? '' : 'text-primary'}`}>View connections</span>
            </button> : <>
              <p className="my-300 font-numeric text-hero-900 font-semibold">{connections ? value.toLocaleString() : '--'}</p>
              <p className="text-200 text-muted-foreground">{note}</p>
            </>}
          </div>)}
        </section>
        <p className="text-200 text-muted-foreground">Cards reflect all active table filters, before pagination. Percentages use the complete tenant inventory{connections ? ` (${inventory.length} connections)` : ''} as the denominator.</p>
        <p className="text-200 text-muted-foreground">Stale usage means the latest reported binding or credential-use date is at least {days} days old; newly created connections are excluded. It does not prove inactivity or that deletion is safe. Usage unknown means neither usage date is valid or reported, not stale usage.</p>

        <CredentialDistribution connections={filtered} loaded={connections !== null} selectedCredential={credential}
          onSelect={(value) => { clearSelection(); setCredential(value); setPage(0); }} />

        <section id="connection-inventory" className="rounded-xl border border-border bg-card" aria-labelledby="inventory-title" aria-busy={loading}>
          <div className="flex flex-wrap items-center justify-between gap-300 border-b border-border p-500">
            <div><div className="flex items-center gap-200"><h2 id="inventory-title" ref={inventoryHeading} tabIndex={-1} className="font-heading text-500 font-semibold focus-visible:outline-2 focus-visible:outline-ring">Connection inventory</h2><ApiInfo label="Connection inventory" description="Tenant-wide connections collected by CollectConnectionInventory from all admin API pages. Dashboard reads are pinned to one completed snapshot and verified against its manifest counts. Search, filters, and sorting are applied locally." /></div>
              <p className="mt-100 text-200 text-muted-foreground">{snapshot ? `Snapshot collected ${new Date(snapshot.collectedAt).toLocaleString()}` : 'Stored inventory from lh_connection_inventory'}</p>
              {loadedAt && <p className="mt-100 text-200 text-muted-foreground">Dashboard refreshed {new Date(loadedAt).toLocaleString()}. Collection is run separately.</p>}
              {status && <p role="status" className="mt-200 text-200 font-semibold text-primary">Showing: {statusLabels[status]}{status === 'review' ? ` (${days}+ days)` : ''}</p>}
            </div>
            <label className="flex items-center gap-200 text-200 text-muted-foreground">Review after
              <select aria-label="Stale usage threshold" className={control} value={days} onChange={(event) => { clearSelection(); setDays(Number(event.target.value)); setPage(0); }}>
                {[30, 90, 180, 365].map((value) => <option key={value} value={value}>{value} days</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-300 border-b border-border p-400">
            <label className="min-w-48 flex-1 text-200 text-muted-foreground">Search connections
              <div className="relative mt-100"><Search className="absolute left-300 top-200 text-muted-foreground" size={18} aria-hidden="true" />
                <input className={`${control} w-full pl-800`} value={search} placeholder="Name, connection ID, source, gateway, endpoint or category" onChange={(event) => { clearSelection(); setSearch(event.target.value); setPage(0); }} />
              </div>
            </label>
            <label className="text-200 text-muted-foreground">Credential type
              <select className={`${control} mt-100 block`} value={credential} onChange={(event) => { clearSelection(); setCredential(event.target.value); setPage(0); }}>
                <option value="">All credential types</option>
                {[...new Set(['Unknown', ...inventory.map((connection) => credentialLabel(connection.credentialType))])].sort().map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
            <label className="text-200 text-muted-foreground">Connectivity
              <select className={`${control} mt-100 block`} value={connectivity} onChange={(event) => { clearSelection(); setConnectivity(event.target.value); setPage(0); }}>
                <option value="">All connectivity</option>
                {[...new Set(inventory.map((connection) => connection.connectivityType))].sort().map((value) => <option key={value} value={value}>{connectivityLabel(value)}</option>)}
              </select>
            </label>
            <div className="text-200 text-muted-foreground">
              <label className="block">Search source options
                <input type="search" className={`${control} mt-100 block`} placeholder="Find a source type" value={sourceSearch}
                  onChange={(event) => setSourceSearch(event.target.value)} />
              </label>
              <label className="mt-200 block">Source
              <select className={`${control} mt-100 block`} value={source} onChange={(event) => { clearSelection(); setSource(event.target.value); setPage(0); }}>
                <option value="">All sources</option>
                {sourceOptions.map((value) => <option key={value}>{value}</option>)}
              </select>
              </label>
              {connections && sourceSearch.trim() && sourceOptions.length === 0 && <p className="mt-100">No source types match.</p>}
            </div>
            <label className="text-200 text-muted-foreground">Activity
              <select className={`${control} mt-100 block`} value={status} onChange={(event) => {
                const value = event.target.value;
                if (value === '' || value === 'recent' || value === 'review' || value === 'unknown') {
                  clearSelection();
                  setStatus(value);
                  setPage(0);
                }
              }}>
                <option value="">All activity</option>
                {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="text-200 text-muted-foreground">Sort
              <select className={`${control} mt-100 block`} value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }}>
                <option value="name">Name A-Z</option><option value="activity">Latest activity</option>
              </select>
            </label>
            <button className={control} onClick={clearFilters}>Clear filters</button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-300 border-b border-border p-400" role="group" aria-label="Deletion logging selection">
            <div>
              <p id="deletion-selection-count" className="text-300" aria-live="polite">{selectedIds.length.toLocaleString()} selected of {filtered.length.toLocaleString()} filtered connections (all pages).</p>
              {deletionStatusUnavailable && <p id="deletion-selection-unavailable" className="mt-200 text-200 text-destructive">Deletion checkboxes are disabled until deletion status is successfully refreshed.</p>}
              <p className="mt-100 text-200 text-muted-foreground">Select all includes all {selectableFiltered.length.toLocaleString()} currently selectable filtered connections across every page. Processing, reconciliation, and confirmed-deleted rows cannot be selected.</p>
              <p className="mt-100 text-200 text-muted-foreground">Logging records a request for later review. It does not delete connections or change the read-only inventory.</p>
              {selectedIds.length > 0 && !canMark && !canCancel && <p className="mt-200 text-200 text-muted-foreground">Select only pending connections to cancel requests, or only unmarked or cancelled connections to log for deletion. Mixed selections cannot perform either operation.</p>}
              {canCancel && <p className="mt-100 text-200 text-muted-foreground">Only pending connections are selected. Cancel their pending requests below; they cannot be logged again while pending.</p>}
              {error && <p className="mt-100 text-200 text-muted-foreground">Selection and logging are unavailable until the inventory refresh succeeds.</p>}
              {loggedCount !== null && <p role="status" className="mt-200 text-300 font-semibold text-success-foreground">{loggedCount.toLocaleString()} connections persisted in the deletion log. No connections were deleted.</p>}
              {cancelledCount !== null && <p role="status" className="mt-200 text-300 font-semibold text-success-foreground">{cancelledCount.toLocaleString()} deletion requests cancelled. No connections were deleted.</p>}
              {loggingError && !confirmation && <p role="alert" className="mt-200 text-300 text-destructive">{loggingError}</p>}
            </div>
            <div className="flex flex-wrap gap-300">
              <button ref={deletionLogButton} type="button" className={`${control} bg-destructive text-destructive-foreground`}
                disabled={selectionDisabled || !canMark} onClick={() => setConfirmation('mark')}>log for deletion</button>
              <button ref={deletionCancelButton} type="button" className={control}
                disabled={selectionDisabled || !canCancel} onClick={openCancellation}>cancel deletion request</button>
            </div>
          </div>
          {loading && <p role="status" className="border-b border-border p-400 text-300 text-muted-foreground">Reading and validating the latest completed inventory snapshot...</p>}
          {!loading && connections && inventory.length === 0 && <div className="p-800 text-center"><h3 className="font-semibold">No tenant connections returned</h3><p className="mt-200 text-300 text-muted-foreground">The completed snapshot contains no connections. Run collection again after a connection is created.</p></div>}
          {connections && inventory.length > 0 && filtered.length === 0 && <div className="p-800 text-center"><h3 className="font-semibold">No matching connections</h3><p className="mt-200 text-300 text-muted-foreground">Try a different search or clear the filters.</p></div>}
          {visible.length > 0 && <div className="overflow-x-auto">
            <table className="w-full text-left text-300">
              <thead className="bg-secondary text-200 text-muted-foreground"><tr>
                <th scope="col" className="sticky left-0 z-20 w-48 min-w-48 max-w-48 bg-secondary px-400 py-300 font-medium">
                  <input type="checkbox" aria-label="Select all filtered connections"
                    aria-describedby={`deletion-selection-count${deletionStatusUnavailable ? ' deletion-selection-unavailable' : ''}`}
                    checked={allFilteredSelected} aria-checked={partlySelected ? 'mixed' : allFilteredSelected}
                    ref={(element) => { if (element) element.indeterminate = partlySelected; }}
                    disabled={selectionDisabled || selectableFiltered.length === 0}
                    onChange={() => changeSelection(allFilteredSelected ? [] : selectableFiltered.map((connection) => connection.id))}
                    className="mr-200 accent-primary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50" />
                  Review signal
                </th>
                {['Connection', 'Owner(s)', 'Source', 'Endpoint origin', 'Connectivity', 'Authentication', 'Last used - anyone (UTC)', 'Last used - me (UTC)'].map((label) => <th key={label} className={label === 'Connection' ? 'md:sticky md:left-48 z-20 w-64 min-w-64 max-w-64 bg-secondary px-400 py-300 font-medium' : 'whitespace-nowrap px-400 py-300 font-medium'} scope="col">{label}
                {label === 'Owner(s)' && <ApiInfo label="Connection owners" endpoint="/v1/admin/connections/{connectionId}/roleAssignments"
                  description="Current principals with the Owner role, not the original creator. Names are shown only when returned by Fabric; otherwise principal type and ID are displayed." />}
              </th>)}</tr></thead>
              <tbody>{visible.map((connection) => {
                const signal = activityStatus(connection, days, now);
                const action = actionById.get(connection.id);
                const rowSurface = selectedId === connection.id ? 'bg-accent' : action?.status === 'pending' ? 'bg-secondary' : 'bg-card';
                return <tr key={connection.id} className={`border-t border-border hover:bg-accent ${action?.status === 'pending' ? 'bg-secondary' : ''} ${selectedId === connection.id ? 'bg-accent' : ''}`}>
                  <td className={`sticky left-0 z-10 w-48 min-w-48 max-w-48 px-400 py-400 ${rowSurface}`}>
                    <input type="checkbox" aria-label={`Select ${connection.displayName} (${connection.id})`} checked={selectedIds.includes(connection.id)}
                      aria-describedby={[
                        action ? `deletion-state-${connection.id}` : null,
                        deletionStatusUnavailable ? 'deletion-selection-unavailable' : null,
                      ].filter(Boolean).join(' ') || undefined}
                      disabled={selectionDisabled || !selectable(connection.id)} onChange={(event) => changeSelection(event.target.checked
                        ? [...selectedIds, connection.id] : selectedIds.filter((id) => id !== connection.id))}
                      className="mr-200 accent-primary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50" />
                    <span className={`inline-block rounded-full px-300 py-100 text-200 ${signal === 'review' ? 'bg-review text-review-foreground' : signal === 'recent' ? 'bg-success text-success-foreground' : 'bg-muted text-muted-foreground'}`}>{statusLabels[signal]}</span>
                    {action && <span className={`mt-200 inline-block rounded-full px-300 py-100 text-200 ${action.status === 'pending' ? 'bg-pending-deletion text-pending-deletion-foreground' : 'bg-muted text-muted-foreground'}`}>{deletionLabels[action.status]}</span>}
                    <p className="mt-200 break-words text-200 md:hidden" aria-hidden="true">{connection.displayName}</p></td>
                  <td className={`md:sticky md:left-48 z-10 w-64 min-w-64 max-w-64 px-400 py-400 ${rowSurface}`}><button onClick={() => setSelectedId(connection.id)} className="break-words text-left font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{connection.displayName}</button><p className="mt-100 break-all font-monospace text-200 text-muted-foreground">{connection.id}</p>
                    {action && <div id={`deletion-state-${connection.id}`} className="mt-200 text-200 text-muted-foreground">
                      <p>{deletionNotes[action.status]}</p>
                      <p>Requested <time dateTime={action.requestedAt}>{new Date(action.requestedAt).toLocaleString()}</time></p>
                    </div>}
                  </td>
                  <td className="min-w-48 max-w-80 break-words px-400 py-400">
                    {connection.ownerStatus.ok
                      ? connection.owners.length
                        ? <ul className="space-y-100">{connection.owners.map((owner) => <li key={`${owner.type}:${owner.id}`} title={`${owner.type}: ${owner.id}`}>{owner.displayName ?? `${owner.type}: ${owner.id}`}</li>)}</ul>
                        : <span className="text-200 text-muted-foreground">No owners reported</span>
                      : <span className="text-200 text-destructive" title={connection.ownerStatus.message}>Owners unavailable: {connection.ownerStatus.message}</span>}
                  </td>
                  <td className="px-400 py-400">{connection.sourceType}</td>
                  <td className="min-w-48 max-w-80 break-all px-400 py-400"><p>{connection.endpoint ?? 'Not reported'}</p>{connection.endpointCategory && <p className="mt-100 text-200 text-muted-foreground">{connection.endpointCategory}</p>}</td>
                  <td className="whitespace-nowrap px-400 py-400">{connectivityLabel(connection.connectivityType)}</td>
                  <td className="px-400 py-400">{credentialLabel(connection.credentialType)}</td>
                  <td className="whitespace-nowrap px-400 py-400" title={connection.lastCredentialUsedDateTime ?? undefined}>{formatDate(connection.lastCredentialUsedDateTime)}</td>
                  <td className="px-400 py-400 text-200 text-muted-foreground">Unavailable in app mode</td>
                </tr>;
              })}</tbody>
            </table>
          </div>}
          {connections && <div className="flex flex-wrap items-center justify-between gap-300 border-t border-border px-400 py-300 text-200 text-muted-foreground">
            <p>{filtered.length ? `${currentPage * pageSize + 1}-${Math.min((currentPage + 1) * pageSize, filtered.length)} of ${filtered.length.toLocaleString()}` : '0'} connections{filtered.length !== inventory.length ? ` (${inventory.length.toLocaleString()} total)` : ''}</p>
            <div className="flex items-center gap-200"><button className={control} aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><span>Page {currentPage + 1} of {lastPage + 1}</span><button className={control} aria-label="Next page" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div>
          </div>}
        </section>

        {confirmation && <dialog ref={deletionDialog} aria-labelledby="deletion-dialog-title" aria-describedby="deletion-dialog-description"
          aria-modal="true" aria-busy={logging} className="m-auto max-w-lg rounded-xl border border-border bg-card p-600 text-foreground backdrop:bg-background/80"
          onCancel={(event) => { event.preventDefault(); closeLoggingDialog(); }}>
          <h2 id="deletion-dialog-title" className="font-heading text-500 font-semibold">{confirmation === 'mark' ? 'Confirm deletion logging' : 'Confirm request cancellation'}</h2>
          <p id="deletion-dialog-description" className="mt-300 text-300">
            {confirmation === 'mark' ? <>Log {selectedIds.length.toLocaleString()} selected connections from the current {filtered.length.toLocaleString()} filtered connections across all pages.
              This persists a deletion-review request only. No connections are deleted now, and no admin deletion API is called.</>
              : <>Cancel the captured pending requests for {selectedIds.length.toLocaleString()} selected connections from the current {filtered.length.toLocaleString()} filtered connections across all pages.
                Only the captured request IDs are submitted. Already processing or completed requests cannot be cancelled. This action does not delete any connections.</>}
          </p>
          {logging && <p role="status" className="mt-300 text-300">
            Saving to database... Please wait for confirmation. No connections are being deleted.
          </p>}
          {loggingError && <p role="alert" className="mt-300 text-300 text-destructive">{loggingError}</p>}
          <div className="mt-500 flex flex-wrap justify-end gap-300">
            <button ref={cancelLogging} type="button" className={control} disabled={logging} onClick={closeLoggingDialog}>Cancel</button>
            <button type="button" className={`${control} ${confirmation === 'mark' ? 'bg-destructive text-destructive-foreground' : ''}`}
              disabled={selectionDisabled || (confirmation === 'mark' ? !canMark : !canCancel)}
              onClick={confirmation === 'mark' ? submitDeletionLog : submitCancellation}>
              {confirmation === 'mark'
                ? logging ? 'Saving to database...' : loggingError ? 'Retry logging' : 'Confirm logging'
                : logging ? 'Cancelling requests...' : loggingError ? 'Retry cancellation' : 'Confirm cancellation'}
            </button>
          </div>
        </dialog>}

        {selected && <section aria-labelledby="connection-details-title" className="rounded-xl border border-primary bg-card p-500">
          <div className="flex items-start justify-between gap-400">
            <div><div className="flex items-center gap-200"><p className="mb-100 text-200 text-primary">Connection details</p><ApiInfo label="Connection details" description="Usage and configuration metadata from the admin connection-list response. Access and owner metadata additionally use /v1/admin/connections/{connectionId}/roleAssignments; no separate connection-detail endpoint is called." /></div><h2 id="connection-details-title" tabIndex={-1} ref={detailHeading} className="break-all font-heading text-500 font-semibold focus:outline-none">{selected.displayName}</h2></div>
            <button className={control} aria-label="Close connection details" onClick={() => setSelectedId(null)}><X size={18} /></button>
          </div>
          <dl className="mt-500 grid gap-400 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ['Connection ID', selected.id], ['Source type', selected.sourceType],
              ['Endpoint origin (path omitted)', selected.endpoint], ['Endpoint category', selected.endpointCategory],
              ['Connectivity', connectivityLabel(selected.connectivityType)], ['Gateway ID', selected.gatewayId],
              ['Privacy level', selected.privacyLevel], ['Credential type', selected.credentialType],
              ['Single sign-on type', selected.singleSignOnType],
              ['Skip test connection', formatReportedBoolean(selected.skipTestConnection)],
              ['Usage in user-controlled code allowed', formatReportedBoolean(selected.allowUsageInUserControlledCode)],
              ['Connection usage in gateway allowed', formatReportedBoolean(selected.allowConnectionUsageInGateway)],
              ['Encryption policy', selected.connectionEncryption], ['Created (UTC)', formatDate(selected.createdDateTime)],
              ['Last bound (UTC)', formatDate(selected.lastBoundDateTime)],
              ['Last credential use (UTC)', formatDate(selected.lastCredentialUsedDateTime)],
              ['Last bound - calling identity (UTC)', formatDate(selected.myLastBoundDateTime)],
              ['Last used - calling identity (UTC)', formatDate(selected.myLastCredentialUsedDateTime)],
            ].map(([label, value]) => <div key={label}><dt className="text-200 text-muted-foreground">{label}</dt><dd className="mt-100 break-all text-300">{value ?? 'Not reported'}</dd></div>)}
          </dl>
          <div className="mt-500 border-t border-border pt-400">
            <div className="flex items-center gap-200">
              <h3 className="font-heading text-400 font-semibold">Current access assignments</h3>
              <ApiInfo label="Connection access" endpoint="/v1/admin/connections/{connectionId}/roleAssignments"
                description="All direct role assignments returned by the admin API, including owners and other roles. Group membership and effective inherited access are not expanded." />
            </div>
            {!selected.ownerStatus.ok
              ? <p className="mt-200 text-300 text-destructive">Access assignments unavailable: {selected.ownerStatus.message}</p>
              : selected.roleAssignments.length === 0
                ? <p className="mt-200 text-300 text-muted-foreground">No access assignments reported.</p>
                : <div className="mt-300 overflow-x-auto"><table aria-label="Connection access assignments" className="w-full text-left text-300">
                  <thead className="bg-secondary text-200 text-muted-foreground"><tr>
                    {['Principal', 'Type', 'Role'].map((label) => <th key={label} scope="col" className="px-300 py-200 font-medium">{label}</th>)}
                  </tr></thead>
                  <tbody>{selected.roleAssignments.map((assignment) => <tr key={assignment.id} className="border-t border-border">
                    <td className="break-all px-300 py-200">
                      {assignment.principal.displayName && <p className="font-semibold">{assignment.principal.displayName}</p>}
                      <p className="font-monospace text-200">{assignment.principal.id}</p>
                    </td>
                    <td className="px-300 py-200">{assignment.principal.type}</td>
                    <td className="px-300 py-200">{assignment.role}</td>
                  </tr>)}</tbody>
                </table></div>}
            <p className="mt-200 text-200 text-muted-foreground">These are current direct assignments, not creator attribution or an expanded list of group members.</p>
          </div>
          <p className="mt-300 text-200 text-muted-foreground">Calling-identity dates refer to the notebook's collection identity, not necessarily you. Dashboard refresh does not impersonate the viewer at the admin API.</p>
        </section>}
        </div>
        {pageView === 'deleted' && <DeletedConnections actions={deletionActions} loading={actionsLoading} stale={actionsError !== null} />}
        <footer className="pb-400 text-200 leading-400 text-muted-foreground">
          <strong>Review signals are not deletion recommendations.</strong> Stale usage uses the latest reported binding or credential use, with newly created connections excluded. Missing usage stays unknown. This API does not prove a connection is unreferenced, unhealthy, or safe to delete. Endpoint origins contain only scheme, host, and port where reported; paths, query strings, user information, and credential values are omitted.
        </footer>
      </main>
    </div>
  );
}

export default App;
