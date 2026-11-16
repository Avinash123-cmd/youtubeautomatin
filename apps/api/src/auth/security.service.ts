/**
 * Account security: second-factor login, password reset, sessions/devices, login history,
 * recovery codes and suspicious-login alerts.
 *
 * Kept apart from `AuthService` (which owns password/Firebase verification and session issuing) so
 * that the rules about *when a session may exist* live in one readable place:
 *
 *   password verified
 *     └─ user.otpMode === OFF ──────────────────────────► session (unchanged behaviour)
 *     └─ EMAIL / TELEGRAM / DUAL ─► N challenges ─► all N verified ─► session
 *
 * No code path creates a session before every required challenge has been consumed.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { prisma, appendAuditLog } from '@clipforge/database';
import type { OtpChannel, OtpMode, OtpPurpose } from '@prisma/client';
import { OtpService, maskTelegram, type OtpChallengeView } from './otp.service';
import { SessionService } from './session.service';
import { PASSWORD_HASH_OPTIONS } from './password-hash';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService, maskAddress } from '../common/services/email.service';

export interface StepUpPayload {
  otpRequired: true;
  mode: OtpMode;
  /** One entry per required channel; the session needs a code for every challenge id. */
  challenges: OtpChallengeView[];
  /** Seconds until a resend is allowed. */
  resendAfterSeconds: number;
  /** True when a required channel could not deliver — the UI must say so instead of hanging. */
  deliveryProblem: { channel: string; error: string } | null;
}

const RECOVERY_CODE_COUNT = 10;
const SUSPICIOUS_WINDOW_DAYS = 30;

@Injectable()
export class SecurityService {
  private readonly logger = new Logger('Security');

  constructor(
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  // ------------------------------------------------------------------ login step-up

  /** Which channels this user must pass, given their policy and what can actually deliver. */
  requiredChannels(mode: OtpMode): OtpChannel[] {
    if (mode === 'DUAL') return ['EMAIL', 'TELEGRAM'];
    if (mode === 'EMAIL') return ['EMAIL'];
    if (mode === 'TELEGRAM') return ['TELEGRAM'];
    return [];
  }

  /**
   * Starts the second factor for a password-verified user. Returns `null` when the user has no OTP
   * policy, which is how the existing password-only flow keeps working byte-for-byte.
   */
  async beginStepUp(
    user: { id: string; email: string; otpMode: OtpMode; telegramChatId: string | null },
    request: Request,
    method: 'PASSWORD' | 'FIREBASE' | 'TELEGRAM' = 'PASSWORD',
  ): Promise<StepUpPayload | null> {
    const channels = this.requiredChannels(user.otpMode);
    if (channels.length === 0) return null;

    const challenges: OtpChallengeView[] = [];
    let deliveryProblem: { channel: string; error: string } | null = null;

    for (const channel of channels) {
      const delivery = await this.otp.issue({
        userId: user.id,
        email: user.email,
        telegramChatId: user.telegramChatId,
        purpose: 'LOGIN',
        channel,
        ipAddress: request.ip ?? null,
        userAgent: request.get('user-agent') ?? null,
      });
      challenges.push({
        challengeId: delivery.challengeId,
        channel: delivery.channel,
        destination: delivery.destination,
        // The TTL is a policy constant; re-reading it keeps the UI honest if it is tuned.
        expiresAt: new Date(Date.now() + this.otp.ttlSeconds * 1000).toISOString(),
        attemptsRemaining: this.otp.maxAttempts,
      });
      if (!delivery.delivered) {
        deliveryProblem = { channel: delivery.channel, error: delivery.error ?? 'delivery failed' };
      }
    }

    await this.recordLogin(user.id, 'OTP_CHALLENGE', method, request, {
      detail: `second factor required (${user.otpMode})`,
    });
    return {
      otpRequired: true,
      mode: user.otpMode,
      challenges,
      resendAfterSeconds: this.otp.cooldownSeconds,
      deliveryProblem,
    };
  }

  /**
   * Verifies every required challenge and only then creates the session.
   * A failure consumes none of the supplied challenges; wrong guesses still count toward limits.
   */
  async completeStepUp(
    input: { challengeIds: string[]; codes: string[] },
    request: Request,
  ): Promise<{ rawToken: string; csrfToken: string; workspaceId: string; userId: string }> {
    if (input.challengeIds.length !== input.codes.length || input.challengeIds.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Provide one code per challenge' });
    }
    const challenges = await prisma.otpChallenge.findMany({
      where: { id: { in: input.challengeIds } },
      select: { id: true, userId: true, purpose: true, channel: true },
    });
    if (challenges.length !== input.challengeIds.length) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Unknown verification challenge' });
    }
    const userIds = new Set(challenges.map((c) => c.userId));
    if (userIds.size !== 1) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Challenges belong to different accounts' });
    }
    const userId = challenges[0].userId;
    if (challenges.some((c) => c.purpose !== 'LOGIN')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'That challenge is not a login challenge' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This account is not active' });
    }
    const required = this.requiredChannels(user.otpMode);
    const submitted = new Set(challenges.map((challenge) => challenge.channel));
    if (!required.length || submitted.size !== challenges.length || required.length !== challenges.length || required.some((channel) => !submitted.has(channel))) {
      throw new UnauthorizedException({ code: 'OTP_POLICY_MISMATCH', message: 'Provide every code required by your current security policy. Start sign-in again.' });
    }
    const result = await this.otp.verifyMany(input.challengeIds.map((challengeId, index) => ({ challengeId, code: input.codes[index] })));
    if (!result.ok) {
      await this.recordLogin(userId, 'OTP_FAILED', 'OTP', request, { detail: result.reason });
      throw new UnauthorizedException({ code: 'OTP_INVALID', message: 'Verification failed. Check every code or restart sign-in if expired.', details: { reason: result.reason, attemptsRemaining: result.attemptsRemaining } });
    }

