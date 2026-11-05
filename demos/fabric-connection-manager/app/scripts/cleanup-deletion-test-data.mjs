import { fileURLToPath, pathToFileURL } from 'node:url';
import sql from 'mssql';
import { isUuid } from '../packages/functions/dist/admission.js';
import { discoverQueueTarget, resources } from '../packages/functions/dist/metadata.js';
import { sqlConfig } from '../packages/functions/dist/sql.js';
import { loadDeploymentConfig } from './deployment-config.mjs';

export async function cleanupDeletionTestData(pool, { apply = false, requestIds = null } = {}) {
  if (typeof apply !== 'boolean' || (requestIds !== null
    && (!Array.isArray(requestIds) || !requestIds.length || requestIds.length > 5000
      || requestIds.some(id => !isUuid(id))
      || new Set(requestIds.map(id => id.toLowerCase())).size !== requestIds.length))) {
    throw new Error('INVALID_FIXTURE_CLEANUP_SCOPE');
  }
  const result = await pool.request()
    .input('Apply', sql.Bit, apply)
    .input('Ids', sql.NVarChar(sql.MAX), requestIds === null ? null : JSON.stringify(requestIds))
    .input('Actor', sql.NVarChar(2048), 'synthetic-schema-verification')
    .input('Worker', sql.NVarChar(200), 'synthetic-schema-verification-worker')
    .input('Snapshot', sql.UniqueIdentifier, '22222222-2222-4222-8222-222222222222')
    .query(`SET NOCOUNT ON;
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @LockResult int;
        EXEC @LockResult = sys.sp_getapplock @Resource = 'deletion-events',
          @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
        IF @LockResult < 0 THROW 50002, 'Fixture cleanup lock unavailable.', 1;
        DECLARE @RequestsBefore int = (SELECT COUNT(*) FROM operations.deletion_requests);
        DECLARE @EventsBefore int = (SELECT COUNT(*) FROM operations.deletion_events);
        DECLARE @Scoped TABLE (request_id uniqueidentifier NOT NULL PRIMARY KEY);
        INSERT @Scoped
          SELECT r.request_id FROM operations.deletion_requests r WITH (UPDLOCK, HOLDLOCK)
          WHERE r.requested_by COLLATE Latin1_General_100_BIN2 = @Actor
            AND JSON_VALUE(r.baseline_json, '$.sourceType') COLLATE Latin1_General_100_BIN2 = 'Synthetic'
            AND (@Ids IS NULL OR r.request_id IN (
              SELECT CONVERT(uniqueidentifier, value) FROM OPENJSON(@Ids)));
        DECLARE @Eligible TABLE (request_id uniqueidentifier NOT NULL PRIMARY KEY);
        INSERT @Eligible
          SELECT r.request_id FROM operations.deletion_requests r JOIN @Scoped s ON s.request_id = r.request_id
          WHERE r.snapshot_run_id = @Snapshot AND r.status = 'cancelled'
            AND r.claim_owner IS NULL AND r.delete_attempted = 0
            AND r.connection_name COLLATE Latin1_General_100_BIN2 =
              'Synthetic schema verification - no real connection or API call'
            AND JSON_VALUE(r.baseline_json, '$.displayName') COLLATE Latin1_General_100_BIN2 = r.connection_name
            AND JSON_VALUE(r.baseline_json, '$.connectivityType') COLLATE Latin1_General_100_BIN2 = 'Synthetic'
            AND TRY_CONVERT(uniqueidentifier, JSON_VALUE(r.baseline_json, '$.connectionId')) = r.connection_id
            AND (SELECT COUNT(*) FROM operations.deletion_events e WHERE e.request_id = r.request_id) = 2
            AND EXISTS (SELECT 1 FROM operations.deletion_events e WHERE e.request_id = r.request_id
              AND e.event_sequence = 0 AND e.event_type = 'marked_for_deletion'
              AND e.actor_kind = 'rayfin_subject' AND e.actor_id COLLATE Latin1_General_100_BIN2 = @Actor
              AND e.reason IS NULL AND e.api_status IS NULL AND e.api_request_id IS NULL AND e.worker_run_id IS NULL)
            AND EXISTS (SELECT 1 FROM operations.deletion_events e WHERE e.request_id = r.request_id
              AND e.event_sequence = 1 AND e.event_type = 'deletion_cancelled'
              AND e.api_status IS NULL AND e.api_request_id IS NULL
              AND ((e.actor_kind = 'rayfin_subject' AND e.actor_id COLLATE Latin1_General_100_BIN2 = @Actor
                  AND e.reason = 'user_cancelled' AND e.worker_run_id IS NULL)
                OR (e.actor_kind = 'notebook' AND e.actor_id COLLATE Latin1_General_100_BIN2 = @Worker
                  AND e.reason = 'synthetic_test_no_api_call' AND e.worker_run_id = @Worker)
                OR (r.batch_id = '11111111-1111-4111-8111-111111111111'
                  AND r.connection_id = '33333333-3333-4333-8333-333333333333'
                  AND e.actor_kind = 'notebook' AND e.actor_id COLLATE Latin1_General_100_BIN2 = @Actor
                  AND e.reason = 'synthetic_test_no_api_call'
                  AND NULLIF(TRIM(e.worker_run_id), '') IS NOT NULL)));
        DECLARE @ScopedCount int = (SELECT COUNT(*) FROM @Scoped);
        DECLARE @EligibleCount int = (SELECT COUNT(*) FROM @Eligible);
        DECLARE @RemovedEvents int = 0, @RemovedRequests int = 0;
        IF @Apply = 1
        BEGIN
          IF @ScopedCount <> @EligibleCount OR (@Ids IS NOT NULL AND
            @ScopedCount <> (SELECT COUNT(*) FROM OPENJSON(@Ids)))
            THROW 50005, 'Fixture cleanup scope did not pass safety checks.', 1;
          DELETE e FROM operations.deletion_events e JOIN @Eligible x ON x.request_id = e.request_id;
          SET @RemovedEvents = @@ROWCOUNT;
          DELETE r FROM operations.deletion_requests r JOIN @Eligible x ON x.request_id = r.request_id;
          SET @RemovedRequests = @@ROWCOUNT;
          IF @RemovedRequests <> @EligibleCount OR @RemovedEvents <> @EligibleCount * 2
            OR (SELECT COUNT(*) FROM operations.deletion_requests) <> @RequestsBefore - @RemovedRequests
            OR (SELECT COUNT(*) FROM operations.deletion_events) <> @EventsBefore - @RemovedEvents
            OR EXISTS (SELECT 1 FROM operations.deletion_requests r JOIN @Eligible x ON x.request_id = r.request_id)
            OR EXISTS (SELECT 1 FROM operations.deletion_events e JOIN @Eligible x ON x.request_id = e.request_id)
            THROW 50005, 'Fixture cleanup verification failed.', 1;
        END;
        COMMIT TRANSACTION;
        SELECT @RequestsBefore AS requestsBefore, @EventsBefore AS eventsBefore,
          @ScopedCount AS scopedSyntheticRequests, @EligibleCount AS eligibleSyntheticRequests,
          @ScopedCount - @EligibleCount AS rejectedSyntheticRequests,
          @RemovedRequests AS removedRequests, @RemovedEvents AS removedEvents,
          @RequestsBefore - @RemovedRequests AS requestsAfter, @EventsBefore - @RemovedEvents AS eventsAfter;
      END TRY
      BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;`);
  return result.recordset[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('UNSUPPORTED_ARGUMENT');
    if (!process.env.FABRIC_MANAGEMENT_TOKEN || !process.env.SQL_ACCESS_TOKEN) {
      throw new Error('PROCESS_LOCAL_TOKENS_REQUIRED');
    }
    const deploymentConfig = await loadDeploymentConfig({
      env: process.env, root: fileURLToPath(new URL('..', import.meta.url)),
    });
    if (['workspaceId', 'lakehouseId', 'sqlEndpointId', 'sqlDatabaseId']
      .some(key => deploymentConfig[key].toLowerCase() !== resources[key].toLowerCase())) {
      throw new Error('DEPLOYMENT_CONFIG_MISMATCH');
    }
    const target = await discoverQueueTarget(process.env.FABRIC_MANAGEMENT_TOKEN);
    pool = await new sql.ConnectionPool(sqlConfig(target, process.env.SQL_ACCESS_TOKEN)).connect();
    const apply = args.includes('--apply');
    const counts = await cleanupDeletionTestData(pool, { apply });
    await pool.close();
    pool = await new sql.ConnectionPool(sqlConfig(target, process.env.SQL_ACCESS_TOKEN)).connect();
    const after = await cleanupDeletionTestData(pool);
    if (apply && (after.scopedSyntheticRequests !== 0
      || after.requestsBefore !== counts.requestsAfter || after.eventsBefore !== counts.eventsAfter)) {
      throw new Error('PERSISTED_FIXTURE_CLEANUP_FAILED');
    }
    console.log(JSON.stringify({ status: apply ? 'cleaned' : 'preview', ...counts }));
  } catch (error) {
    console.log(JSON.stringify({
      status: 'failed', failureCode: 'FIXTURE_CLEANUP_FAILED',
      sqlNumber: typeof error?.number === 'number' ? error.number : undefined,
    }));
    process.exitCode = 1;
  } finally {
    await pool?.close();
  }
}
