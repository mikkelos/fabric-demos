import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthApi } from '@microsoft/rayfin-auth';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import { requesterFromClaims, verifiedRequester } from '../src/identity.js';
import { maxRequesterLength } from '../src/admission.js';

const runtime = {
  accessToken: '',
  baseUrl: 'https://synthetic.invalid',
  publishableKey: 'synthetic-public-key',
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function token(claims: JWTPayload = {}): Promise<string> {
  return new SignJWT({ sub: 'rayfin/full/invocation/subject', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(keys.privateKey);
}

async function stubJwks(metadata: Partial<JWK> = {}) {
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = {
    keys: [{ ...publicKey, kty: 'RSA', kid: 'synthetic-key', alg: 'RS256', use: 'sig', ...metadata }],
  };
  vi.spyOn(AuthApi.prototype, 'getJwks').mockResolvedValue(jwks);
  return jwks;
}

describe('Rayfin invocation subject verification', () => {
  it('identifies an unavailable verification runtime without blaming user permissions', async () => {
    await stubJwks();
    const accessToken = await token();
    vi.stubGlobal('crypto', undefined);
    await expect(verifiedRequester({ ...runtime, accessToken }))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', identityFailure: 'CRYPTO_UNAVAILABLE' });
  });

  it('keeps the full signed subject without inventing role or token-kind claims', async () => {
    await stubJwks();
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .resolves.toBe('rayfin/full/invocation/subject');
    expect(requesterFromClaims({ sub: 'rayfin-subject', role: 'not-a-public-contract' }))
      .toBe('rayfin-subject');
  });

  it('verifies the hosted signature-key shape with empty serialized key operations and omitted algorithm', async () => {
    const jwks = await stubJwks({ key_ops: [], alg: undefined });
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .resolves.toBe('rayfin/full/invocation/subject');
    expect(jwks.keys[0].key_ops).toEqual([]);
  });

  it('omits empty RSA other-prime metadata when importing hosted public signing keys', async () => {
    const jwks = await stubJwks({ key_ops: [], alg: undefined, oth: [] });
    const accessToken = await token();
    const importer = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    await expect(verifiedRequester({ ...runtime, accessToken }))
      .resolves.toBe('rayfin/full/invocation/subject');
    const jwkImport = importer.mock.calls.find(args => args[0] === 'jwk');
    expect(jwkImport).toBeDefined();
    expect(jwkImport?.[1]).not.toHaveProperty('oth');
    expect(jwks.keys[0].oth).toEqual([]);
  });

  it('reports a key-import failure without exposing provider details', async () => {
    await stubJwks();
    const accessToken = await token();
    vi.spyOn(globalThis.crypto.subtle, 'importKey')
      .mockRejectedValue(new DOMException('private-provider-details', 'DataError'));
    await expect(verifiedRequester({ ...runtime, accessToken }))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', identityFailure: 'KEY_IMPORT_FAILED' });
  });

  it('preserves explicitly allowed verification operations', async () => {
    const jwks = await stubJwks({ key_ops: ['verify'] });
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .resolves.toBe('rayfin/full/invocation/subject');
    expect(jwks.keys[0].key_ops).toEqual(['verify']);
  });

  it.each(['sign', 'encrypt', 'decrypt', 'wrapKey'])(
    'preserves the explicit nonempty key operation restriction %s',
    async operation => {
      await stubJwks({ key_ops: [operation] });
      await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
        .rejects.toMatchObject({ code: 'UNAUTHENTICATED', identityFailure: 'SIGNING_KEY_NOT_FOUND' });
    },
  );

  it.each(['enc', undefined])('does not normalize empty operations without explicit signature use %s', async use => {
    await stubJwks({ key_ops: [], use });
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', identityFailure: 'SIGNING_KEY_NOT_FOUND' });
  });

  it('preserves a mismatched declared algorithm on the hosted key shape', async () => {
    await stubJwks({ key_ops: [], alg: 'RS512' });
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', identityFailure: 'SIGNING_KEY_NOT_FOUND' });
  });

  it('still requires a matching key ID after normalizing the hosted key shape', async () => {
    await stubJwks({ key_ops: [], kid: 'another-synthetic-key' });
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', identityFailure: 'SIGNING_KEY_NOT_FOUND' });
  });

  it('accepts the SDK-supported hierarchical managed-hosting subject without truncation', async () => {
    await stubJwks();
    const subject = ['tenants', 'capacities', 'workspaces', 'items', 'users']
      .map(part => `/${part}/11111111-1111-4111-8111-111111111111`).join('');
    expect(subject.length).toBeGreaterThan(200);
    await expect(verifiedRequester({ ...runtime, accessToken: await token({ sub: subject, idtyp: 'fmi' }) }))
      .resolves.toBe(subject);
  });

  it.each([201, maxRequesterLength])('preserves a signed subject of exactly %i characters', async length => {
    await stubJwks();
    const subject = 'a'.repeat(length);
    await expect(verifiedRequester({ ...runtime, accessToken: await token({ sub: subject }) }))
      .resolves.toBe(subject);
  });

  it.each([{}, { sub: '' }, { sub: ' padded ' }, { sub: 'a\nb' }, { sub: 'a'.repeat(maxRequesterLength + 1) }])(
    'rejects missing or malformed subjects',
    claims => expect(() => requesterFromClaims(claims)).toThrow('UNAUTHENTICATED'),
  );

  it('rejects missing runtime credentials without looking up keys', async () => {
    const lookup = vi.spyOn(AuthApi.prototype, 'getJwks');
    await expect(verifiedRequester(runtime)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED', identityFailure: 'MISSING_TOKEN',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('sanitizes unavailable runtime authentication metadata', async () => {
    vi.spyOn(AuthApi.prototype, 'getJwks').mockRejectedValue(new Error('private-provider-details'));
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', message: 'IDENTITY_UNAVAILABLE' });
  });

  it.each([false, true])('rejects invalid signatures with hosted serialization %s', async hosted => {
    await stubJwks(hosted ? { key_ops: [], oth: [] } : {});
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ sub: 'forged' })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verifiedRequester({ ...runtime, accessToken: forged })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED', identityFailure: 'INVALID_SIGNATURE',
    });
  });

  it.each([false, true])('rejects expired tokens with hosted serialization %s', async hosted => {
    await stubJwks(hosted ? { key_ops: [], oth: [] } : {});
    const expired = await new SignJWT({ sub: 'synthetic-subject' })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keys.privateKey);
    await expect(verifiedRequester({ ...runtime, accessToken: expired })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED', identityFailure: 'TOKEN_EXPIRED',
    });
  });

  it.each([false, true])('rejects not-yet-valid tokens with hosted serialization %s', async hosted => {
    await stubJwks(hosted ? { key_ops: [], oth: [] } : {});
    const future = await token({ nbf: Math.floor(Date.now() / 1000) + 60 });
    await expect(verifiedRequester({ ...runtime, accessToken: future })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED', identityFailure: 'TOKEN_NOT_ACTIVE',
    });
  });

  it.each([false, true])('requires expiry for a signed token with hosted serialization %s', async hosted => {
    await stubJwks(hosted ? { key_ops: [], oth: [] } : {});
    const noExpiry = await new SignJWT({ sub: 'synthetic-subject' })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
      .sign(keys.privateKey);
    await expect(verifiedRequester({ ...runtime, accessToken: noExpiry })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED', identityFailure: 'MISSING_REQUIRED_CLAIM',
    });
  });

  it('rejects a signed subject over the storage limit with a safe reason', async () => {
    await stubJwks();
    await expect(verifiedRequester({
      ...runtime, accessToken: await token({ sub: 'a'.repeat(maxRequesterLength + 1) }),
    })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', identityFailure: 'SUBJECT_TOO_LONG' });
  });

  it('rejects an unknown signing key without returning key or token details', async () => {
    vi.spyOn(AuthApi.prototype, 'getJwks').mockResolvedValue({ keys: [] });
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', identityFailure: 'SIGNING_KEY_NOT_FOUND' });
  });

  it('rejects malformed tokens with a safe reason', async () => {
    await stubJwks();
    await expect(verifiedRequester({ ...runtime, accessToken: 'synthetic-invalid-token' }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', identityFailure: 'INVALID_TOKEN' });
  });

  it('does not report a verification engine failure as bad user credentials', async () => {
    vi.spyOn(AuthApi.prototype, 'getJwks').mockResolvedValue({
      keys: [{ kty: 'RSA', kid: 'synthetic-key', n: 'invalid', e: 'invalid' }],
    });
    await expect(verifiedRequester({ ...runtime, accessToken: await token() }))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', identityFailure: 'VERIFICATION_UNAVAILABLE' });
  });
});