    const suspicious = await this.isSuspicious(userId, request);
    const session = await this.issueSessionFor(userId, request);
    await this.recordLogin(userId, 'SUCCESS', 'OTP', request, { suspicious, detail: `second factor (${user.otpMode})` });
    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null } });
    await appendAuditLog({
      workspaceId: session.workspaceId,
      userId,
      action: 'AUTH_LOGIN',
      summary: `Login with ${user.otpMode} second factor from ${request.ip ?? 'unknown ip'}`,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    if (suspicious) await this.alertSuspiciousLogin(user, request);
    return session;
  }

  /** Resends the code for one existing challenge (same channel, same purpose). */
  async resend(challengeId: string, request: Request): Promise<OtpChallengeView> {
    const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
    if (!challenge) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown verification challenge' });
    if (challenge.consumedAt) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'That challenge is already complete' });
    const delivery = await this.otp.issue({
      userId: challenge.userId,
      email: challenge.user.email,
      telegramChatId: challenge.user.telegramChatId,
      purpose: challenge.purpose as OtpPurposeNameLocal,
      channel: challenge.channel as OtpChannel,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    if (!delivery.delivered) {
      throw new BadRequestException({ code: 'OTP_DELIVERY_FAILED', message: delivery.error ?? 'Could not deliver the code' });
    }
    return {
      challengeId: delivery.challengeId,
      channel: delivery.channel,
      destination: delivery.destination,
      expiresAt: new Date(Date.now() + this.otp.ttlSeconds * 1000).toISOString(),
      attemptsRemaining: this.otp.maxAttempts,
    };
  }

  // ------------------------------------------------------------------ password reset

  /**
   * Starts a reset. The response is identical whether or not the address exists: a reset form that
   * reveals account existence is an enumeration oracle.
   */
  async forgotPassword(email: string, request: Request): Promise<{ requested: true }> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // One response shape for every input: an unknown address must be indistinguishable from a real
    // one, otherwise this endpoint is an account-enumeration oracle. The caller learns whether mail
    // arrived, not whether the account exists.
    if (!user || user.deletedAt || user.status !== 'ACTIVE') return { requested: true };
    // Prefer the channel the user will actually read; fall back to email when Telegram is unlinked.
    const channel: OtpChannel = user.otpMode === 'TELEGRAM' && user.telegramChatId && user.telegramUserId && user.telegramLinkedAt ? 'TELEGRAM' : 'EMAIL';
    const delivery = await this.otp.issue({
      userId: user.id,
      email: user.email,
      telegramChatId: user.telegramChatId,
      purpose: 'PASSWORD_RESET',
      channel,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    }).catch(() => {
      // Do not disclose existing accounts via cooldown/configuration/delivery errors.
      this.logger.warn('Password recovery delivery could not be completed');
      return { delivered: false };
    });
    await appendAuditLog({
      userId: user.id,
      action: 'AUTH_PASSWORD_RESET_REQUESTED',
      summary: `Password reset requested via ${channel} (delivered: ${delivery.delivered})`,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    }).catch(() => undefined);
    return { requested: true };
  }

  /**
   * Completes a reset. The address identifies the challenge — the reset form carries the code the
   * user was sent, not an opaque id, so a leaked challenge list cannot be walked and the endpoint
   * stays out of the enumeration business.
   */
  async resetPassword(
    input: { email: string; code: string; newPassword: string },
    request: Request,
  ): Promise<{ reset: true; sessionsRevoked: number }> {
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
    const rejection = new UnauthorizedException({
      code: 'OTP_INVALID',
      message: 'That code is not valid. Request a new one.',
    });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') throw rejection;

    const challenge = await prisma.otpChallenge.findFirst({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { sentAt: 'desc' },
      select: { id: true },
    });
    if (!challenge) throw rejection;

    const result = await this.otp.verify(challenge.id, input.code);
    if (!result.ok) {
      throw new UnauthorizedException({
        code: 'OTP_INVALID',
        message: `Code rejected (${result.reason})`,
        attemptsRemaining: result.attemptsRemaining,
      });
    }

    const passwordHash = await argon2.hash(input.newPassword, PASSWORD_HASH_OPTIONS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    const before = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    // A reset means "the old credential is gone": every device signed in with it goes too, including
    // an attacker's session that is already open.
    await this.sessions.revokeAllForUser(user.id);
    await appendAuditLog({
      userId: user.id,
      action: 'AUTH_PASSWORD_RESET',
      summary: `Password reset completed; ${before} session(s) revoked`,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    }).catch(() => undefined);
    void this.notifications;
    return { reset: true, sessionsRevoked: before };
  }

  // ------------------------------------------------------------------ sessions / devices

  async listSessions(userId: string, currentSessionId: string) {
    const rows = await prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true, deviceLabel: true },
    });
    return rows.map((row) => ({
      id: row.id,
      device: row.deviceLabel ?? describeDevice(row.userAgent),
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      current: row.id === currentSessionId,
    }));
  }

  /** Revoking another device is allowed; revoking the current one is what "log out" is for. */
  async revokeSession(userId: string, sessionId: string, currentSessionId: string) {
    const row = await prisma.session.findFirst({ where: { id: sessionId, userId } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Session not found' });
    await this.sessions.revoke(sessionId);
    return { revoked: true, wasCurrent: sessionId === currentSessionId };
  }

  async revokeAll(userId: string, currentSessionId: string | null, keepCurrent: boolean) {
    const result = await prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(keepCurrent && currentSessionId ? { id: { not: currentSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  }

  async loginHistory(userId: string, limit = 20) {
    const rows = await prisma.loginEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) });
    return rows.map((row) => ({
      id: row.id,
      outcome: row.outcome,
      method: row.method,
      device: row.deviceLabel ?? describeDevice(row.userAgent),
      ipAddress: row.ipAddress,
      suspicious: row.suspicious,
      detail: row.detail,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ------------------------------------------------------------------ recovery codes

  /** Ten single-use codes, shown once. Only their hashes are stored. */
  async generateRecoveryCodes(userId: string): Promise<{ codes: string[]; remaining: number }> {
    const codes: string[] = [];
    const data = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
      const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
      codes.push(code);
      return { userId, codeHash: hashRecoveryCode(code) };
    });
    await prisma.$transaction([
      // Regenerating invalidates the previous set: two live sets would double the attack surface.
      prisma.recoveryCode.deleteMany({ where: { userId, usedAt: null } }),
      prisma.recoveryCode.createMany({ data }),
    ]);
    return { codes, remaining: codes.length };
  }

  async recoveryCodeStatus(userId: string) {
    const [remaining, total] = await Promise.all([
      prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
      prisma.recoveryCode.count({ where: { userId } }),
    ]);
    return { remaining, total };
  }

  /**
   * Uses one recovery code to set a new password and revoke every session. This is the way back in
   * when both the password and the OTP channel are lost.
   */
  async redeemRecoveryCode(input: { email: string; code: string; newPassword: string }, request: Request) {
    const invalid = new UnauthorizedException({ code: 'RECOVERY_CODE_INVALID', message: 'That recovery code is not valid or has already been used' });
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') throw invalid;
    const hash = hashRecoveryCode(input.code);
    const record = await prisma.recoveryCode.findFirst({ where: { userId: user.id, codeHash: hash, usedAt: null } });
    if (!record) {
      await this.recordLogin(user.id, 'FAILED_PASSWORD', 'RECOVERY_CODE', request, { detail: 'invalid recovery code' });
      throw invalid;
    }
    const consumed = await prisma.recoveryCode.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count === 0) throw invalid;
    const passwordHash = await argon2.hash(input.newPassword, PASSWORD_HASH_OPTIONS);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } });
    await this.sessions.revokeAllForUser(user.id);
    await this.recordLogin(user.id, 'SUCCESS', 'RECOVERY_CODE', request, { detail: 'password reset with recovery code' });
    await appendAuditLog({
      userId: user.id,
      action: 'AUTH_PASSWORD_RESET' as never,
      summary: 'Password reset with a recovery code; all sessions revoked',
      ipAddress: request.ip ?? null,
    }).catch(() => undefined);
    const status = await this.recoveryCodeStatus(user.id);
    return { reset: true, remaining: status.remaining };
  }

  // ------------------------------------------------------------------ settings / linking

  async securityOverview(userId: string, currentSessionId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, otpMode: true, telegramChatId: true, telegramLinkedAt: true, telegramUsername: true, telegramUserId: true, emailVerified: true } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    const [sessions, recovery, available] = await Promise.all([
      this.listSessions(userId, currentSessionId),
      this.recoveryCodeStatus(userId),
      Promise.resolve(this.otp.channelsAvailable(user)),
    ]);
    return {
      email: user.email.endsWith('@users.telegram.invalid') ? 'Telegram account' : maskAddress(user.email),
      otpMode: user.otpMode,
      emailVerified: user.emailVerified,
      telegram: {
        linked: Boolean(user.telegramChatId && user.telegramUserId && user.telegramLinkedAt),
        connected: Boolean(user.telegramUserId),
        username: user.telegramUsername,
        chatId: user.telegramChatId ? maskTelegram(user.telegramChatId) : null,
        linkedAt: user.telegramLinkedAt?.toISOString() ?? null,
      },
      channels: available,
      sessions,
      recoveryCodes: recovery,
      policies: { otpTtlSeconds: this.otp.ttlSeconds, resendCooldownSeconds: this.otp.cooldownSeconds, maxAttempts: this.otp.maxAttempts },
    };
  }

  /**
   * Changes the second-factor policy. Enabling a channel that cannot deliver is refused with the
   * reason, because a half-configured factor locks the user out of their own account.
   */
  async setOtpMode(userId: string, mode: OtpMode) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, telegramChatId: true, telegramUserId: true, telegramLinkedAt: true } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    const available = this.otp.channelsAvailable(user);
    if ((mode === 'EMAIL' || mode === 'DUAL') && !available.email) {
      throw new BadRequestException({ code: 'CHANNEL_UNAVAILABLE', message: 'Email is not configured on this deployment (SMTP_HOST/SMTP_FROM), so email OTP cannot be enabled.' });
    }
    if ((mode === 'EMAIL' || mode === 'DUAL') && user.email.endsWith('@users.telegram.invalid')) {
      throw new BadRequestException({ code: 'CHANNEL_UNAVAILABLE', message: 'Email OTP is unavailable for this Telegram-only account because it has no email address. Use Telegram OTP instead.' });
    }
    if ((mode === 'TELEGRAM' || mode === 'DUAL') && !available.telegram) {
      throw new BadRequestException({ code: 'CHANNEL_UNAVAILABLE', message: 'Link a Telegram chat before enabling Telegram OTP.' });
    }
    await prisma.user.update({ where: { id: userId }, data: { otpMode: mode } });
    await appendAuditLog({ userId, action: 'CONFIG_CHANGED', summary: `OTP mode set to ${mode}` }).catch(() => undefined);
    return { otpMode: mode };
  }

  /** Step 1 of linking: send a code to the chat the user claims to own. */
  async startTelegramLink(userId: string, chatId: string, request: Request) {
    throw new BadRequestException({ code: 'TELEGRAM_BOT_LINK_REQUIRED', message: 'Use Connect Telegram and start the bot with the one-time link. Manual chat-ID linking is no longer supported.' });
  }

  async completeTelegramLink(userId: string, challengeId: string, code: string, chatId: string) {
    throw new BadRequestException({ code: 'TELEGRAM_BOT_LINK_REQUIRED', message: 'Use Connect Telegram and start the bot with the one-time link.' });
  }

  async unlinkTelegram(userId: string) {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { otpMode: true } });
      if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
      // Unlinking while Telegram is a required factor would lock the account out.
      const otpMode = user.otpMode === 'TELEGRAM' ? 'OFF' : user.otpMode === 'DUAL' ? 'EMAIL' : user.otpMode;
      await tx.user.update({ where: { id: userId }, data: { otpMode, telegramChatId: null, telegramUserId: null, telegramUsername: null, telegramLinkedAt: null } });
      await tx.telegramConnectionToken.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: new Date() } });
    }, { isolationLevel: 'Serializable' });
    await appendAuditLog({ userId, action: 'AUTH_TELEGRAM_DISCONNECTED', summary: 'Telegram bot account disconnected from ClipForge settings' }).catch(() => undefined);
    return { linked: false };
  }

  // ------------------------------------------------------------------ helpers

  /** Same issuing path as the password login — one definition of a new session. */
  private async issueSessionFor(userId: string, request: Request) {
    const issued = await this.sessions.issue(userId, request);
    if (!issued) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'User has no workspace' });
    return issued;
  }

  async recordLogin(
    userId: string,
    outcome: 'SUCCESS' | 'FAILED_PASSWORD' | 'OTP_CHALLENGE' | 'OTP_FAILED' | 'BLOCKED',
    method: 'PASSWORD' | 'FIREBASE' | 'TELEGRAM' | 'OTP' | 'RECOVERY_CODE' | 'BOOTSTRAP',
    request: Request,
    extra: { suspicious?: boolean; detail?: string } = {},
  ): Promise<void> {
    await prisma.loginEvent
      .create({
        data: {
          userId,
          outcome,
          method,
          ipAddress: request.ip ?? null,
          userAgent: request.get('user-agent') ?? null,
          deviceLabel: describeDevice(request.get('user-agent') ?? null),
          suspicious: extra.suspicious ?? false,
          detail: extra.detail ?? null,
        },
      })
      .catch(() => undefined);
  }

  /**
   * A login is suspicious when this IP or this device has not been seen for the account in the last
   * 30 days. Deliberately simple and explainable: a heuristic nobody can reason about gets muted.
   */
  async isSuspicious(userId: string, request: Request): Promise<boolean> {
    const since = new Date(Date.now() - SUSPICIOUS_WINDOW_DAYS * 24 * 3600 * 1000);
    const ip = request.ip ?? '';
    const device = describeDevice(request.get('user-agent') ?? null);
    const history = await prisma.loginEvent.count({ where: { userId, outcome: 'SUCCESS', createdAt: { gte: since } } });
    // The first successful login is not "suspicious", it is the account being set up.
    if (history === 0) return false;
    const seen = await prisma.loginEvent.findFirst({
      where: { userId, outcome: 'SUCCESS', createdAt: { gte: since }, OR: [{ ipAddress: ip }, { deviceLabel: device }] },
      select: { id: true },
    });
    return seen === null;
  }

  /** Public wrapper used by the password and Firebase login paths. */
  async alertIfSuspicious(user: { id: string; email: string }, request: Request): Promise<void> {
    return this.alertSuspiciousLogin(user, request);
  }

  async alertSuspiciousLogin(user: { id: string; email: string }, request: Request): Promise<void> {
    const device = describeDevice(request.get('user-agent') ?? null);
    const membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, select: { workspaceId: true } });
    if (membership) {
      // The Telegram channel is already wired through the notification service, which handles
      // categories, dedupe and retries; a security alert is just another category.
      void this.notifications.notify({
        workspaceId: membership.workspaceId,
        category: 'SECURITY_ALERT',
        dedupeKey: `login:${user.id}:${new Date().toISOString().slice(0, 10)}:${device}`,
        summary: 'New device signed in to your ClipForge account',
        details: [
          ['Account', maskAddress(user.email)],
          ['Device', device],
          ['IP', request.ip ?? 'unknown'],
        ],
      });
    }
    void this.email.send({
      to: user.email,
      subject: 'New sign-in to your ClipForge account',
      text: [
        `A new device signed in to your ClipForge account.`,
        `Device: ${device}`,
        `IP: ${request.ip ?? 'unknown'}`,
        '',
        'If this was you, ignore this email. If not, reset your password and revoke your sessions from Settings → Security.',
      ].join('\n'),
    });
  }
}

