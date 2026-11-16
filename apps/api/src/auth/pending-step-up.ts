import type { Request, Response } from 'express';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '@clipforge/database';
import { env } from '../common/env';
import type { StepUpPayload } from './security.service';

const COOKIE = 'cf_pending_stepup';
const PATH = '/api/auth/security/otp';
const payloadSchema = z.object({
  purpose: z.literal('provider-step-up'),
  expiresAt: z.number(),
  stepUp: z.object({
    otpRequired: z.literal(true),
    mode: z.enum(['EMAIL', 'TELEGRAM', 'DUAL']),
    challenges: z.array(z.object({
      challengeId: z.string().uuid(), channel: z.enum(['EMAIL', 'TELEGRAM']),
      destination: z.string().max(256), expiresAt: z.string().datetime(), attemptsRemaining: z.number().int().min(0),
    })).min(1).max(2),
    resendAfterSeconds: z.number(),
    deliveryProblem: z.object({ channel: z.string(), error: z.string().max(512) }).nullable(),
  }),
});

/** Provider redirects carry no challenge data in URLs and never issue an authenticated session. */
export function setPendingStepUp(res: Response, stepUp: StepUpPayload): void {
  const expiresAt = Math.min(Date.now() + 5 * 60_000, ...stepUp.challenges.map((challenge) => Date.parse(challenge.expiresAt)));
  const payload = payloadSchema.parse({ purpose: 'provider-step-up', expiresAt, stepUp });
  const value = Buffer.from(JSON.stringify(encryptSecret(JSON.stringify(payload)))).toString('base64url');
  if (value.length > 3800) throw new Error('Pending verification payload is too large');
  res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: PATH, maxAge: Math.max(0, expiresAt - Date.now()) });
}

export function readPendingStepUp(req: Request): StepUpPayload | null {
  const value = req.cookies?.[COOKIE];
  if (typeof value !== 'string' || value.length > 3800) return null;
  try {
    const payload = payloadSchema.parse(JSON.parse(decryptSecret(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))));
    return payload.expiresAt > Date.now() ? payload.stepUp : null;
  } catch { return null; }
}

export function clearPendingStepUp(res: Response): void {
  res.clearCookie(COOKIE, { path: PATH, httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' });
}
