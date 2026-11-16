import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { readPendingStepUp, setPendingStepUp, clearPendingStepUp } from '../../apps/api/src/auth/pending-step-up';
import type { StepUpPayload } from '../../apps/api/src/auth/security.service';
vi.mock('../../apps/api/src/common/env', () => ({ env: { NODE_ENV: 'production' } }));
let cookies: Record<string, string>;
let res: Response;
const payload = (): StepUpPayload => ({ otpRequired: true, mode: 'TELEGRAM', challenges: [{ challengeId: '1b726681-2718-4545-8874-0758f0303f12', channel: 'TELEGRAM', destination: '••••1234', expiresAt: new Date(Date.now() + 300_000).toISOString(), attemptsRemaining: 5 }], resendAfterSeconds: 60, deliveryProblem: null });
beforeEach(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  cookies = {};
  res = { cookie: vi.fn((key, value) => { cookies[key] = value; }), clearCookie: vi.fn() } as unknown as Response;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const req = () => ({ cookies }) as Request;
describe('provider step-up handoff cookie', () => {
  it('round-trips encrypted pending state without issuing a session', () => {
    const input = payload();
    setPendingStepUp(res, input);
    expect(readPendingStepUp(req())).toEqual(input);
    expect(Object.keys(cookies)).toEqual(['cf_pending_stepup']);
    expect(cookies.cf_pending_stepup).not.toContain(input.challenges[0].challengeId);
    expect(res.cookie).toHaveBeenCalledWith('cf_pending_stepup', expect.any(String), expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/security/otp' }));
  });
  it('rejects tampered state and malformed cookies', () => {
    setPendingStepUp(res, payload());
    cookies.cf_pending_stepup = cookies.cf_pending_stepup.slice(0, -12) + 'AAAAAAAAAAAA';
    expect(readPendingStepUp(req())).toBeNull();
    cookies.cf_pending_stepup = 'not-json';
    expect(readPendingStepUp(req())).toBeNull();
  });
  it('rejects expired state', () => {
    vi.useFakeTimers();
    setPendingStepUp(res, payload());
    vi.advanceTimersByTime(300_001);
    expect(readPendingStepUp(req())).toBeNull();
  });
  it('clears the same constrained cookie path', () => {
    clearPendingStepUp(res);
    expect(res.clearCookie).toHaveBeenCalledWith('cf_pending_stepup', expect.objectContaining({ path: '/api/auth/security/otp' }));
  });
});
