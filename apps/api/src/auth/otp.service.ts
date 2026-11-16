/**
 * One-time codes for login step-up, password reset and Telegram linking.
 *
 * The rules are the feature, so they live here rather than in the controller:
 *
 *  - **Six digits, cryptographically random.** `crypto.randomInt(0, 1_000_000)` — uniform, not
 *    `Math.random()`, and modulo bias is avoided by the API rather than by hand.
 *  - **Five-minute expiry**, checked against `expiresAt` in the database, not in memory.
 *  - **Separate codes per channel.** A dual-OTP login creates one EMAIL and one TELEGRAM challenge;
 *    the session is created only when *both* verify.
 *  - **Five attempts**, then the challenge is dead — an attacker cannot walk the 10^6 space.
 *  - **Sixty-second resend cooldown**, enforced from `sentAt`, so a code cannot be farmed.
 *  - **Hashed at rest.** HMAC-SHA256 over `<challengeId>:<code>` with a server-side secret: the
 *    challenge id salts it, so identical codes for different challenges have different hashes and a
 *    stolen table cannot be reversed without the secret.
 *  - **Single use.** `consumedAt` is set inside the same transaction that verifies, so a replayed
 *    code cannot succeed twice even under concurrency.
 */
import { BadRequestException, HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '@clipforge/database';
import { EmailService, maskAddress } from '../common/services/email.service';
import { TelegramClient } from '../notifications/telegram.client';
import { env } from '../common/env';

export const OTP_TELEGRAM_CLIENT = 'CLIPFORGE_OTP_TELEGRAM_CLIENT';

export type OtpChannelName = 'EMAIL' | 'TELEGRAM';
export type OtpPurposeName = 'LOGIN' | 'PASSWORD_RESET' | 'TELEGRAM_LINK' | 'SESSION_REVOCATION';

export interface OtpChallengeView {
  challengeId: string;
  channel: OtpChannelName;
  /** Where the code went, masked. Never the code itself. */
  destination: string;
  expiresAt: string;
  attemptsRemaining: number;
}

export type OtpFailure =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'CONSUMED'
  | 'TOO_MANY_ATTEMPTS'
  | 'MISMATCH'
  | 'COOLDOWN';

export interface OtpDelivery {
  challengeId: string;
  channel: OtpChannelName;
  destination: string;
  delivered: boolean;
  error: string | null;
}

const CODE_PATTERN = /^\d{6}$/;

@Injectable()
export class OtpService {
  private readonly logger = new Logger('Otp');

  /**
   * `EmailService` is a registered provider. The Telegram client is looked up through an optional
   * token so tests can inject a stub and production simply builds one from the environment — the
   * constructor never resolves a bare class, which Nest cannot do.
   */
  constructor(
    private readonly email: EmailService,
    @Optional() @Inject(OTP_TELEGRAM_CLIENT) private readonly telegram: TelegramClient | null = null,
  ) {}

  private static secret(): string {
    // Derived from SESSION_SECRET so no new required variable appears in existing deployments;
    // a dedicated OTP_SECRET wins when an operator wants separate rotation.
    const secret = process.env.OTP_SECRET?.trim() || process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) throw new Error('OTP requires a configured secret of at least 32 characters');
    return secret;
  }

  static hashCode(challengeId: string, code: string): string {
    return createHmac('sha256', OtpService.secret()).update(`${challengeId}:${code}`).digest('hex');
  }

  static verifyHash(challengeId: string, code: string, expectedHex: string): boolean {
    const actual = Buffer.from(OtpService.hashCode(challengeId, code), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    if (actual.length !== expected.length) return false;
    // Constant-time: a timing oracle on an OTP check is a real attack, not a theoretical one.
    return timingSafeEqual(actual, expected);
  }

  /** Uniform six-digit code. */
  static generateCode(): number {
    return randomInt(0, 1_000_000);
  }

  static formatCode(code: number): string {
    return code.toString().padStart(6, '0');
  }

  get ttlSeconds(): number {
    return Number(process.env.OTP_TTL_SECONDS ?? 300);
  }

  get cooldownSeconds(): number {
    return Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 60);
  }

  get maxAttempts(): number {
    return Number(process.env.OTP_MAX_ATTEMPTS ?? 5);
  }

  /** Both channels are "available" only if something can actually deliver them. */
  channelsAvailable(user: { telegramChatId: string | null; telegramUserId?: string | null; telegramLinkedAt?: Date | null }): { email: boolean; telegram: boolean } {
    return {
      email: this.email.configured,
      telegram: Boolean(user.telegramChatId && user.telegramUserId && user.telegramLinkedAt && (this.telegram ?? this.defaultTelegram())),
    };
  }

  private defaultTelegram(): TelegramClient | null {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return null;
    return new TelegramClient({
      token,
      baseUrl: env.TELEGRAM_API_BASE,
      timeoutMs: env.TELEGRAM_TIMEOUT_MS,
      maxAttempts: 1, // an OTP is time-critical: one attempt, the user can ask again
    });
  }

  /**
   * Creates and delivers a challenge. Returns the challenge id and whether delivery worked; the code
   * itself is only ever inside the delivered message.
   */
  async issue(input: {
    userId: string;
    email: string;
    telegramChatId?: string | null;
    purpose: OtpPurposeName;
    channel: OtpChannelName;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<OtpDelivery> {
    // Recheck the persisted bot activation, never just a caller-supplied chat ID.
    if (input.channel === 'TELEGRAM') {
      const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { telegramChatId: true, telegramUserId: true, telegramLinkedAt: true } });
      if (!user?.telegramUserId || !user.telegramLinkedAt || !user.telegramChatId || user.telegramChatId !== input.telegramChatId) {
        throw new BadRequestException({ code: 'TELEGRAM_NOT_CONNECTED', message: 'Connect Telegram through the bot before requesting a code.' });
      }
    }
    const code = OtpService.formatCode(OtpService.generateCode());
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const challenge = await prisma.$transaction(async (tx) => {
      // Serialize issuance per user, including concurrent resend requests.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${input.userId}::uuid FOR UPDATE`;
      const recent = await tx.otpChallenge.findFirst({
        where: { userId: input.userId, purpose: input.purpose, channel: input.channel },
        orderBy: { sentAt: 'desc' },
      });
      if (recent && Date.now() - recent.sentAt.getTime() < this.cooldownSeconds * 1000) return null;
      await tx.otpChallenge.updateMany({
        where: { userId: input.userId, purpose: input.purpose, channel: input.channel, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      const id = randomUUID();
      return tx.otpChallenge.create({ data: {
        id, userId: input.userId, purpose: input.purpose, channel: input.channel,
        codeHash: OtpService.hashCode(id, code), expiresAt, maxAttempts: this.maxAttempts,
        ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null,
      } });
    });
    if (!challenge) throw new HttpException({ code: 'OTP_COOLDOWN', message: 'Wait before requesting another code.' }, 429);

    const delivery = await this.deliver(input, code, expiresAt);
    if (!delivery.delivered) {
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { deliveryError: delivery.error?.slice(0, 500) ?? 'unknown delivery error' },
      });
    }
    return { ...delivery, challengeId: challenge.id };
  }

  private async deliver(
    input: { channel: OtpChannelName; email: string; telegramChatId?: string | null; purpose: OtpPurposeName },
    code: string,
    expiresAt: Date,
  ): Promise<Omit<OtpDelivery, 'challengeId'> & { challengeId?: string }> {
    const minutes = Math.round(this.ttlSeconds / 60);
    const purposeText =
      input.purpose === 'SESSION_REVOCATION'
        ? 'revoke all ClipForge sessions'
        : input.purpose === 'LOGIN'
        ? 'sign in to ClipForge'
        : input.purpose === 'PASSWORD_RESET'
          ? 'reset your ClipForge password'
          : 'link this Telegram account to ClipForge';
    const expiry = expiresAt.toISOString().replace('T', ' ').slice(0, 16);

    if (input.channel === 'EMAIL') {
      const destination = maskAddress(input.email);
      const result = await this.email.send({
        to: input.email,
        subject: `ClipForge verification code: ${code}`,
        text: [
          `Your ClipForge verification code is ${code}.`,
          '',
          `Use it to ${purposeText}. It expires at ${expiry} UTC (${minutes} minutes from now).`,
          'If you did not request this, ignore this email and change your password.',
        ].join('\n'),
        html: `<p>Your ClipForge verification code is <strong style="font-size:20px;letter-spacing:3px">${code}</strong>.</p>
<p>Use it to ${purposeText}. It expires at ${expiry} UTC (${minutes} minutes from now).</p>
<p style="color:#666">If you did not request this, ignore this email and change your password.</p>`,
      });
      return { channel: 'EMAIL', destination, delivered: result.delivered, error: result.error };
    }

    const chatId = input.telegramChatId ?? '';
    const destination = maskTelegram(chatId);
    const client = this.telegram ?? this.defaultTelegram();
    if (!client) {
      return { channel: 'TELEGRAM', destination, delivered: false, error: 'Telegram is not configured on the API (TELEGRAM_BOT_TOKEN)' };
    }
    if (!chatId) {
      return { channel: 'TELEGRAM', destination, delivered: false, error: 'No Telegram chat linked to this account' };
    }
    const result = await client.sendMessage(
      chatId,
      `🔐 <b>ClipForge verification code</b>\n<code>${code}</code>\n\nUse it to ${purposeText}. Expires ${expiry} UTC (${minutes} min).\n<i>Not you? Do not share this code. Review your active sessions in ClipForge.</i>`,
    );
    return { channel: 'TELEGRAM', destination, delivered: result.delivered, error: result.error };
  }

  /**
   * Verifies one code. Returns `null` on success and a failure reason otherwise.
   * A wrong attempt increments the counter *before* returning, so a crash cannot refund attempts.
   */
  async verify(challengeId: string, code: string): Promise<{ ok: true } | { ok: false; reason: OtpFailure; attemptsRemaining: number }> {
    return this.verifyMany([{ challengeId, code }]);
  }

  /** All required channels verify together; a failed code never consumes a correct sibling. */
  async verifyMany(inputs: Array<{ challengeId: string; code: string }>): Promise<{ ok: true } | { ok: false; reason: OtpFailure; attemptsRemaining: number }> {
    const ids = inputs.map((input) => input.challengeId);
    if (!ids.length || ids.length > 2 || new Set(ids).size !== ids.length || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return { ok: false, reason: 'NOT_FOUND', attemptsRemaining: 0 };
    return prisma.$transaction(async (tx): Promise<{ ok: true } | { ok: false; reason: OtpFailure; attemptsRemaining: number }> => {
      // Consistent lock order prevents dual-channel verification deadlocks.
      for (const id of [...ids].sort()) await tx.$queryRaw`SELECT id FROM "OtpChallenge" WHERE id = ${id}::uuid FOR UPDATE`;
      for (const { challengeId, code } of inputs) {
        const challenge = await tx.otpChallenge.findUnique({ where: { id: challengeId } });
        if (!challenge) return { ok: false, reason: 'NOT_FOUND', attemptsRemaining: 0 };
        if (challenge.consumedAt) return { ok: false, reason: 'CONSUMED', attemptsRemaining: 0 };
        if (challenge.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'EXPIRED', attemptsRemaining: 0 };
        if (challenge.attempts >= challenge.maxAttempts) return { ok: false, reason: 'TOO_MANY_ATTEMPTS', attemptsRemaining: 0 };
        if (!CODE_PATTERN.test(code) || !OtpService.verifyHash(challenge.id, code, challenge.codeHash)) {
          const updated = await tx.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
          return { ok: false, reason: 'MISMATCH', attemptsRemaining: Math.max(0, challenge.maxAttempts - updated.attempts) };
        }
      }
      // Every row is still locked and verified. Consume the whole set in one update.
      await tx.otpChallenge.updateMany({ where: { id: { in: ids } }, data: { consumedAt: new Date() } });
      return { ok: true };
    });
  }

  /** Consumes every live challenge of a purpose (used once a multi-channel step has succeeded). */
  async consumeAll(userId: string, purpose: OtpPurposeName): Promise<void> {
    await prisma.otpChallenge.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /** Housekeeping: drop expired codes so the table cannot grow without bound. */
  async purgeExpired(): Promise<number> {
    const result = await prisma.otpChallenge.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } });
    return result.count;
  }

  toView(challenge: { id: string; channel: string; expiresAt: Date; attempts: number; maxAttempts: number }, destination: string): OtpChallengeView {
    return {
      challengeId: challenge.id,
      channel: challenge.channel as OtpChannelName,
      destination,
      expiresAt: challenge.expiresAt.toISOString(),
      attemptsRemaining: Math.max(0, challenge.maxAttempts - challenge.attempts),
    };
  }
}

/** `-1001234567890` → `-••••7890`, same rule as the notification surface. */
export function maskTelegram(chatId?: string | null): string {
  if (!chatId) return 'not linked';
  if (chatId.startsWith('@')) return chatId;
  const digits = chatId.replace('-', '');
  return `${chatId.startsWith('-') ? '-' : ''}••••${digits.slice(-4)}`;
}
