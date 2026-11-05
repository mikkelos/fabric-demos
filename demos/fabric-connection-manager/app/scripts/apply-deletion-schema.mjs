import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { discoverQueueTarget, resources } from '../packages/functions/dist/metadata.js';
import { cancelRequests, logRequests, readActions, sqlConfig } from '../packages/functions/dist/sql.js';
import { maxRequesterLength } from '../packages/functions/dist/admission.js';
import { cleanupDeletionTestData } from './cleanup-deletion-test-data.mjs';
import { loadDeploymentConfig } from './deployment-config.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--schema-only', '--integration'].includes(arg))
  || (args.includes('--schema-only') && args.includes('--integration'))) throw new Error('UNSUPPORTED_ARGUMENT');
const schemaOnly = !args.includes('--integration');
const actor = 'synthetic-schema-verification';
const worker = 'synthetic-schema-verification-worker';
const snapshotId = '22222222-2222-4222-8222-222222222222';
const tracked = new Set();
let pool;
let target;
let stage = 'database-discovery';
let failure;
const evidence = { adminApiCalls: 0, realQueueWrites: 0 };
const request = transaction => transaction ? new sql.Request(transaction) : pool.request();
const baseline = ids => JSON.stringify(ids.map(connectionId => ({
  connectionId,
  displayName: 'Synthetic schema verification - no real connection or API call',
  connectivityType: 'Synthetic',
  sourceType: 'Synthetic',
  createdAt: '2000-01-01T00:00:00.000Z',
  lastBoundAt: null,
  lastCredentialUsedAt: null,
})));
const rawLog = (ids, batchId, requestedBy = actor, transaction, connectionsJson = baseline(ids)) => request(transaction)
  .input('BatchId', sql.UniqueIdentifier, batchId)
  .input('SnapshotRunId', sql.UniqueIdentifier, snapshotId)
  .input('RequestedBy', sql.NVarChar(maxRequesterLength), requestedBy)
  .input('ConnectionsJson', sql.NVarChar(sql.MAX), connectionsJson)
  .execute('operations.LogDeletionRequests');
const rawCancel = (ids, requestedBy = actor, transaction) => request(transaction)
  .input('RequestedBy', sql.NVarChar(maxRequesterLength), requestedBy)
  .input('RequestIdsJson', sql.NVarChar(sql.MAX), JSON.stringify(ids))
  .execute('operations.CancelDeletionRequests');
const finish = (id, eventType = 'deletion_cancelled', transaction) => request(transaction)
  .input('RequestId', sql.UniqueIdentifier, id)
  .input('EventType', sql.VarChar(30), eventType)
  .input('WorkerRunId', sql.NVarChar(200), worker)
  .input('Reason', sql.NVarChar(200), 'synthetic_test_no_api_call')
  .execute('operations.RecordDeletionOutcome');
