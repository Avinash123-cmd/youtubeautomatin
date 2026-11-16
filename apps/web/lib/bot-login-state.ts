export type BotLoginStatus = { state: 'IDLE' | 'WAITING_FOR_TELEGRAM' | 'VERIFYING' | 'EXPIRED'; expiresAt?: string; identity?: { displayName: string; username: string | null } | null };

export function botLoginView(status: BotLoginStatus | undefined, now: number) {
  const expires = status?.expiresAt ? Date.parse(status.expiresAt) : null;
  const remaining = expires !== null && Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 1000)) : 0;
  const expired = status?.state === 'EXPIRED' || Boolean(status?.expiresAt && remaining === 0);
  const waiting = !expired && ['WAITING_FOR_TELEGRAM', 'VERIFYING'].includes(status?.state ?? '');
  return { remaining, expired, waiting };
}
export function shouldPollBotLogin(status: BotLoginStatus | undefined, now: number, hasError: boolean, authenticated: boolean) {
  return !hasError && !authenticated && botLoginView(status, now).waiting;
}
