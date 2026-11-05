import type { GraphQLBackedConnector } from '@microsoft/rayfin-connector-fabric-graphql';
import type { ConnectorConfig } from '@microsoft/rayfin-connectors';
import { CollectionRuns } from './CollectionRuns.js';
import { ConnectionSnapshots } from './ConnectionSnapshots.js';
import { ConnectionRoleAssignments } from './ConnectionRoleAssignments.js';

export { CollectionRuns, ConnectionSnapshots, ConnectionRoleAssignments };

export const connectorConfig = {
  connector: 'fabric-sqlanalytics',
  operations: ['read'],
  entities: { CollectionRuns, ConnectionSnapshots, ConnectionRoleAssignments },
} as const satisfies ConnectorConfig;

export type ConnectionInventorySchema = GraphQLBackedConnector<
  { CollectionRuns: typeof CollectionRuns; ConnectionSnapshots: typeof ConnectionSnapshots; ConnectionRoleAssignments: typeof ConnectionRoleAssignments },
  typeof connectorConfig
>;