function assert(condition, code) {
  if (!condition) throw new Error(code);
}
async function rejected(operation, numbers) {
  try {
    await operation();
  } catch (error) {
    if (numbers.includes(error?.number)) return;
    throw error;
  }
  throw new Error('EXPECTED_CONFLICT_NOT_REJECTED');
}
async function rowsForBatch(batchId, transaction) {
  const result = await request(transaction)
    .input('Batch', sql.UniqueIdentifier, batchId)
    .input('Actor', sql.NVarChar(200), actor)
    .query(`SELECT request_id, connection_id, status FROM operations.deletion_requests
      WHERE batch_id = @Batch AND requested_by = @Actor`);
  return result.recordset;
}
async function create(ids, batchId = randomUUID()) {
  await rawLog(ids, batchId);
  const rows = await rowsForBatch(batchId);
  assert(rows.length === ids.length, 'SYNTHETIC_MARK_COUNT_MISMATCH');
  rows.forEach(row => tracked.add(row.request_id));
  return { batchId, rows };
}
async function setSyntheticState(id, status, attempted = false) {
  const result = await pool.request()
    .input('Id', sql.UniqueIdentifier, id)
    .input('Status', sql.VarChar(24), status)
    .input('Attempted', sql.Bit, attempted)
    .input('Owner', sql.NVarChar(200), status === 'pending' ? null : worker)
    .input('Actor', sql.NVarChar(200), actor)
    .query(`UPDATE operations.deletion_requests SET status = @Status,
        delete_attempted = @Attempted, claim_owner = @Owner
      WHERE request_id = @Id AND requested_by = @Actor
        AND JSON_VALUE(baseline_json, '$.sourceType') = 'Synthetic'
        AND status IN ('pending', 'processing', 'reconcile')`);
  assert(result.rowsAffected[0] === 1, 'SYNTHETIC_STATE_TRANSITION_FAILED');
}
async function state(id) {
  const result = await pool.request().input('Id', sql.UniqueIdentifier, id)
    .query('SELECT status FROM operations.deletion_requests WHERE request_id = @Id');
  return result.recordset[0]?.status;
}
async function readConnection(connectionId, watermark = null) {
  let afterId = null;
  for (let index = 0; index < 50; index++) {
    const page = await readActions(target, process.env.SQL_ACCESS_TOKEN, { afterId, watermark });
    const row = page.actions.find(action => action.connectionId === connectionId);
    if (row || !page.nextCursor) return { row, watermark: page.watermark };
    afterId = page.nextCursor;
    watermark = page.watermark;
  }
  throw new Error('SYNTHETIC_CONNECTION_READ_EXCEEDED_BOUND');
}
async function deletedRollbackProof(probe) {
  const transaction = new sql.Transaction(pool);
  let rolledBack = false;
  transaction.on('rollback', () => { rolledBack = true; });
  await transaction.begin();
  try {
    const connectionId = randomUUID();
    const batch = randomUUID();
    await rawLog([connectionId], batch, actor, transaction);
    const [row] = await rowsForBatch(batch, transaction);
    await request(transaction).input('Id', sql.UniqueIdentifier, row.request_id)
      .input('Worker', sql.NVarChar(200), worker)
      .query(`UPDATE operations.deletion_requests SET status = 'processing',
        claim_owner = @Worker, delete_attempted = 1 WHERE request_id = @Id`);
    await finish(row.request_id, 'deleted', transaction);
    let afterId = null;
    let watermark = null;
    let deleted;
    for (let index = 0; index < 50; index++) {
      const page = await request(transaction)
        .input('AfterId', sql.UniqueIdentifier, afterId)
        .input('Watermark', sql.BigInt, watermark)
        .execute('operations.GetDeletionActions');
      deleted = page.recordsets[1].find(item => item.connection_id.toLowerCase() === connectionId);
      afterId = page.recordsets[0][0].next_cursor;
      watermark = page.recordsets[0][0].watermark;
      if (deleted || !afterId) break;
    }
    const terminal = await request(transaction).input('Id', sql.UniqueIdentifier, row.request_id)
      .query(`SELECT event_at FROM operations.deletion_events
        WHERE request_id = @Id AND event_sequence = 1`);
    assert(deleted?.status === 'deleted' && deleted.pending_request_ids_json === '[]'
      && deleted.deleted_at.getTime() === terminal.recordset[0].event_at.getTime(), 'DELETED_HISTORY_MAPPING_FAILED');
    if (probe === 'cancel') {
      await rejected(() => rawCancel([row.request_id], actor, transaction), [50005]);
    } else {
      await rejected(() => rawLog([connectionId], randomUUID(), actor, transaction), [50006]);
    }
  } finally {
    if (!rolledBack) await transaction.rollback();
  }
}

async function verifyRequesterRoundTrip() {
  const transaction = new sql.Transaction(pool);
  let rolledBack = false;
  transaction.on('rollback', () => { rolledBack = true; });
  const batchId = randomUUID();
  const prefix = 'synthetic-managed-hosting-subject/';
  const subject = prefix + 'x'.repeat(maxRequesterLength - prefix.length);
  await transaction.begin();
  try {
    await rawLog([randomUUID()], batchId, subject, transaction);
    const result = await request(transaction).input('Batch', sql.UniqueIdentifier, batchId)
      .query(`SELECT r.request_id, r.requested_by, e.actor_id
        FROM operations.deletion_requests r
        JOIN operations.deletion_events e ON e.request_id = r.request_id AND e.event_sequence = 0
        WHERE r.batch_id = @Batch`);
    assert(result.recordset.length === 1
      && result.recordset[0].requested_by === subject
      && result.recordset[0].actor_id === subject, 'REQUESTER_SUBJECT_TRUNCATED');
    const id = result.recordset[0].request_id;
    assert((await rawCancel([id], subject, transaction)).recordset[0].cancelled_count === 1,
      'LONG_REQUESTER_CANCELLATION_FAILED');
    const terminal = await request(transaction).input('Id', sql.UniqueIdentifier, id)
      .query(`SELECT actor_id FROM operations.deletion_events WHERE request_id = @Id AND event_sequence = 1`);
    assert(terminal.recordset.length === 1 && terminal.recordset[0].actor_id === subject,
      'CANCELLATION_ACTOR_TRUNCATED');
  } finally {
    if (!rolledBack) await transaction.rollback();
  }
  const retained = await pool.request().input('Batch', sql.UniqueIdentifier, batchId)
    .query('SELECT COUNT(*) AS retained_count FROM operations.deletion_requests WHERE batch_id = @Batch');
  assert(retained.recordset[0].retained_count === 0, 'REQUESTER_PROOF_NOT_ROLLED_BACK');
  evidence.requesterMaxLength = maxRequesterLength;
  evidence.fullRequesterAndCancellationRoundTrip = true;
  evidence.requesterProofRolledBack = true;
}

