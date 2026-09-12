import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

export const TEST_ISSUER = 'https://unit.cloudflareaccess.com';
export const TEST_ADMIN_AUDIENCE = 'video-factory-admin-test';
export const TEST_WORKER_AUDIENCE = 'video-factory-worker-test';
export const TEST_AUDIENCE = TEST_ADMIN_AUDIENCE;
export const TEST_ALLOWED_EMAIL = 'admin@example.com';

type GeneratedPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface TestAuthFixture {
  keyResolver: ReturnType<typeof createLocalJWKSet>;
  privateKey: GeneratedPrivateKey;
  sign(input?: { email?: string; issuer?: string; audience?: string; expiresInSeconds?: number; privateKey?: GeneratedPrivateKey; subject?: string }): Promise<string>;
}

export async function createTestAuthFixture(): Promise<TestAuthFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'phase4-test';
  jwk.alg = 'RS256';
  const keyResolver = createLocalJWKSet({ keys: [jwk] });

  return {
    keyResolver,
    privateKey,
    async sign(input = {}) {
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT({ email: input.email ?? TEST_ALLOWED_EMAIL })
        .setProtectedHeader({ alg: 'RS256', kid: 'phase4-test' })
        .setIssuer(input.issuer ?? TEST_ISSUER)
        .setAudience(input.audience ?? TEST_ADMIN_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + (input.expiresInSeconds ?? 300));
      if (input.subject) jwt.setSubject(input.subject);
      return jwt.sign(input.privateKey ?? privateKey);
    },
  };
}
