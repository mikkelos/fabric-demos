import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { generateFunctionsMetadataFiles } from '../../../node_modules/@microsoft/rayfin-cli/dist/utils/functions-metadata-generator.js';

it.each(['semantic', 'source-only'] as const)(
  'classifies every public scalar as a body input using %s registration analysis',
  async mode => {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const { runtimeMetadata } = await generateFunctionsMetadataFiles(
    directory, mode === 'source-only' ? { functionsProgram: null } : undefined,
  );
  const registration = runtimeMetadata.functions.find(fn => fn.functionName === 'logForDeletion');
  expect(registration).toBeDefined();
  expect(registration?.delegateParameters.map(parameter => ({
    name: parameter.name,
    injected: parameter.isFabricParameter,
  }))).toEqual([
    { name: 'requestId', injected: false },
    { name: 'snapshotRunId', injected: false },
    { name: 'selectedIdsJson', injected: false },
    { name: 'context', injected: true },
  ]);
  expect(registration?.contextAudiences.toSorted()).toEqual(['Fabric', 'Sql']);
  const read = runtimeMetadata.functions.find(fn => fn.functionName === 'getDeletionActions');
  expect(read?.delegateParameters.map(parameter => [parameter.name, parameter.isFabricParameter])).toEqual([
    ['afterId', false], ['watermark', false], ['context', true],
  ]);
  const cancel = runtimeMetadata.functions.find(fn => fn.functionName === 'cancelDeletionRequests');
  expect(cancel?.delegateParameters.map(parameter => [parameter.name, parameter.isFabricParameter])).toEqual([
    ['selectedRequestIdsJson', false], ['context', true],
  ]);
  expect(read?.contextAudiences.toSorted()).toEqual(['Fabric', 'Sql']);
  expect(cancel?.contextAudiences.toSorted()).toEqual(['Fabric', 'Sql']);
  }, 20_000,
);
