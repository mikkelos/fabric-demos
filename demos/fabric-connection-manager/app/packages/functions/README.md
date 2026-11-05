# Deletion request Functions

These Functions save deletion requests, read their status and cancel pending
requests. They do not list or delete live Fabric connections. Actual deletion
is outside demo scope; no deletion script is included.

## Logging requests

`logForDeletion(requestId, snapshotRunId, selectedIdsJson)` validates the
selection and passes it to `operations.LogDeletionRequests`.

Keep the public scalar name `selectedIdsJson`: SDK 1.36.2 heuristically treats
parameter names containing `connection` or `fabric` as injected bindings, even
when their declared type is `string`.

## Authentication

The Function requires application authentication and the `Sql` and `Fabric`
audiences. External resource tokens remain server-side. The requested actor is
the signature- and expiry-verified full Rayfin invocation `sub`, **not a proven
human identity or an Entra object ID**. Store its actor kind as `rayfin_subject`.
Managed-hosting subjects can contain a hierarchical application/user path.
Preserve the complete verified subject, up to 2048 characters, across admission,
SQL parameters and audit columns; never truncate it or substitute its last segment.
The credential is platform-injected `context.accessToken`, never a handler input.
Hosting must keep authentication enabled and anonymous invocation disabled.
The SDK does not publish role, access-versus-refresh, issuer, or audience
constants, so the Function does not invent checks for those claims. Signature,
required expiry, and any not-before claim are independently verified against
the runtime application's public JWKS. No actor,
display name, timestamps, endpoint, or SQL target is accepted from the client.

The hosted JWKS serializer returns signature keys with `key_ops: []` and RSA
`oth: []`. The former excludes verification in `jose`; the latter causes a
key-import failure in the hosted runtime. The verifier omits these empty arrays
on keys declaring `use: "sig"` (`oth` only for RSA), without changing the SDK
response. Nonempty values, key IDs, algorithm restrictions, signatures and token
lifetimes are still checked. Do not replace this with an unverified token decode.
`KEY_IMPORT_FAILED` identifies a key-import error; `CRYPTO_UNAVAILABLE` means the
runtime cannot provide Web Crypto.

External SQL calls use the app-item owner's permissions, not the viewer's.
Viewers must be signed in and authorized to access the app; they do not need
individual SQL permissions. Restrict app access to the intended administrators.
Caller verification remains enabled for request and cancellation attribution.

## Request validation and SQL access

A request requires 1–500 unique UUIDs, the latest complete inventory run, a
snapshot no older than seven days, matching manifest/source/distinct counts,
and an exact matching selection. Only server-read baseline fields are sent to
the stored procedure. The procedure owns UTC stamping, transactional event
append, and idempotency. Its `marked_count` must include matching existing
requests and equal the selected count, including retries.

Endpoints are discovered from the fixed Lakehouse and SQL Database item
metadata. Only Fabric SQL DNS suffixes are allowed; metadata may supply a bare
host or `host,1433`, which is normalized to a DNS-only server. Other ports,
URL forms, and connection-string options are rejected. SQL uses parameterized
requests and encrypted, certificate-validated connections. Metadata, tokens,
hosts, connection strings, SQL text/errors, and provider output are never logged
or returned. Failure messages contain only `failureCode`, an independently
generated `correlationId`, and an allow-listed `identityFailure` label for caller
verification failures. No token, claim value or raw verifier error is exposed.

## Local commands

From the app root:

```powershell
npm run --workspace @rayfin-app/functions test
npm run --workspace @rayfin-app/functions build
```

Install dependencies serially from the application root. Let the approved
Rayfin development session generate `src/types.ts`; never create or edit that
generated contract manually. This workspace does not configure application
services, deploy resources, or grant runtime permissions.

## State and cancellation