async function applyAndVerify() {
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
  target = await discoverQueueTarget(process.env.FABRIC_MANAGEMENT_TOKEN);
  pool = await new sql.ConnectionPool(sqlConfig(target, process.env.SQL_ACCESS_TOKEN)).connect();
  const schema = await readFile(new URL('../../fabric/deletion_actions_schema.sql', import.meta.url), 'utf8');
  let batchNumber = 0;
  for (const batch of schema.split(/^\s*GO\s*$/im).filter(part => part.trim())) {
    stage = `schema-batch-${++batchNumber}`;
    await pool.request().batch(batch);
  }

  stage = 'requester-schema-verification';
  const widths = await pool.request().query(`SELECT c.max_length FROM sys.columns c
      WHERE (c.object_id = OBJECT_ID('operations.deletion_requests') AND c.name = 'requested_by')
         OR (c.object_id = OBJECT_ID('operations.deletion_events') AND c.name = 'actor_id')
    UNION ALL
    SELECT p.max_length FROM sys.parameters p
      WHERE p.object_id IN (OBJECT_ID('operations.LogDeletionRequests'), OBJECT_ID('operations.CancelDeletionRequests'))
        AND p.name = '@RequestedBy'`);
  assert(widths.recordset.length === 4 && widths.recordset.every(row => row.max_length === maxRequesterLength * 2),
    'REQUESTER_SCHEMA_WIDTH_MISMATCH');
  stage = 'requester-rollback-proof';
  await verifyRequesterRoundTrip();
  if (schemaOnly) return;

  stage = 'stable-mark-retry';
  const firstConnection = randomUUID();
  const original = await create([firstConnection]);
  const originalId = original.rows[0].request_id;
  assert((await rawLog([firstConnection], original.batchId)).recordset[0].marked_count === 1, 'MARK_RETRY_COUNT_FAILED');
  await rejected(() => rawLog([firstConnection], original.batchId, 'synthetic-conflicting-actor'), [50003]);
  await rejected(() => rawLog([firstConnection], original.batchId, actor, undefined,
    baseline([firstConnection]).replace('"sourceType":"Synthetic"', '"sourceType":"Changed"')), [50003]);
  await rejected(() => rawLog([firstConnection], randomUUID()), [50006]);
  const pinned = await readConnection(firstConnection);
  assert(pinned.row?.status === 'pending' && pinned.row.pendingRequestIds.length === 1, 'PENDING_STATE_MAPPING_FAILED');
  stage = 'user-cancel-retry';
  assert(await cancelRequests(target, process.env.SQL_ACCESS_TOKEN, [originalId], actor) === 1, 'CANCEL_COUNT_FAILED');
  assert(await cancelRequests(target, process.env.SQL_ACCESS_TOKEN, [originalId], actor) === 1, 'CANCEL_RETRY_FAILED');
  await rejected(() => rawCancel([originalId], 'synthetic-different-actor'), [50005]);
  const later = await create([firstConnection]);
  await rawCancel([originalId]);
  assert(await state(later.rows[0].request_id) === 'pending', 'OLD_CANCEL_AFFECTED_LATER_MARK');
  const oldCut = await readConnection(firstConnection, pinned.watermark);
  assert(oldCut.row?.status === 'pending' && oldCut.row.pendingRequestIds.length === 0,
    'TERMINAL_WATERMARK_OR_PENDING_ELIGIBILITY_FAILED');
  const current = await readConnection(firstConnection);
  assert(current.row?.status === 'pending'
    && current.row.pendingRequestIds.length === 1
    && current.row.pendingRequestIds[0] === later.rows[0].request_id.toLowerCase(), 'LATER_REQUEST_STATE_FAILED');
  assert((await rawLog([firstConnection], original.batchId)).recordset[0].marked_count === 1, 'STABLE_MARK_RETRY_FAILED');
  evidence.markAndCancelRetries = true;
  evidence.exactRequestCancellation = true;
  evidence.activeConnectionGuard = true;
  evidence.baselineConflictGuard = true;
  evidence.terminalWatermarkAndCurrentEligibility = true;

  stage = 'all-or-nothing-processing-guards';
  for (const status of ['processing', 'reconcile']) {
    const fixture = await create([randomUUID(), randomUUID()]);
    const [pending, processed] = fixture.rows;
    await setSyntheticState(processed.request_id, status, status === 'reconcile');
    const visible = await readConnection(processed.connection_id.toLowerCase());
    assert(visible.row?.status === status && visible.row.pendingRequestIds.length === 0,
      'CURRENT_PROCESSED_STATE_MAPPING_FAILED');
    await rejected(() => rawCancel([pending.request_id, processed.request_id]), [50005]);
    assert(await state(pending.request_id) === 'pending', 'PARTIAL_CANCELLATION_DETECTED');
    assert(await state(processed.request_id) === status, 'PROCESSED_GUARD_FAILED');
    await setSyntheticState(processed.request_id, 'pending');
  }
  const missingGuard = await create([randomUUID()]);
  await rejected(() => rawCancel([missingGuard.rows[0].request_id, randomUUID()]), [50005]);
  assert(await state(missingGuard.rows[0].request_id) === 'pending', 'MISSING_GUARD_WROTE_PARTIAL_BATCH');
  const notebookGuard = await create([randomUUID(), randomUUID()]);
  await finish(notebookGuard.rows[1].request_id);
  await finish(notebookGuard.rows[1].request_id);
  await rejected(() => finish(notebookGuard.rows[1].request_id, 'deleted'), [50003]);
  await rejected(() => rawCancel(notebookGuard.rows.map(row => row.request_id)), [50005]);
  assert(await state(notebookGuard.rows[0].request_id) === 'pending', 'NOTEBOOK_GUARD_WROTE_PARTIAL_BATCH');
  evidence.allOrNothingGuards = ['processing', 'reconcile', 'missing', 'notebook_cancelled'];
  evidence.notebookOutcomeRetryPreserved = true;

  stage = 'deleted-history-and-guards-rollback';
  await deletedRollbackProof('cancel');
  await deletedRollbackProof('mark');
  evidence.deletedHistoryAndGuardsRolledBack = true;

  stage = 'outcome-cancellation-race';
  const race = await create([randomUUID()]);
  const raceId = race.rows[0].request_id;
  const outcomes = await Promise.allSettled([finish(raceId), rawCancel([raceId])]);
  assert(outcomes.filter(result => result.status === 'fulfilled').length === 1, 'TERMINAL_RACE_NOT_SERIALIZED');
  const rejectedRace = outcomes.find(result => result.status === 'rejected');
  assert([50003, 50005].includes(rejectedRace?.reason?.number), 'UNEXPECTED_RACE_FAILURE');
  const raceEvents = await pool.request().input('Id', sql.UniqueIdentifier, raceId)
    .query(`SELECT COUNT(*) AS terminal_count FROM operations.deletion_events
      WHERE request_id = @Id AND event_sequence = 1`);
  assert(raceEvents.recordset[0].terminal_count === 1 && await state(raceId) === 'cancelled', 'TERMINAL_RACE_INVARIANT_FAILED');
  evidence.outcomeCancellationRace = true;

  stage = 'watermark-pagination';
  const ids = Array.from({ length: 501 }, () => randomUUID());
  await create(ids.slice(0, 500));
  await create(ids.slice(500));
  const firstPage = await readActions(target, process.env.SQL_ACCESS_TOKEN, { afterId: null, watermark: null });
  assert(firstPage.actions.length === 500 && firstPage.nextCursor !== null, 'FIRST_PAGE_LIMIT_FAILED');
  const afterCutId = randomUUID();
  await create([afterCutId]);
  const seen = new Set();
  let page = firstPage;
  let pageCount = 0;
  do {
    assert(++pageCount <= 50 && page.watermark === firstPage.watermark, 'UNBOUNDED_OR_CHANGED_WATERMARK');
    for (const action of page.actions) {
      assert(!seen.has(action.connectionId), 'DUPLICATE_PAGE_CONNECTION');
      seen.add(action.connectionId);
    }
    if (!page.nextCursor) break;
    page = await readActions(target, process.env.SQL_ACCESS_TOKEN, {
      afterId: page.nextCursor, watermark: firstPage.watermark,
    });
  } while (true);
  assert(ids.every(id => seen.has(id)) && !seen.has(afterCutId), 'WATERMARK_CUT_FAILED');
  evidence.fixedPageSize = 500;
  evidence.syntheticPaginatedConnections = ids.length;
  evidence.pinnedWatermarkAndUniqueConnections = true;
}

