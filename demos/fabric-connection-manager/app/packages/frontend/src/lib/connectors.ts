// #region rayfin:app-owned — copied verbatim by the Rayfin CLI; edit freely.
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type {
  ConnectorConfig,
  ConnectorsRuntime,
} from '@microsoft/rayfin-connectors';
// #endregion rayfin:app-owned

import { connectorConfig, type ConnectionInventorySchema } from '../../../../rayfin/connectors/connectioninventory/schema';

export type AppConnectorsSchema = { connectioninventory: ConnectionInventorySchema };

export const connectorConfigs: Record<string, ConnectorConfig> = { connectioninventory: connectorConfig };

export const connectorRuntimes: ConnectorsRuntime = {};