`getDeletionActions(afterId, watermark)` returns a JSON-encoded
`DeletionActionsPage`. Supply empty strings for the first page; continue with
`nextCursor` and the unchanged decimal-string `watermark`. Pages contain at most
500 distinct connection IDs. The SQL event cut is pinned for marked and terminal
events; current processing/reconciliation flags may conservatively remove
cancellation eligibility. State priority is deleted, processing, reconcile,
pending, cancelled. `deletedAt` is the actual deleted event timestamp, never the
mark timestamp. The only cancellation inputs exposed in a state row are its
currently eligible pending request IDs.

The watermark predicate applies independently to the marked event and the
terminal event. A cancellation after that cut can leave the historical state
`pending` while its current `pendingRequestIds` is empty; clients must accept
that safe ineligible state. A non-null `nextCursor` is exactly the last returned
connection ID. Deleted history is based only on recorded confirmed `deleted`
events, never inferred from earlier manual API calls or a missing inventory row.

`cancelDeletionRequests(selectedRequestIdsJson)` accepts 1–500 unique request
UUIDs, not connection IDs, and returns JSON `{cancelledCount}`. A mixed batch
containing a missing, processing, reconcile, deleted, or notebook-cancelled
request fails atomically. A matching retry of the same subject's
`rayfin_subject` / `user_cancelled` event returns the full count without adding
another event. A later mark has a different request ID and cannot be affected
by retrying an earlier cancellation.

Both operations verify the platform invocation subject before discovering only
the fixed SQL Database's metadata. They execute stored procedures, not admin
connection APIs. All scalar registration names avoid the SDK's injected-name
heuristics.

### SQL procedure wire shapes

- `operations.GetDeletionActions(@AfterId uniqueidentifier = NULL,
  @Watermark bigint = NULL)` returns two recordsets:
  1. Exactly one `{watermark: varchar(20), next_cursor: varchar(36) | NULL}` row.
  2. Zero to 500 `{connection_id, connection_name, status, requested_at,
     deleted_at, pending_request_ids_json}` rows. IDs and pending JSON use UUID
     strings; timestamps are UTC SQL `datetime2`; `deleted_at` is nullable.
- `operations.CancelDeletionRequests(@RequestedBy nvarchar(2048),
  @RequestIdsJson nvarchar(max))` returns one `{cancelled_count: int}` row.
- `operations.LogDeletionRequests` rejects a new active/deleted connection in
  another batch, but preserves matching stable-batch retries.

Event writers serialize through a transaction-owned application lock; the read
procedure captures its watermark under the shared version of that lock.
Cancellation and notebook outcomes hold update/range locks on exact request
rows. A covering connection index protects admission range checks. Direct
future-worker claim updates must still honor the SQL row locks.

## Schema setup and fixture cleanup

The application-root schema script defaults to schema application plus the
rollback-only identity proof; it does not run the bulk lifecycle suite.
The optional `--integration` suite covers retry counts, all-or-nothing guards,
outcome/cancellation races, fixed-size pagination and pinned event cuts. Use a
controlled test window: it temporarily commits synthetic requests to exercise
multiple connections, then validates cancellation and deletes only that run's
tracked, positively identified synthetic requests and events. Cleanup failure
fails the command explicitly. Deleted-state checks remain rollback-only.
For an existing deployment, build the Function workspace and run
`node .\scripts\apply-deletion-schema.mjs --schema-only` from the app root.
This mode applies the idempotent schema (including widen-only identity columns),
checks all four requester/actor column and parameter widths, and verifies a
2048-character log/cancel round trip inside a rolled-back transaction. It skips
the bulk suite and leaves no synthetic request or event.

`node .\scripts\cleanup-deletion-test-data.mjs` previews removal of old cancelled
fixtures. Add `--apply` only after reviewing the aggregate counts. It checks the
synthetic actor, snapshot, baseline, unclaimed/unattempted cancelled state, and
both exact test-event shapes; genuine or ambiguous history is not deleted.
Removal is transactional, events first, under the lifecycle application lock,
and verified after reconnecting. This is an operator tool, not a runtime grant
to erase genuine audit history.