try {
  await applyAndVerify();
} catch (error) {
  failure = {
    status: 'failed', stage,
    failureCode: typeof error?.code === 'string' ? error.code : 'SCHEMA_VERIFICATION_FAILED',
    sqlNumber: typeof error?.number === 'number' ? error.number : undefined,
  };
} finally {
  if (pool && tracked.size) {
    try {
      stage = 'synthetic-cleanup';
      const pending = await pool.request()
        .input('Ids', sql.NVarChar(sql.MAX), JSON.stringify([...tracked]))
        .input('Actor', sql.NVarChar(200), actor)
        .query(`SELECT request_id, status, claim_owner, delete_attempted FROM operations.deletion_requests
          WHERE requested_by = @Actor AND request_id IN (
            SELECT CONVERT(UNIQUEIDENTIFIER, value) FROM OPENJSON(@Ids))
            AND JSON_VALUE(baseline_json, '$.sourceType') = 'Synthetic'`);
      for (const row of pending.recordset) {
        if (['processing', 'reconcile'].includes(row.status) && row.claim_owner === worker) {
          await setSyntheticState(row.request_id, 'pending');
        }
      }
      const remaining = pending.recordset.filter(row => row.status !== 'cancelled' && row.status !== 'deleted')
        .map(row => row.request_id);
      for (let start = 0; start < remaining.length; start += 500) {
        await rawCancel(remaining.slice(start, start + 500));
      }
      await pool.close();
      pool = await new sql.ConnectionPool(sqlConfig(target, process.env.SQL_ACCESS_TOKEN)).connect();
      const persisted = await pool.request()
        .input('Ids', sql.NVarChar(sql.MAX), JSON.stringify([...tracked]))
        .query(`SELECT COUNT(*) AS request_count,
            SUM(CASE WHEN r.status = 'cancelled' AND events.event_count = 2 THEN 1 ELSE 0 END) AS verified_count
          FROM operations.deletion_requests r
          CROSS APPLY (SELECT COUNT(*) AS event_count FROM operations.deletion_events e
            WHERE e.request_id = r.request_id) events
          WHERE r.request_id IN (
            SELECT CONVERT(UNIQUEIDENTIFIER, value) FROM OPENJSON(@Ids))`);
      assert(persisted.recordset[0].request_count === tracked.size
        && persisted.recordset[0].verified_count === tracked.size, 'PERSISTED_SYNTHETIC_CANCELLATION_FAILED');
      const cleanup = await cleanupDeletionTestData(pool, { apply: true, requestIds: [...tracked] });
      assert(cleanup.removedRequests === tracked.size && cleanup.removedEvents === tracked.size * 2,
        'SYNTHETIC_FIXTURE_REMOVAL_FAILED');
      const retained = await pool.request()
        .input('Ids', sql.NVarChar(sql.MAX), JSON.stringify([...tracked]))
        .query(`SELECT COUNT(*) AS retained_count FROM operations.deletion_requests
          WHERE request_id IN (SELECT CONVERT(uniqueidentifier, value) FROM OPENJSON(@Ids))`);
      assert(retained.recordset[0].retained_count === 0, 'SYNTHETIC_FIXTURES_REMAIN');
      evidence.removedSyntheticRequests = tracked.size;
      evidence.retainedSyntheticRequests = 0;
      evidence.syntheticTerminalEventsPerRequest = 1;
    } catch (error) {
      failure = {
        status: 'failed', stage,
        failureCode: typeof error?.code === 'string' ? error.code : 'SYNTHETIC_CLEANUP_FAILED',
        sqlNumber: typeof error?.number === 'number' ? error.number : undefined,
      };
    }
  }
  await pool?.close();
}
console.log(JSON.stringify(failure ?? { status: 'verified', ...evidence }));
if (failure) process.exitCode = 1;
