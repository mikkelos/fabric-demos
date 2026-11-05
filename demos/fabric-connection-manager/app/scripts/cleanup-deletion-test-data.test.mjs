import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupDeletionTestData } from './cleanup-deletion-test-data.mjs';

function fixturePool(error) {
  const inputs = new Map();
  let queries = 0;
  const counts = { scopedSyntheticRequests: 2, eligibleSyntheticRequests: 2, removedRequests: 0 };
  const request = {
    input(name, _type, value) { inputs.set(name, value); return this; },
    async query() {
      queries++;
      if (error) throw error;
      return { recordset: [counts] };
    },
  };
  return { pool: { request: () => request }, inputs, counts, queries: () => queries };
}

test('cleanup defaults to preview with explicit synthetic identity markers', async () => {
  const fixture = fixturePool();
  assert.equal(await cleanupDeletionTestData(fixture.pool), fixture.counts);
  assert.equal(fixture.inputs.get('Apply'), false);
  assert.equal(fixture.inputs.get('Ids'), null);
  assert.equal(fixture.inputs.get('Actor'), 'synthetic-schema-verification');
  assert.equal(fixture.inputs.get('Worker'), 'synthetic-schema-verification-worker');
  assert.equal(fixture.inputs.get('Snapshot'), '22222222-2222-4222-8222-222222222222');
  assert.equal(fixture.queries(), 1);
});

test('integration cleanup scopes deletion to the exact tracked request identities', async () => {
  const fixture = fixturePool();
  const requestIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  await cleanupDeletionTestData(fixture.pool, { apply: true, requestIds });
  assert.equal(fixture.inputs.get('Apply'), true);
  assert.deepEqual(JSON.parse(fixture.inputs.get('Ids')), requestIds);
});

for (const options of [
  { apply: 'true' },
  { requestIds: [] },
  { requestIds: '11111111-1111-4111-8111-111111111111' },
  { requestIds: ['not-a-uuid'] },
  { requestIds: ['00000000-0000-0000-0000-000000000000'] },
  { requestIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'] },
  { requestIds: Array(5001).fill('11111111-1111-4111-8111-111111111111') },
]) {
  test(`rejects unsafe cleanup scope: ${Object.keys(options).join(',')} (${JSON.stringify(options).length})`, async () => {
    const fixture = fixturePool();
    await assert.rejects(cleanupDeletionTestData(fixture.pool, options), /INVALID_FIXTURE_CLEANUP_SCOPE/);
    assert.equal(fixture.queries(), 0);
    assert.equal(fixture.inputs.size, 0);
  });
}

test('database rejection propagates instead of reporting cleanup success', async () => {
  const failure = new Error('synthetic database failure');
  const fixture = fixturePool(failure);
  await assert.rejects(cleanupDeletionTestData(fixture.pool, { apply: true }), error => error === failure);
});
