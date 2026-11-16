import { describe, expect, it } from 'vitest';
import { botLoginView, shouldPollBotLogin, botLoginPhase } from '../../apps/web/lib/bot-login-state';
describe('bot login browser state', () => {
  const pending = { state: 'WAITING_FOR_TELEGRAM' as const, expiresAt: new Date(10000).toISOString() };
  it('is idle without a cookie-restored challenge', () => { expect(botLoginView(undefined, 0)).toEqual({ remaining: 0, waiting: false, expired: false }); });
  it('restores pending countdown without persisting secrets in JS storage', () => { expect(botLoginView(pending, 1000)).toEqual({ remaining: 9, waiting: true, expired: false }); });
  it('expires exactly at the deadline and stops polling', () => { expect(botLoginView(pending, 10000).expired).toBe(true); expect(shouldPollBotLogin(pending, 10000, false, false)).toBe(false); });
  it('stops polling on success or network failure until an explicit retry', () => { expect(shouldPollBotLogin(pending, 1000, false, true)).toBe(false); expect(shouldPollBotLogin(pending, 1000, true, false)).toBe(false); expect(shouldPollBotLogin(pending, 1000, false, false)).toBe(true); });
  it('requires explicit browser confirmation after Telegram approval', () => { expect(botLoginView({ ...pending, state: 'VERIFYING', identity: { displayName: 'Verified', username: null } }, 1000).waiting).toBe(true); });
  it('treats malformed expiry as expired, not infinite waiting', () => { expect(botLoginView({ ...pending, expiresAt: 'bad' }, 0).expired).toBe(true); });
});

it('represents every frontend phase without conflating a disabled query with loading', () => {
  const base = { creating: false, completing: false, authenticated: false, failed: false };
  expect(botLoginPhase(base, 0)).toBe('IDLE');
  expect(botLoginPhase({ ...base, creating: true }, 0)).toBe('CREATING_CHALLENGE');
  expect(botLoginPhase({ ...base, status: { state: 'WAITING_FOR_TELEGRAM', expiresAt: new Date(10000).toISOString() } }, 0)).toBe('WAITING_FOR_TELEGRAM');
  expect(botLoginPhase({ ...base, completing: true }, 0)).toBe('VERIFYING');
  expect(botLoginPhase({ ...base, authenticated: true }, 0)).toBe('AUTHENTICATED');
  expect(botLoginPhase({ ...base, status: { state: 'EXPIRED' } }, 0)).toBe('EXPIRED');
  expect(botLoginPhase({ ...base, failed: true }, 0)).toBe('FAILED');
});
