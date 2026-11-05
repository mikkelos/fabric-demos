# Inventory collector guide

The notebook collects connections and their direct role assignments across the
tenant and stores them in a Lakehouse. To create the resources, follow [setup](../SETUP.md);
for the dashboard, see the [app guide](../app/README.md).

## Run the notebook

1. Attach `lh_connection_inventory` as the notebook's default Lakehouse.
2. Run [inventory_schema.sql](inventory_schema.sql) in a Spark SQL cell.
3. Run [collect_connection_inventory.py](collect_connection_inventory.py) in a
   Python cell, then call:

   ```python
   run_notebook(spark, notebookutils)
   ```

4. Wait for the notebook to finish and the SQL analytics endpoint to show the
   data, then refresh the app.

Run one collector at a time. It gets a token through
`notebookutils.credentials.getToken("pbi")` using the notebook's execution
identity. That identity needs permission to call the admin inventory APIs and
write to the Lakehouse.

## Output and failures

The collector pages through these APIs:

```http
GET https://api.fabric.microsoft.com/v1/admin/connections
GET https://api.fabric.microsoft.com/v1/admin/connections/{connectionId}/roleAssignments
```

It writes three Delta tables in the `inventory` schema:

| Table | Contents |
| --- | --- |
| `collection_runs` | Status, timestamps, counts and errors |
| `connection_snapshots` | Connection metadata for each run |
| `connection_role_assignments` | Direct principal-role assignments for each run |

A run is marked `complete` after all connection pages have been read and the
data written. If an owner lookup fails but collection can continue, that
connection carries the error. A failure that stops collection marks the run
`failed`.

The app only reads completed runs. It checks row counts and relationships
because the SQL analytics endpoint may still be catching up. A completed run
with no connections is valid; missing or inconsistent data should show an error.

For HTTP(S) endpoints, only the scheme, host and optional port are kept, not
credentials, paths, query strings or fragments. Raw API responses are not stored.
Missing usage means unknown, not unused. The `my_last_*` timestamps refer to the
collector identity. See [access and data safety](../README.md#access-and-data-safety).

## Operating limits

- Requests are paced and retries are limited, so large tenants take longer.
  Detailed limits are defined in the
  [collector source](collect_connection_inventory.py).
- Each run collects the full inventory. There is no schedule, retention policy
  or resume support. An interrupted run can stay `collecting`. Connections can
  change during collection, so the result is not a single point-in-time view.

## Maintenance

The collector can add the supported optional metadata columns if they are
missing. After a schema change, update the notebook and complete a collection.
Wait for SQL synchronization before deploying a connector that reads the new
columns. Keep the historical snapshot tables.

Optional troubleshooting: if dashboard counts look wrong after synchronization,
use the read-only [snapshot consistency query](../app/scripts/verify-inventory-snapshot.sql)
to check row counts, relationships and stored endpoint values.