type OtpPurposeNameLocal = 'LOGIN' | 'PASSWORD_RESET' | 'TELEGRAM_LINK';

function hashRecoveryCode(code: string): string {
  // Recovery codes are high-entropy (40 bits) so a fast hash is appropriate; the server secret still
  // prevents an offline table attack if the database leaks.
  const secret = process.env.OTP_SECRET?.trim() || process.env.SESSION_SECRET || 'clipforge-otp-dev-secret';
  return createHash('sha256').update(`${secret}:${code.trim().toUpperCase()}`).digest('hex');
}

/** Minimal, dependency-free user-agent labelling: "Firefox on Linux" beats a raw UA string. */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.toLowerCase();
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome') && !ua.includes('chromium')
      ? 'Chrome'
      : ua.includes('firefox')
        ? 'Firefox'
        : ua.includes('safari') && !ua.includes('chrome')
          ? 'Safari'
          : ua.includes('curl')
            ? 'curl'
            : ua.includes('python')
              ? 'Python client'
              : 'Browser';
  const platform = ua.includes('android')
    ? 'Android'
    : ua.includes('iphone') || ua.includes('ipad')
      ? 'iOS'
      : ua.includes('windows')
        ? 'Windows'
        : ua.includes('mac os')
          ? 'macOS'
          : ua.includes('linux')
            ? 'Linux'
            : '';
  return platform ? `${browser} on ${platform}` : browser;
}
