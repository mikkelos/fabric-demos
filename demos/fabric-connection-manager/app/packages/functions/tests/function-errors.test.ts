import { InvocationContext } from '@azure/functions';
import { ApiClient } from '@microsoft/rayfin-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFormattedReturnType } from '../../../node_modules/@microsoft/fabric-user-data-functions/dist/internal/ensureFormattedReturnType.js';
import { FunctionClient } from '../../../node_modules/@microsoft/rayfin-functions/dist/FunctionClient.js';
import { AdmissionError } from '../src/admission.js';
import { CallerIdentityError } from '../src/identity.js';

const { handlers, requester } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  requester: vi.fn(),
}));

vi.mock('@microsoft/fabric-user-data-functions', async importOriginal => ({
  ...await importOriginal<typeof import('@microsoft/fabric-user-data-functions')>(),
  UserDataFunctions: class {
    func(name: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(name, handler);
    }
  },
}));
vi.mock('../src/identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/identity.js')>(),
  verifiedRequester: requester,
}));

await import('../src/function_app.js');

const id = '11111111-1111-4111-8111-111111111111';
const calls = [
  { name: 'getDeletionActions', args: ['', '', {}] },
  { name: 'logForDeletion', args: [id, id, JSON.stringify([id]), {}] },
  { name: 'cancelDeletionRequests', args: [JSON.stringify([id]), {}] },
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe.each(calls)('$name wire errors', ({ name, args }) => {
  it.each([
    { error: new AdmissionError('IDENTITY_UNAVAILABLE'), code: 'IDENTITY_UNAVAILABLE', reason: undefined },
    { error: new Error('private provider detail must not escape'), code: 'RUNTIME_UNAVAILABLE', reason: undefined },
    { error: new CallerIdentityError('TOKEN_EXPIRED'), code: 'UNAUTHENTICATED', reason: 'TOKEN_EXPIRED' },
  ])('preserves only the safe $code diagnostic through the SDK', async ({ error, code, reason }) => {
    requester.mockRejectedValue(error);
    const handler = handlers.get(name);
    expect(handler).toBeDefined();
    if (!handler) throw new Error(`Missing registration: ${name}`);
    const context = new InvocationContext({ invocationId: id });
    context.error = vi.fn();
    const response = await ensureFormattedReturnType(
      () => handler(...args), name, id, context,
    );
    const body = JSON.parse(String(response.body));
    expect(body.status).toBe('Failed');
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].errorCode).toBe(code);
    expect(body.errors[0].properties).toEqual({});
    const diagnostic = JSON.parse(body.errors[0].message);
    expect(diagnostic).toEqual({
      failureCode: code,
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ...(reason ? { identityFailure: reason } : {}),
    });
    expect(String(response.body)).not.toContain('private provider detail');
    expect(JSON.stringify(context.error.mock.calls)).not.toContain('private provider detail');

    for (const status of [200, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(String(response.body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })));
      const client = new FunctionClient(new ApiClient({
        baseUrl: 'https://example.test',
        publishableKey: 'synthetic-test-key',
      }), name);
      const failure = await client.invoke({}).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error('Expected an SDK invocation error');
      expect(failure.message.replaceAll('\\"', '"')).toContain(body.errors[0].message);
      expect(failure.message).not.toContain('private provider detail');
    }
  });
});
