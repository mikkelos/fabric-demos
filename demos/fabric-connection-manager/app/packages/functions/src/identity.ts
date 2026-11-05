import { AuthApi } from '@microsoft/rayfin-auth';
import { ApiClient } from '@microsoft/rayfin-lib';
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { AdmissionError, maxRequesterLength } from './admission.js';

type IdentityFailure =
  | 'MISSING_TOKEN' | 'INVALID_RUNTIME_CONTEXT' | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED' | 'TOKEN_NOT_ACTIVE' | 'MISSING_REQUIRED_CLAIM'
  | 'INVALID_SUBJECT' | 'SUBJECT_TOO_LONG' | 'INVALID_SIGNATURE'
  | 'SIGNING_KEY_NOT_FOUND' | 'UNSUPPORTED_ALGORITHM' | 'VERIFICATION_UNAVAILABLE'
  | 'CRYPTO_UNAVAILABLE' | 'KEY_IMPORT_FAILED';

export class CallerIdentityError extends AdmissionError {
  constructor(
    readonly identityFailure: IdentityFailure,
    code: 'UNAUTHENTICATED' | 'IDENTITY_UNAVAILABLE' = 'UNAUTHENTICATED',
  ) {
    super(code);
  }
}

export interface RuntimeIdentity {
  accessToken: string;
  baseUrl: string;
  publishableKey: string;
}

export function requesterFromClaims(claims: JWTPayload): string {
  if (typeof claims.sub !== 'string' || !claims.sub.trim()
    || claims.sub.trim() !== claims.sub
    || /[\u0000-\u001f\u007f]/.test(claims.sub)) {
    throw new CallerIdentityError('INVALID_SUBJECT');
  }
  if (claims.sub.length > maxRequesterLength) throw new CallerIdentityError('SUBJECT_TOO_LONG');
  return claims.sub;
}

function verificationKeys(jwks: JSONWebKeySet): JSONWebKeySet {
  return {
    keys: jwks.keys.map(key => {
      if (key.use !== 'sig') return key;
      const signatureKey = { ...key };
      // Hosted JWKS serializes absent optional arrays as []; some runtimes reject empty RSA oth.
      if (Array.isArray(key.key_ops) && key.key_ops.length === 0) delete signatureKey.key_ops;
      if (key.kty === 'RSA' && Array.isArray(key.oth) && key.oth.length === 0) delete signatureKey.oth;
      return signatureKey;
    }),
  };
}

export async function verifiedRequester(runtime: RuntimeIdentity): Promise<string> {
  if (typeof runtime.accessToken !== 'string' || !runtime.accessToken) {
    throw new CallerIdentityError('MISSING_TOKEN');
  }
  if (runtime.accessToken.length > 16_384) throw new CallerIdentityError('INVALID_TOKEN');
  if (typeof runtime.baseUrl !== 'string' || !runtime.baseUrl
    || typeof runtime.publishableKey !== 'string' || !runtime.publishableKey) {
    throw new CallerIdentityError('INVALID_RUNTIME_CONTEXT');
  }
  let keys;
  try {
    keys = await new AuthApi(new ApiClient({
      baseUrl: runtime.baseUrl,
      publishableKey: runtime.publishableKey,
      timeout: 15_000,
    })).getJwks();
  } catch {
    throw new AdmissionError('IDENTITY_UNAVAILABLE');
  }
  if (!globalThis.crypto?.subtle) {
    throw new CallerIdentityError('CRYPTO_UNAVAILABLE', 'IDENTITY_UNAVAILABLE');
  }
  try {
    const { payload } = await jwtVerify(runtime.accessToken, createLocalJWKSet(verificationKeys(keys)), {
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'exp'],
    });
    return requesterFromClaims(payload);
  } catch (error) {
    if (error instanceof CallerIdentityError) throw error;
    if (error instanceof errors.JWTExpired) throw new CallerIdentityError('TOKEN_EXPIRED');
    if (error instanceof errors.JWTClaimValidationFailed) {
      throw new CallerIdentityError(error.reason === 'missing' ? 'MISSING_REQUIRED_CLAIM'
        : error.claim === 'nbf' ? 'TOKEN_NOT_ACTIVE' : 'INVALID_TOKEN');
    }
    if (error instanceof errors.JWSSignatureVerificationFailed) {
      throw new CallerIdentityError('INVALID_SIGNATURE');
    }
    if (error instanceof errors.JWKSNoMatchingKey) throw new CallerIdentityError('SIGNING_KEY_NOT_FOUND');
    if (error instanceof errors.JOSEAlgNotAllowed) throw new CallerIdentityError('UNSUPPORTED_ALGORITHM');
    if (error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid) {
      throw new CallerIdentityError('INVALID_TOKEN');
    }
    if (error instanceof Error && error.name === 'DataError') {
      throw new CallerIdentityError('KEY_IMPORT_FAILED', 'IDENTITY_UNAVAILABLE');
    }
    throw new CallerIdentityError('VERIFICATION_UNAVAILABLE', 'IDENTITY_UNAVAILABLE');
  }
}
