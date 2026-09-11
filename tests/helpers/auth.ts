import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';

export const TEST_ISSUER = 'https://unit.cloudflareaccess.com';
export const TEST_AUDIENCE = 'video-factory-admin-test';
export const TEST_ALLOWED_EMAIL = 'admin@example.com';

export interface TestAuthFixture {
  keyResolver: ReturnType<typeof createLocalJWKSet>;
  privateKey: KeyLike;
  sign(input?: { email?: string; issuer?: string; audience?: string; expiresInSeconds?: number; privateKey?: KeyLike }): Promise<string>;
}

export async function createTestAuthFixture(): Promise<TestAuthFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'phase2-test';
  jwk.alg = 'RS256';
  const keyResolver = createLocalJWKSet({ keys: [jwk] });

  return {
    keyResolver,
    privateKey,
    async sign(input = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email: input.email ?? TEST_ALLOWED_EMAIL })
        .setProtectedHeader({ alg: 'RS256', kid: 'phase2-test' })
        .setIssuer(input.issuer ?? TEST_ISSUER)
        .setAudience(input.audience ?? TEST_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + (input.expiresInSeconds ?? 300))
        .sign(input.privateKey ?? privateKey);
    },
  };
}
