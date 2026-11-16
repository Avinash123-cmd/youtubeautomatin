import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isTelegramWebhookUrl } from '../../apps/api/src/common/telegram-webhook-url';
const { runBotSetup, isPublicWebhookUrl } = require('../../scripts/register-telegram-auth.cjs');
const env = { TELEGRAM_BOT_TOKEN: `123456:${'a'.repeat(35)}`, TELEGRAM_BOT_ID: '123456', TELEGRAM_BOT_USERNAME: 'ClipForgeBot', TELEGRAM_WEBHOOK_SECRET: 'test-only-webhook-secret', TELEGRAM_WEBHOOK_URL: 'https://tunnel.example.com/api/auth/telegram/webhook' };
const reply = (result: unknown) => ({ ok: true, json: async () => ({ ok: true, result }) });
const me = { id: 123456, is_bot: true, username: 'ClipForgeBot' };
describe('existing-bot operator integration (isolated mocked Telegram API)', () => {
  it('verifies getMe username and ID without needing webhook credentials or mutating the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(me));
    const result = await runBotSetup({ env: { TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME: env.TELEGRAM_BOT_USERNAME, TELEGRAM_BOT_ID: env.TELEGRAM_BOT_ID }, mode: 'verify-bot', fetchImpl });
    expect(result).toMatchObject({ botIdentityVerified: true, webhookChanged: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0].endsWith('/getMe')).toBe(true);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
  });
  it('does not register a webhook if getMe identity mismatches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ ...me, id: 999999 }));
    await expect(runBotSetup({ env, fetchImpl })).rejects.toMatchObject({ code: 'BOT_IDENTITY_MISMATCH' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatching Bot ID before calling Telegram', async () => {
    const fetchImpl = vi.fn();
    await expect(runBotSetup({ env: { ...env, TELEGRAM_BOT_ID: '999999' }, fetchImpl })).rejects.toMatchObject({ code: 'BOT_ID_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('registers the secret-authenticated webhook only after identity verification, preserving pending updates', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(me)).mockResolvedValueOnce(reply(true)).mockResolvedValueOnce(reply({ url: env.TELEGRAM_WEBHOOK_URL, pending_update_count: 2 }));
    const result = await runBotSetup({ env, fetchImpl });
    expect(fetchImpl.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual(['getMe', 'setWebhook', 'getWebhookInfo']);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ url: env.TELEGRAM_WEBHOOK_URL, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: false });
    expect(result).toMatchObject({ destinationMatches: true, pendingUpdates: 2, realAuthenticationVerified: false });
    expect(JSON.stringify(result)).not.toContain(env.TELEGRAM_BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(env.TELEGRAM_WEBHOOK_SECRET);
  });
  it('can inspect status without changing registration', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(me)).mockResolvedValueOnce(reply({ url: '', pending_update_count: 0 }));
    expect(await runBotSetup({ env, mode: 'status', fetchImpl })).toMatchObject({ webhookRegistered: false, destinationMatches: false, webhookChanged: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('never exposes network error strings containing the token', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`));
    try { await runBotSetup({ env, fetchImpl }); throw new Error('expected failure'); } catch (error) {
      expect(error).toMatchObject({ code: 'TELEGRAM_UNAVAILABLE' });
      expect(String(error)).not.toContain(env.TELEGRAM_BOT_TOKEN);
    }
  });
  it('checks configuration without implying network success', async () => {
    const fetchImpl = vi.fn();
    expect(await runBotSetup({ env, mode: 'check-config', fetchImpl })).toMatchObject({ networkChecked: false, webhookRegistered: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('loads the selected repository root .env independently of working directory, preserving injected values', () => {
    const root = mkdtempSync(join(tmpdir(), 'clipforge-bot-env-'));
    const cwd = join(root, 'different-cwd'); mkdirSync(cwd);
    const modulePath = resolve('scripts/register-telegram-auth.cjs');
    try {
      writeFileSync(join(root, '.env'), 'CF_BOT_ENV_PROBE=loaded\nCF_BOT_INJECTED=must-not-win\n');
      const script = `require(${JSON.stringify(modulePath)}).loadRootEnv(${JSON.stringify(root)});console.log(process.env.CF_BOT_ENV_PROBE+':'+process.env.CF_BOT_INJECTED)`;
      expect(execFileSync(process.execPath, ['-e', script], { cwd, env: { ...process.env, CF_BOT_INJECTED: 'injected' }, encoding: 'utf8' }).trim()).toBe('loaded:injected');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
describe('API and operator URL validation have the same security boundary', () => {
  it.each(['http://localhost:4000/api/auth/telegram/webhook', 'https://localhost/api/auth/telegram/webhook', 'https://127.1/api/auth/telegram/webhook', 'https://10.0.0.1/api/auth/telegram/webhook', 'https://[::1]/api/auth/telegram/webhook', 'https://bot.internal/api/auth/telegram/webhook', 'https://bot.localhost./api/auth/telegram/webhook', 'https://tunnel.example.com:4000/api/auth/telegram/webhook', 'https://user:pass@tunnel.example.com/api/auth/telegram/webhook', 'https://tunnel.example.com/api/auth/telegram/webhook?token=no', 'https://tunnel.example.com/wrong'])('rejects %s', value => {
    expect(isTelegramWebhookUrl(value)).toBe(false); expect(isPublicWebhookUrl(value)).toBe(false);
  });
  it('accepts a public HTTPS tunnel hostname and the exact webhook path', () => { expect(isTelegramWebhookUrl(env.TELEGRAM_WEBHOOK_URL)).toBe(true); expect(isPublicWebhookUrl(env.TELEGRAM_WEBHOOK_URL)).toBe(true); });
});
