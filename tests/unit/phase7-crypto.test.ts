import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { decryptSecret, encryptSecret, integrationAad } from '../../src/integrations/crypto.js';

const key = Buffer.alloc(32, 7).toString('base64');
const wrongKey = Buffer.alloc(32, 8).toString('base64');
const aad = integrationAad('TIKTOK', 'integration-1', 'access');

test('AES-256-GCM token roundtrip never emits plaintext and uses random IVs', () => {
  const first = encryptSecret('token-secret-value', key, aad);
  const second = encryptSecret('token-secret-value', key, aad);
  assert.notEqual(first, second);
  assert.equal(first.includes('token-secret-value'), false);
  assert.equal(decryptSecret(first, key, aad), 'token-secret-value');
  assert.equal(decryptSecret(second, key, aad), 'token-secret-value');
});

test('AES-256-GCM rejects tampering, wrong key and AAD mismatch', () => {
  const encrypted = encryptSecret('refresh-secret', key, integrationAad('YOUTUBE', 'integration-2', 'refresh'));
  const parts = encrypted.split(':');
  const ciphertext = parts[3] ?? '';
  parts[3] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => decryptSecret(parts.join(':'), key, integrationAad('YOUTUBE', 'integration-2', 'refresh')), /CIPHERTEXT_AUTH_FAILED/);
  assert.throws(() => decryptSecret(encrypted, wrongKey, integrationAad('YOUTUBE', 'integration-2', 'refresh')), /CIPHERTEXT_AUTH_FAILED/);
  assert.throws(() => decryptSecret(encrypted, key, integrationAad('YOUTUBE', 'other-id', 'refresh')), /CIPHERTEXT_AUTH_FAILED/);
});
