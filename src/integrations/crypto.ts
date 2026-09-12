import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type SecretTokenType = 'access' | 'refresh' | 'oauth_verifier' | 'recovery';

export function decodeEncryptionKey(base64: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new Error('ENCRYPTION_KEY_INVALID');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) throw new Error('ENCRYPTION_KEY_INVALID');
  return key;
}

export function integrationAad(provider: string, integrationId: string, tokenType: SecretTokenType): string {
  return `video-factory:v1:${provider.toUpperCase()}:${integrationId}:${tokenType}`;
}

export function encryptSecret(plaintext: string, keyBase64: string, aad: string): string {
  const key = decodeEncryptionKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decryptSecret(encoded: string, keyBase64: string, aad: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('CIPHERTEXT_INVALID');
  const [, ivPart, tagPart, ciphertextPart] = parts;
  if (!ivPart || !tagPart || ciphertextPart === undefined) throw new Error('CIPHERTEXT_INVALID');
  const key = decodeEncryptionKey(keyBase64);
  try {
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('CIPHERTEXT_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('CIPHERTEXT_AUTH_FAILED');
  }
}
