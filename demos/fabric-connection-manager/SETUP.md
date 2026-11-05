# Setup and verification

Start with a workspace you control and check the [prerequisites](README.md#prerequisites).
Create the resources below before deploying the app. Building it locally does
not create them. The current UI also needs the SQL Database and Functions for
deletion requests, even if you only use the inventory view.

## 1. Create the inventory resources

1. Create a schema-enabled Lakehouse named `lh_connection_inventory`.
2. Create a PySpark notebook named `CollectConnectionInventory`, and attach that
   Lakehouse as its default.
3. In a notebook SQL cell, run [inventory_schema.sql](fabric/inventory_schema.sql).
   This is Spark/Delta SQL, not T-SQL for the read-only analytics endpoint.
4. Put [collect_connection_inventory.py](fabric/collect_connection_inventory.py)
   into a Python cell. In a final cell, call:

   ```python
   run_notebook(spark, notebookutils)
   ```

5. Confirm that the notebook execution identity can call the admin inventory APIs
   and write the Lakehouse.
6. Run the notebook and wait for collection to finish and the SQL analytics
   endpoint to show the data.

See the [collector guide](fabric/Readme.md) for output and failure handling.

## 2. Create the action store

Create a Fabric SQL Database named `sqldb_connection_actions`. Apply
[deletion_actions_schema.sql](fabric/deletion_actions_schema.sql) using an
authorized T-SQL client.

Give the app-owner identity permission to read the inventory and execute the
action stored procedures. The schema creates roles but does not assign users or
identities to them. In the action database, create or select the owner's Entra
database user and add it to `connection_action_submitter`. This role grants the
log, status and cancellation procedures; do not grant the processor role for
the app. Logging requests does not need permission to delete connections.

SQL calls run as the app owner. Viewers need permission to access the app, not
individual SQL permissions. Restrict app access to administrators who should
be able to view inventory and log or cancel deletion requests.

For scripted setup, `setup:deletion-store` accepts separately acquired tokens in
process environment variables `FABRIC_MANAGEMENT_TOKEN` and `SQL_ACCESS_TOKEN`.
Use an approved credential tool and clear them afterwards; never save or print
tokens. See the [Functions guide](app/packages/functions/README.md) for schema
checks and optional integration modes.

## 3. Install and configure locally

With Node.js 22.15 or newer and approved preview-package registry access, run
from `app`:

```powershell
npm ci
Copy-Item .\rayfin\.env.example .\rayfin\.env
```

`npm ci` installs the versions recorded in the lockfile. Run it on a fresh
checkout or after dependencies change.

Fill in the local file with your resource IDs and app origin:

| Variable | Resource |
| --- | --- |
| `CONNECTION_MANAGER_WORKSPACE_ID` | Target workspace |
| `CONNECTION_MANAGER_LAKEHOUSE_ID` | Inventory Lakehouse |
| `CONNECTION_MANAGER_SQL_ENDPOINT_ID` | Inventory SQL analytics endpoint |
| `CONNECTION_MANAGER_SQL_DATABASE_ID` | Action SQL Database |
| `CONNECTION_MANAGER_APP_ORIGIN` | Exact hosted HTTPS origin; localhost for local development |

For the first deployment, keep `http://localhost:5173` as the app origin.
The CLI adds the new hosting origin during deployment. After deployment, set
this variable to the returned hosting origin, without a path or trailing slash,
so future configuration generation retains it.

The configuration command generates ignored `rayfin/rayfin.yml` and server-only
`resources.generated.ts`. Keep these, the environment file and deployment caches
out of source control. Use real resource IDs and the exact app origin.

```powershell
npm run configure:deployment
npm run typecheck
npm run build
npm run lint
npm test
```

## 4. Preview and deploy

Authenticate through the supported Rayfin CLI, then preview from `app`:

```powershell
npx rayfin login
npm run rayfin:up -- -n
```

Check the target workspace and proposed changes. When ready, deploy:

```powershell
npm run rayfin:up -- --yes --json
```

The wrapper targets an item named `fabric-connection-manager`. `--yes` also
approves reusing an existing item with that name; use a dedicated workspace and
confirm the preview before proceeding.

Keep anonymous access disabled, application authentication enabled and the
inventory connector read-only. If its schema differs, regenerate connector
discovery against your Lakehouse with the installed CLI.

## 5. Verify the result

- Sign in with an authorized app user; signed-out hosting must refuse access.
- Check that the dashboard shows the collection time and expected counts.
- Search/filter connections and open ownership/security details.
- For deletion requests, use a deliberately created synthetic test connection.
  Mark it, check that the request was saved, cancel that request, and check its
  history. Do not mark real connections just to test the interface.
- The app does not perform deletions. The Deleted view only shows recorded
  confirmed deletion events, not connections missing from a collection.