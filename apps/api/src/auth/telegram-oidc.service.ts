import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { decryptSecret, encryptSecret, prisma } from '@clipforge/database';
import { env } from '../common/env';

const ISSUER = 'https://oauth.telegram.org';
const AUTHORIZATION_ENDPOINT = `${ISSUER}/auth`;
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_ENDPOINT = `${ISSUER}/.well-known/jwks.json`;
const TRANSACTION_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 60;

export interface TelegramOidcIdentity {
  id: string;
  name: string | null;
  username: string | null;
  picture: string | null;
}

interface TelegramJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface TelegramJwks {
  keys?: TelegramJwk[];
}

interface TelegramIdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  nonce?: unknown;
  sub?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  preferred_username?: unknown;
  picture?: unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

function boundedString(value: unknown, max = 160): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** Verify Telegram's signed ID token against an already fetched JWKS document. */
export function verifyTelegramIdToken(
  token: string,
  expected: { clientId: string; nonce: string },
  jwks: TelegramJwks,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramOidcIdentity {
  const rejected = () => new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in could not be verified. Start again and retry.' });
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw rejected();

  let header: { alg?: unknown; kid?: unknown };
  let claims: TelegramIdTokenClaims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    throw rejected();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw rejected();
  const key = jwks.keys?.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA' && (!candidate.use || candidate.use === 'sig') && (!candidate.alg || candidate.alg === 'RS256'));
  if (!key) throw rejected();

  let signature: Buffer;
  try {
    signature = Buffer.from(parts[2], 'base64url');
    const publicKey = createPublicKey({ key, format: 'jwk' });
    const signedContent = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    if (!verify('RSA-SHA256', signedContent, publicKey, signature)) throw rejected();
  } catch (error) {
    if (error instanceof UnauthorizedException) throw error;
    throw rejected();
  }

  const audienceMatches = typeof claims.aud === 'string'
    ? claims.aud === expected.clientId
    : Array.isArray(claims.aud) && claims.aud.includes(expected.clientId);
  const expiry = typeof claims.exp === 'number' ? claims.exp : NaN;
  const issuedAt = typeof claims.iat === 'number' ? claims.iat : NaN;
  const notBeforeValid = claims.nbf === undefined || (typeof claims.nbf === 'number' && claims.nbf <= nowSeconds + CLOCK_SKEW_SECONDS);
  const subject = typeof claims.sub === 'string' ? claims.sub : '';

  if (
    claims.iss !== ISSUER ||
    !audienceMatches ||
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== expected.clientId) ||
    (claims.azp !== undefined && claims.azp !== expected.clientId) ||
    !Number.isFinite(expiry) || expiry <= nowSeconds - CLOCK_SKEW_SECONDS ||
    !Number.isFinite(issuedAt) || issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
    !notBeforeValid ||
    claims.nonce !== expected.nonce ||
    !/^\d{1,20}$/.test(subject) || BigInt(subject) <= 0n
  ) {
    throw rejected();
  }

  const composedName = [boundedString(claims.given_name, 80), boundedString(claims.family_name, 80)].filter(Boolean).join(' ');
  const picture = boundedString(claims.picture, 2048);
  let safePicture: string | null = null;
  if (picture) {
    try {
      const url = new URL(picture);
      if (url.protocol === 'https:' && (url.hostname === 'telesco.pe' || url.hostname.endsWith('.telesco.pe'))) safePicture = url.toString();
    } catch {
      // A profile photo is optional and never affects whether the identity is trusted.
    }
  }

  return {
    id: subject,
    name: boundedString(claims.name) ?? (composedName || null),
    username: boundedString(claims.preferred_username, 64),
    picture: safePicture,
  };
}

@Injectable()
export class TelegramOidcService {
  private jwksCache: { expiresAt: number; value: TelegramJwks } | null = null;

  get configured(): boolean {
    return Boolean(env.TELEGRAM_LOGIN_CLIENT_ID && env.TELEGRAM_LOGIN_CLIENT_SECRET);
  }

  get callbackUri(): string {
    return env.TELEGRAM_LOGIN_REDIRECT_URI ?? new URL('/api/auth/telegram/callback', env.APP_URL).toString();
  }

  async authorizationUrl(): Promise<{ url: string; state: string }> {
    if (!this.configured) {
      throw new ServiceUnavailableException({ code: 'TELEGRAM_LOGIN_NOT_CONFIGURED', message: 'Telegram Login is not configured on this deployment.' });
    }

    const now = new Date();
    void prisma.telegramOidcTransaction.deleteMany({ where: { expiresAt: { lt: now } } }).catch(() => undefined);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    // Do not return until the transaction exists. The verifier is encrypted with the same
    // AES-256-GCM key already used for OAuth credentials elsewhere in this application.
    return this.createTransactionAndUrl({ state, nonce, verifier, challenge, now });
  }

