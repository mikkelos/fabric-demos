import { describe, expect, it, vi } from 'vitest';
import { discoverQueueTarget, discoverTargets, parseTargets, resources } from '../src/metadata.js';

function fixtures() {
  return {
    lakehouse: { properties: { sqlEndpointProperties: {
      id: resources.sqlEndpointId,
      connectionString: 'synthetic.datawarehouse.fabric.microsoft.com',
    } } },
    database: { properties: {
      serverFqdn: 'synthetic.database.fabric.microsoft.com', databaseName: 'synthetic-queue',
    } },
  };
}

describe('metadata discovery', () => {
  it('discovers only the fixed SQL store for state reads and cancellation', async () => {
    const { database } = fixtures();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(database)));
    await expect(discoverQueueTarget('synthetic-token', fetcher)).resolves.toMatchObject({
      database: 'synthetic-queue',
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(
      `https://api.fabric.microsoft.com/v1/workspaces/${resources.workspaceId}/sqlDatabases/${resources.sqlDatabaseId}`,
    );
  });
  it('normalizes documented metadata host,1433 to a DNS-only SQL target', () => {
    const { lakehouse, database } = fixtures();
    database.properties.serverFqdn = 'Synthetic.database.fabric.microsoft.com,1433';
    lakehouse.properties.sqlEndpointProperties.connectionString =
      'Synthetic.datawarehouse.fabric.microsoft.com,1433';
    expect(parseTargets(lakehouse, database)).toEqual({
      inventory: {
        server: 'synthetic.datawarehouse.fabric.microsoft.com',
        database: resources.sqlEndpointId,
      },
      queue: {
        server: 'synthetic.database.fabric.microsoft.com',
        database: 'synthetic-queue',
      },
    });
  });

  it('uses only documented GET item metadata endpoints and disallows redirects', async () => {
    const { lakehouse, database } = fixtures();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(lakehouse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(database)));
    const result = await discoverTargets('synthetic-token', fetcher);
    expect(result.inventory.database).toBe(resources.sqlEndpointId);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `https://api.fabric.microsoft.com/v1/workspaces/${resources.workspaceId}/lakehouses/${resources.lakehouseId}`,
      `https://api.fabric.microsoft.com/v1/workspaces/${resources.workspaceId}/sqlDatabases/${resources.sqlDatabaseId}`,
    ]);
    expect(fetcher.mock.calls.every(call => call[1]?.method === 'GET' && call[1]?.redirect === 'error')).toBe(true);
  });

  it.each([
    'https://synthetic.database.fabric.microsoft.com',
    'synthetic.database.fabric.microsoft.com.evil.test',
    'localhost', '127.0.0.1', 'synthetic.database.fabric.microsoft.com;Password=bad',
    'synthetic.database.fabric.microsoft.com,1444',
    'synthetic.database.fabric.microsoft.com:1433',
    'synthetic.database.fabric.microsoft.com,1433,1433',
    'synthetic.database.fabric.microsoft.com,01433',
    'synthetic.database.fabric.microsoft.com,1433\n',
    'synthetic.database.fabric.microsoft.com\u0000,1433',
    'synthetic.database.fabric.microsoft.com/path,1433',
    'synthetic.database.fabric.microsoft.com?query,1433',
    'tcp:synthetic.database.fabric.microsoft.com,1433',
    `${'a'.repeat(64)}.database.fabric.microsoft.com,1433`,
    '',
  ])('rejects unsafe SQL hosts from metadata %j', server => {
    const { lakehouse, database } = fixtures();
    database.properties.serverFqdn = server;
    expect(() => parseTargets(lakehouse, database)).toThrow('INVALID_METADATA');
  });

  it('rejects unexpected inventory SQL endpoint identity', () => {
    const { lakehouse, database } = fixtures();
    lakehouse.properties.sqlEndpointProperties.id = resources.sqlDatabaseId;
    expect(() => parseTargets(lakehouse, database)).toThrow('INVALID_METADATA');
  });

  it.each([null, {}, { properties: null }, { properties: {} }])('rejects missing metadata', value => {
    expect(() => parseTargets(value, value)).toThrow('INVALID_METADATA');
  });

  it.each([403, 404, 429, 500])('sanitizes provider HTTP %d failures', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-provider-details', { status }));
    await expect(discoverTargets('synthetic-token', fetcher)).rejects.toMatchObject({
      code: 'METADATA_UNAVAILABLE', message: 'METADATA_UNAVAILABLE',
    });
  });

  it('sanitizes thrown transport errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-provider-details'));
    await expect(discoverTargets('synthetic-token', fetcher)).rejects.toThrow('METADATA_UNAVAILABLE');
  });

  it.each(['not-json', 'x'.repeat(65_537)])('rejects malformed or oversized metadata', async response => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(response));
    await expect(discoverTargets('synthetic-token', fetcher)).rejects.toThrow('METADATA_UNAVAILABLE');
  });
});
