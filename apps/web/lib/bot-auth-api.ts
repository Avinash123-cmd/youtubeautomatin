import { botProvidersResponseSchema, botLoginStatusResponseSchema, botChallengeResponseSchema, botLoginCompleteResponseSchema } from '@clipforge/validation';
import { api, ApiError } from './api';

/** A successful HTTP status is not proof that a response matches the login protocol. */
function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, body: unknown, endpoint: string): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(`The API returned an incompatible response from ${endpoint}. Restart the updated API and check the frontend API_INTERNAL_URL/proxy target.`, 502, 'AUTH_CONTRACT_MISMATCH');
  return result.data;
}
export async function loadBotProviders(signal?: AbortSignal) {
  return parse(botProvidersResponseSchema, await api<unknown>('/api/auth/providers', { signal }), '/api/auth/providers');
}
export async function loadBotStatus(signal?: AbortSignal) {
  const path = '/api/auth/telegram/status';
  try { return parse(botLoginStatusResponseSchema, await api<unknown>(path, { signal }), path); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new ApiError(`The API serving this page does not expose ${path}. This route exists in the current Telegram-only backend. Restart/rebuild apps/api and check API_INTERNAL_URL; do not change the URL to the account-notification status endpoint.`, 404, 'AUTH_ROUTE_MISSING', undefined, undefined, error.requestId);
    throw error;
  }
}
export async function createBotChallenge() {
  return parse(botChallengeResponseSchema, await api<unknown>('/api/auth/telegram/challenge', { method: 'POST' }), '/api/auth/telegram/challenge');
}
export async function completeBotLogin() {
  return parse(botLoginCompleteResponseSchema, await api<unknown>('/api/auth/telegram/complete', { method: 'POST' }), '/api/auth/telegram/complete');
}
