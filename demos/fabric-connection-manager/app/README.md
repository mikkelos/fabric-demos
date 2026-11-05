# Fabric Connection Manager: app

The app reads the collected inventory and lets you search connections, inspect
their details, and record or cancel deletion requests.

Start with [setup](../SETUP.md) to run it. The [overview](../README.md) explains
the architecture; the [collector guide](../fabric/Readme.md) covers the notebook.

## Data and authentication

The dashboard reads the latest completed collection through the read-only
`connectioninventory` SQL analytics connector using application authentication.
Refreshing the app does not call the admin APIs or run the notebook. All pages
come from the same collection, with counts and relationships checked before
display. If a refresh fails, the app keeps the previous data and shows a warning.

Everyone using the app reads the shared tenant-wide inventory, not a list
filtered by their own connection permissions. See the
[access guidance](../README.md#access-and-data-safety) before granting app access.
The `my*` timestamps refer to the collector, not the person viewing the app.

## Dashboard behavior

- Search and filter connections, then open ownership and security details.
- See credential types for the whole filtered result, not just the current page.
- Review reported usage. Missing usage does not mean a connection is unused.
- Choose System, Light or Dark appearance.
- Select connections across filtered pages. Changing filters or refreshing clears
  the selection.

Endpoint details show only the stored HTTP(S) origin, without credentials,
paths or query strings. Categories describe the hostname; they do not prove
the source is reachable.

## Deletion requests and cancellations

Functions save requests and cancellations in a separate Fabric SQL Database,
using application identity. Resource tokens stay on the server. The audit trail
records the verified Rayfin invocation subject, which is not necessarily a
person's Entra object ID.

- Marking a connection saves a request. It does not delete the connection.
  The documented preview [Admin Delete Connection API](https://learn.microsoft.com/en-us/rest/api/fabric/admin/connections/delete-connection)
  could support a [separate implementation outside demo scope](../README.md#outside-demo-scope-possible-deletion-workflow).
- Requests require the latest complete, consistent collection, started no more
  than seven days ago.
  If logging reports `SNAPSHOT_STALE`, run `CollectConnectionInventory` in Fabric,
  wait for SQL synchronization, then refresh the inventory and select again.
- Mark/cancel commands run in batches of at most 500 and can be retried safely.
  A larger selection is not one transaction.
- Cancellation targets exact pending request IDs. Processing, reconciliation and
  confirmed-deleted rows cannot be selected for mark/cancel.
- Request status and deletion history come from the action database, not the
  inventory. Commands are disabled if status cannot be read.
- The confirmation dialog stays open until the request is saved or an error appears.

See the [Function runbook](packages/functions/README.md) and
[SQL schema](../fabric/deletion_actions_schema.sql) for validation, audit events
and authentication details.

## Local commands

Run from this directory with your own resource configuration. `npm ci` installs
the locked dependencies on a fresh checkout or after dependency changes:

```powershell
npm ci
npm run configure:deployment
npm run typecheck
npm run build
npm run lint
npm test
```

`npm run dev` uses Rayfin development tooling and may configure workspace
resources. Check the target before approving changes. To deploy, follow
[setup](../SETUP.md).

The Vite build precompiles standard connector decorators. Keep that configuration
and the authentication provider/AuthGate when changing the app.

## Operational limits

The browser loads the collected inventory before filtering it; search does not
run on the server. See the [collector guide](../fabric/Readme.md#operating-limits)
for collection limits.

Names appear only when Fabric returns them; the app does not look them up in
Entra. An old usage timestamp or owner result is a reason to investigate, not
proof that a connection is safe to delete.
