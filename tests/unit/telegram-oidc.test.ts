import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { verifyTelegramIdToken } from '../../apps/api/src/auth/telegram-oidc.service';

const CLIENT_ID = '123456789';
const NONCE = 'server-generated-nonce';
const NOW = 1_800_000_000;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'telegram-test-key', alg: 'RS256', use: 'sig' };

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken(claimOverrides: Record<string, unknown> = {}, signer = privateKey): string {
  const header = part({ alg: 'RS256', typ: 'JWT', kid: 'telegram-test-key' });
  const claims = part({
    iss: 'https://oauth.telegram.org',
    aud: CLIENT_ID,
    sub: '987654321',
    iat: NOW,
    exp: NOW + 3600,
    nonce: NONCE,
    name: 'Clip Forge',
    preferred_username: 'clipforge_user',
    picture: 'https://cdn4.telesco.pe/file/avatar.jpg',
    ...claimOverrides,
  });
  const signed = `${header}.${claims}`;
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), signer).toString('base64url')}`;
}

describe('Telegram OIDC ID token verification', () => {
  it('accepts a correctly signed token and returns only verified profile claims', () => {
    expect(verifyTelegramIdToken(makeToken(), { clientId: CLIENT_ID, nonce: NONCE }, { keys: [jwk] }, NOW)).toEqual({
      id: '987654321',
      name: 'Clip Forge',
      username: 'clipforge_user',
      picture: 'https://cdn4.telesco.pe/file/avatar.jpg',
    });
  });

  it('rejects a signature from a different key', () => {
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() => verifyTelegramIdToken(makeToken({}, otherKey), { clientId: CLIENT_ID, nonce: NONCE }, { keys: [jwk] }, NOW)).toThrow(UnauthorizedException);
  });

  it('requires the authorized party claim when the audience has multiple entries', () => {
    expect(() => verifyTelegramIdToken(makeToken({ aud: [CLIENT_ID, 'another-client'] }), { clientId: CLIENT_ID, nonce: NONCE }, { keys: [jwk] }, NOW)).toThrow(UnauthorizedException);
    expect(verifyTelegramIdToken(makeToken({ aud: [CLIENT_ID, 'another-client'], azp: CLIENT_ID }), { clientId: CLIENT_ID, nonce: NONCE }, { keys: [jwk] }, NOW).id).toBe('987654321');
  });

  it.each([
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['wrong audience', { aud: '987654321' }],
    ['expired token', { exp: NOW - 120 }],
    ['wrong nonce', { nonce: 'another-login' }],
    ['non-numeric Telegram subject', { sub: 'clipforge_user' }],
  ])('rejects %s', (_label, claims) => {
    expect(() => verifyTelegramIdToken(makeToken(claims), { clientId: CLIENT_ID, nonce: NONCE }, { keys: [jwk] }, NOW)).toThrow(UnauthorizedException);
  });

  it('does not accept a token signed with a different algorithm', () => {
    const token = makeToken();
    const [header, payload, signature] = token.split('.');
    const badHeader = part({ alg: 'none', kid: 'telegram-test-key' });
    expect(() => verifyTelegramIdToken(`${badHeader}.${payload}.${signature}`, { clientId: CLIENT_ID, nonce: NONCE }, { keys: [jwk] }, NOW)).toThrow(UnauthorizedException);
  });

  it('drops unsafe or non-Telegram photo URLs without rejecting the identity', () => {
    const result = verifyTelegramIdToken(makeToken({ picture: 'https://tracker.example/pixel' }), { clientId: CLIENT_ID, nonce: NONCE }, { keys: [jwk] }, NOW);
    expect(result.picture).toBeNull();
  });
});
