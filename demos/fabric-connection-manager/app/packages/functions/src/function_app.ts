import { randomUUID } from 'node:crypto';
import {
  AudienceType,
  UserDataFunctionError,
  UserDataFunctions,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';
import type { UniversalAppSchema } from '@rayfin-app/shared';
import { admitDeletion, AdmissionError } from './admission.js';
import { cancelActions, getActions, type ActionsDependencies } from './actions.js';
import { CallerIdentityError, verifiedRequester } from './identity.js';
import { discoverQueueTarget, discoverTargets, type SqlTargets } from './metadata.js';
import { cancelRequests, logRequests, readActions, readSnapshot } from './sql.js';

const udf = new UserDataFunctions();

function invocationError(error: unknown, correlationId: string): UserDataFunctionError {
  const failureCode = error instanceof AdmissionError ? error.code : 'RUNTIME_UNAVAILABLE';
  return new UserDataFunctionError(failureCode, JSON.stringify({
    failureCode, correlationId,
    ...(error instanceof CallerIdentityError ? { identityFailure: error.identityFailure } : {}),
  }));
}

udf.func(
  'logForDeletion',
  async (
    requestId: string,
    snapshotRunId: string,
    selectedIdsJson: string,
    context: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.Fabric>,
  ): Promise<string> => {
    const correlationId = randomUUID();
    try {
      let targets: SqlTargets | undefined;
      const result = await admitDeletion({ requestId, snapshotRunId, selectedIdsJson }, {
        requester: () => verifiedRequester(context),
        snapshot: async ids => {
          targets = await discoverTargets(context.Tokens.Fabric);
          return readSnapshot(targets.inventory, context.Tokens.Sql, ids);
        },
        log: batch => {
          if (!targets) throw new AdmissionError('RUNTIME_UNAVAILABLE');
          return logRequests(targets.queue, context.Tokens.Sql, batch);
        },
        now: Date.now,
      });
      return JSON.stringify(result);
    } catch (error) {
      throw invocationError(error, correlationId);
    }
  },
  [],
);

function actionsDependencies(
  context: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.Fabric>,
): ActionsDependencies {
  return {
    requester: () => verifiedRequester(context),
    read: async cursor => readActions(await discoverQueueTarget(context.Tokens.Fabric), context.Tokens.Sql, cursor),
    cancel: async (ids, requestedBy) => cancelRequests(
      await discoverQueueTarget(context.Tokens.Fabric), context.Tokens.Sql, ids, requestedBy,
    ),
  };
}

udf.func(
  'getDeletionActions',
  async (
    afterId: string,
    watermark: string,
    context: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.Fabric>,
  ): Promise<string> => {
    const correlationId = randomUUID();
    try {
      return JSON.stringify(await getActions(afterId, watermark, actionsDependencies(context)));
    } catch (error) {
      throw invocationError(error, correlationId);
    }
  },
  [],
);

udf.func(
  'cancelDeletionRequests',
  async (
    selectedRequestIdsJson: string,
    context: RayfinContext<UniversalAppSchema, AudienceType.Sql | AudienceType.Fabric>,
  ): Promise<string> => {
    const correlationId = randomUUID();
    try {
      return JSON.stringify(await cancelActions(selectedRequestIdsJson, actionsDependencies(context)));
    } catch (error) {
      throw invocationError(error, correlationId);
    }
  },
  [],
);
