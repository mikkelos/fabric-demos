import { ShieldCheck } from 'lucide-react';

export function ConnectionIdentity() {
  return (
    <div className="flex gap-300 rounded-xl border border-border bg-card p-400 text-300">
      <ShieldCheck className="shrink-0 text-primary" size={20} aria-hidden="true" />
      <p><strong>Snapshot visibility.</strong> The notebook collects tenant-wide inventory using its execution identity. The read-only connector accesses the stored snapshot using the app identity, not the signed-in viewer's admin API permissions. Access to this app must be restricted to authorized inventory readers. Caller-specific usage dates refer to the collector identity, not necessarily yours. No connection is modified.</p>
    </div>
  );
}
