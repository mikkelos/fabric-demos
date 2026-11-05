import { VegaVisual, useCssTheme, type VisualizationSpec } from '@microsoft/fabric-visuals';
import type { DataTable, InteractionEvent } from '@microsoft/fabric-visuals-core';
import type { ConnectionSummary } from '@rayfin-app/shared';
import { credentialDistribution } from '../lib/connection-inventory';

const spec: VisualizationSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  description: 'Credential types for connections matching all active inventory filters, before pagination.',
  width: 'container',
  height: 'container',
  data: { name: 'credentialDistribution' },
  mark: { type: 'bar', cornerRadiusEnd: 4 },
  encoding: {
    y: { field: 'credential', type: 'nominal', sort: '-x', title: null },
    x: { field: 'count', type: 'quantitative', title: 'Connections', axis: { tickMinStep: 1 } },
    tooltip: [
      { field: 'credential', type: 'nominal', title: 'Credential type' },
      { field: 'count', type: 'quantitative', title: 'Connections', format: ',.0f' },
      { field: 'percentage', type: 'quantitative', title: 'Share of filtered connections (%)', format: '.1f' },
    ],
  },
};

interface Props {
  connections: readonly ConnectionSummary[];
  loaded: boolean;
  selectedCredential: string;
  onSelect: (credential: string) => void;
}

export function CredentialDistribution({ connections, loaded, selectedCredential, onSelect }: Props) {
  const theme = useCssTheme();
  const groups = credentialDistribution(connections);
  const data: DataTable = {
    columns: [
      { name: 'credential', displayName: 'Credential type' },
      { name: 'count', displayName: 'Connections', format: '#,##0' },
      { name: 'percentage', displayName: 'Share of filtered connections (%)', format: '0.0' },
    ],
    rows: groups.map(({ label, count, percentage }) => [label, count, percentage]),
  };

  function handleInteraction(events: InteractionEvent[]) {
    for (const event of events) {
      if (event.action === 'clear') onSelect('');
      else {
        const predicate = event.selections.flatMap((selection) => selection.predicates)
          .find((value) => value.type === 'set' && value.name === 'credential');
        if (predicate?.type === 'set') {
          const label = predicate.values[0];
          if (typeof label === 'string' && groups.some((group) => group.label === label)) onSelect(label);
        }
      }
    }
  }

  return <section aria-labelledby="credential-distribution-title" className="rounded-xl border border-border bg-card p-500">
    <h2 id="credential-distribution-title" className="font-heading text-400 font-semibold">Credential distribution</h2>
    <p id="credential-distribution-scope" className="mt-100 text-200 text-muted-foreground">
      Matches all active inventory filters, including credential type, before pagination. Percentages use the {connections.length.toLocaleString()} matching connections, not the tenant total. Unknown means credential metadata is missing, not that authentication is absent.
    </p>
    {!loaded ? <p className="mt-300 text-300 text-muted-foreground">Distribution available after the inventory loads.</p>
      : groups.length === 0 ? <p className="mt-300 text-300 text-muted-foreground">No connections match the current filters.</p>
        : <div className="mt-400 grid gap-400 md:grid-cols-2">
          <div className="grid min-h-64" style={{ height: `${Math.max(16, groups.length * 2.5 + 3)}rem` }} aria-hidden="true">
            <VegaVisual spec={spec} data={{ credentialDistribution: data }} theme={theme} onInteraction={handleInteraction} />
          </div>
          <ul aria-label="Credential counts and filter controls" aria-describedby="credential-distribution-scope" className="space-y-200">
            {groups.map(({ label, count, percentage }) => <li key={label}>
              <button type="button" aria-label={`Filter credential type: ${label}`} aria-pressed={selectedCredential === label}
                onClick={() => onSelect(selectedCredential === label ? '' : label)}
                className="flex w-full items-center justify-between gap-300 rounded-lg border border-border px-300 py-200 text-left text-300 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                <span className="min-w-0 break-words font-medium">{label}</span>
                <span className="shrink-0 font-numeric">{count.toLocaleString()} ({percentage.toFixed(1)}%)</span>
              </button>
            </li>)}
          </ul>
        </div>}
  </section>;
}
