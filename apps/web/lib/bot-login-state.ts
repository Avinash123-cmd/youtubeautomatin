import type { BotLoginStatusResponse } from '@clipforge/validation';

export type BotLoginStatus = BotLoginStatusResponse;

export function botLoginView(status: BotLoginStatus | undefined, now: number) {
  const expiresAt = status && 'expiresAt' in status ? status.expiresAt : undefined;
  const expires = expiresAt ? Date.parse(expiresAt) : null;
  const remaining = expires !== null && Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 1000)) : 0;
  const expired = status?.state === 'EXPIRED' || Boolean(expiresAt && remaining === 0);
  const waiting = !expired && remaining > 0 && ['WAITING_FOR_TELEGRAM', 'VERIFYING'].includes(status?.state ?? '');
  return { remaining, expired, waiting };
}
export function shouldPollBotLogin(status: BotLoginStatus | undefined, now: number, hasError: boolean, authenticated: boolean) {
  return !hasError && !authenticated && botLoginView(status, now).waiting;
}

export type BotLoginPhase = 'IDLE' | 'CREATING_CHALLENGE' | 'WAITING_FOR_TELEGRAM' | 'VERIFYING' | 'AUTHENTICATED' | 'EXPIRED' | 'FAILED';
export function botLoginPhase(input: { status?: BotLoginStatus; creating: boolean; completing: boolean; authenticated: boolean; failed: boolean }, now: number): BotLoginPhase {
  if (input.authenticated) return 'AUTHENTICATED';
  if (input.creating) return 'CREATING_CHALLENGE';
  if (input.failed) return 'FAILED';
  const view = botLoginView(input.status, now);
  if (view.expired) return 'EXPIRED';
  if (input.completing || input.status?.state === 'VERIFYING') return 'VERIFYING';
  return view.waiting ? 'WAITING_FOR_TELEGRAM' : 'IDLE';
}
