import { useEffect, useRef, useState } from 'react';
import type { DeletionActionState } from '@rayfin-app/shared';

interface Props {
  actions: readonly DeletionActionState[] | null;
  loading: boolean;
  stale: boolean;
}

const control = 'rounded-lg border border-input bg-card px-300 py-200 text-300 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
const pageSize = 25;

export function DeletedConnections({ actions, loading, stale }: Props) {
  const [page, setPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const confirmed = new Map<string, DeletionActionState & { deletedAt: string }>();
  for (const action of actions ?? []) {
    if (action.status !== 'deleted' || action.deletedAt === null) continue;
    const previous = confirmed.get(action.connectionId);
    if (!previous || Date.parse(action.deletedAt) > Date.parse(previous.deletedAt)) {
      confirmed.set(action.connectionId, { ...action, deletedAt: action.deletedAt });
    }
  }
  const deleted = [...confirmed.values()].sort((a, b) =>
    Date.parse(b.deletedAt) - Date.parse(a.deletedAt) || a.connectionId.localeCompare(b.connectionId));
  const lastPage = Math.max(0, Math.ceil(deleted.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = deleted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  return <section aria-labelledby="deleted-history-title" aria-busy={loading} className="rounded-xl border border-border bg-card">
    <div className="border-b border-border p-500">
      <h2 id="deleted-history-title" ref={heading} tabIndex={-1} className="font-heading text-500 font-semibold focus-visible:outline-2 focus-visible:outline-ring">Deleted</h2>
      <p className="mt-200 text-400 font-semibold">{actions === null
        ? 'Confirmed deletion count unavailable'
        : `${deleted.length.toLocaleString()} distinct connections deleted${stale ? ' (last known)' : ''}`}</p>
      <p className="mt-100 text-200 text-muted-foreground">Only confirmed recorded deletion events are included, newest first, across all inventory filters. This history does not infer deletion from missing or stale inventory rows. Unlogged admin deletions are not audit records and do not appear here.</p>
      {loading && <p className="mt-200 text-300 text-muted-foreground" aria-live="polite">Loading confirmed deletion history...</p>}
      {stale && <p className="mt-200 text-300 text-destructive">{actions === null
        ? 'Deletion history is unavailable; an empty history has not been confirmed.'
        : 'Showing the last successfully loaded deletion history. It may be stale.'}</p>}
    </div>
    {actions !== null && deleted.length === 0 && <p className="p-500 text-300 text-muted-foreground">No confirmed deletions recorded.</p>}
    {visible.length > 0 && <div className="overflow-x-auto">
      <table aria-label="Confirmed deleted connections" className="w-full text-left text-300">
        <thead className="bg-secondary text-200 text-muted-foreground"><tr>
          {['Connection name', 'Connection ID', 'Deleted at (UTC)'].map((label) =>
            <th key={label} scope="col" className="whitespace-nowrap px-400 py-300 font-medium">{label}</th>)}
        </tr></thead>
        <tbody>{visible.map((action) => <tr key={action.connectionId} className="border-t border-border">
          <td className="break-words px-400 py-400">{action.connectionName || action.connectionId}</td>
          <td className="break-all px-400 py-400 font-monospace">{action.connectionId}</td>
          <td className="whitespace-nowrap px-400 py-400"><time dateTime={action.deletedAt}>{new Date(action.deletedAt).toLocaleString(undefined, { timeZone: 'UTC' })}</time></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {actions !== null && <div className="flex flex-wrap items-center justify-between gap-300 border-t border-border px-400 py-300 text-200 text-muted-foreground">
      <p>{deleted.length ? `${currentPage * pageSize + 1}-${Math.min((currentPage + 1) * pageSize, deleted.length)} of ${deleted.length.toLocaleString()}` : '0'} confirmed deleted connections</p>
      <div className="flex items-center gap-200">
        <button type="button" className={control} aria-label="Previous deleted page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span>Deleted page {currentPage + 1} of {lastPage + 1}</span>
        <button type="button" className={control} aria-label="Next deleted page" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</button>
      </div>
    </div>}
  </section>;
}