  private async createTransactionAndUrl(input: { state: string; nonce: string; verifier: string; challenge: string; now: Date }): Promise<{ url: string; state: string }> {
    await prisma.telegramOidcTransaction.create({
      data: {
        stateHash: sha256(input.state),
        nonce: input.nonce,
        codeVerifier: { ...encryptSecret(input.verifier) },
        expiresAt: new Date(input.now.getTime() + TRANSACTION_TTL_MS),
      },
    });

    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', env.TELEGRAM_LOGIN_CLIENT_ID as string);
    url.searchParams.set('redirect_uri', this.callbackUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state: input.state };
  }

  async discardTransaction(state: string | undefined): Promise<void> {
    if (!state || state.length > 256) return;
    await prisma.telegramOidcTransaction.updateMany({
      where: { stateHash: sha256(state), consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    }).catch(() => undefined);
  }

  async completeLogin(code: string, state: string): Promise<TelegramOidcIdentity> {
    if (!this.configured) {
      throw new ServiceUnavailableException({ code: 'TELEGRAM_LOGIN_NOT_CONFIGURED', message: 'Telegram Login is not configured on this deployment.' });
    }
    if (!code || code.length > 4096 || !state || state.length > 256) {
      throw new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in could not be verified. Start again and retry.' });
    }

    const now = new Date();
    const stateHash = sha256(state);
    const transaction = await prisma.telegramOidcTransaction.findUnique({ where: { stateHash } });
    if (!transaction || transaction.consumedAt || transaction.expiresAt <= now) {
      throw new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in expired. Start again and retry.' });
    }
    const consumed = await prisma.telegramOidcTransaction.updateMany({
      where: { id: transaction.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in has already been used. Start again and retry.' });
    }

    const verifier = decryptSecret(transaction.codeVerifier);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUri,
      client_id: env.TELEGRAM_LOGIN_CLIENT_ID as string,
      code_verifier: verifier,
    });
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${env.TELEGRAM_LOGIN_CLIENT_ID}:${env.TELEGRAM_LOGIN_CLIENT_SECRET}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in could not be completed. Start again and retry.' });
    }
    if (!tokenResponse.ok) {
      throw new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in was rejected. Start again and retry.' });
    }

    let idToken: unknown;
    try {
      idToken = (await tokenResponse.json() as { id_token?: unknown }).id_token;
    } catch {
      throw new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in returned an invalid response.' });
    }
    if (typeof idToken !== 'string') {
      throw new UnauthorizedException({ code: 'TELEGRAM_LOGIN_REJECTED', message: 'Telegram sign-in returned no identity token.' });
    }

    let jwks = await this.getJwks();
    let kid: unknown;
    try {
      kid = decodePart<{ kid?: unknown }>(idToken.split('.')[0]).kid;
    } catch {
      // The verifier below returns the same generic rejection for malformed JWTs.
    }
    if (typeof kid === 'string' && !jwks.keys?.some((key) => key.kid === kid)) jwks = await this.getJwks(true);
    return verifyTelegramIdToken(idToken, { clientId: env.TELEGRAM_LOGIN_CLIENT_ID as string, nonce: transaction.nonce }, jwks);
  }

  private async getJwks(forceRefresh = false): Promise<TelegramJwks> {
    if (!forceRefresh && this.jwksCache && this.jwksCache.expiresAt > Date.now()) return this.jwksCache.value;
    let response: Response;
    try {
      response = await fetch(JWKS_ENDPOINT, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new ServiceUnavailableException({ code: 'TELEGRAM_KEYS_UNAVAILABLE', message: 'Telegram verification keys are temporarily unavailable. Retry sign-in.' });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({ code: 'TELEGRAM_KEYS_UNAVAILABLE', message: 'Telegram verification keys are temporarily unavailable. Retry sign-in.' });
    }
    let jwks: TelegramJwks;
    try {
      jwks = await response.json() as TelegramJwks;
    } catch {
      throw new ServiceUnavailableException({ code: 'TELEGRAM_KEYS_UNAVAILABLE', message: 'Telegram verification keys could not be read. Retry sign-in.' });
    }
    if (!Array.isArray(jwks.keys)) {
      throw new ServiceUnavailableException({ code: 'TELEGRAM_KEYS_UNAVAILABLE', message: 'Telegram verification keys could not be read. Retry sign-in.' });
    }
    this.jwksCache = { value: jwks, expiresAt: Date.now() + 10 * 60_000 };
    return jwks;
  }
}
