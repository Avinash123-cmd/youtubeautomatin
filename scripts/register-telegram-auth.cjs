/** Existing-bot operator tool. No credentials in argv, output or caught exception strings. */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { isIP } = require('node:net');

const MESSAGES = {
  CONFIGURATION_REQUIRED: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME in the root .env or injected environment.',
  BOT_ID_INVALID: 'TELEGRAM_BOT_ID must be a positive numeric Bot ID matching the token prefix.',
  WEBHOOK_SECRET_REQUIRED: 'Set an independent TELEGRAM_WEBHOOK_SECRET (16–256 URL-safe characters).',
  WEBHOOK_URL_INVALID: 'Set TELEGRAM_WEBHOOK_URL to a public HTTPS hostname ending /api/auth/telegram/webhook. Localhost, IP literals, private hostnames, credentials and query strings are not accepted. Use an HTTPS tunnel for local development.',
  TELEGRAM_UNAVAILABLE: 'Telegram could not complete the operation. Check network access, the bot token and Telegram availability.',
  BOT_IDENTITY_MISMATCH: 'Telegram getMe did not match the configured bot username/ID. No webhook registration was attempted.',
  WEBHOOK_MISMATCH: 'Telegram did not report the expected webhook destination after registration.',
  INVALID_MODE: 'Use --check-config, --verify-bot, --status or --register (default).',
  ENV_LOAD_FAILED: 'Could not load the repository root .env. Check file permissions and Node >=20.12. No environment values were printed.',
};
class SetupError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}
function isPublicWebhookUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    return url.protocol === 'https:' && url.pathname === '/api/auth/telegram/webhook'
      && !url.username && !url.password && !url.search && !url.hash
      && ['', '443', '80', '88', '8443'].includes(url.port)
      && host.includes('.') && !isIP(host) && !host.includes(':')
      && !['localhost', 'local', 'internal'].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch { return false; }
}
function loadRootEnv(root = resolve(__dirname, '..')) {
  const file = resolve(root, '.env');
  try { if (existsSync(file)) process.loadEnvFile(file); }
  catch { throw new SetupError('ENV_LOAD_FAILED'); }
}
function readConfiguration(env, mode) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const username = env.TELEGRAM_BOT_USERNAME?.trim();
  const botId = env.TELEGRAM_BOT_ID?.trim() || null;
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token || !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token) || !username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new SetupError('CONFIGURATION_REQUIRED');
  if (botId && (!/^[1-9]\d*$/.test(botId) || botId !== token.split(':')[0])) throw new SetupError('BOT_ID_INVALID');
  if (mode === 'verify-bot') return { token, username, botId };
  if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new SetupError('WEBHOOK_SECRET_REQUIRED');
  let url;
  try { url = new URL(env.TELEGRAM_WEBHOOK_URL || '/api/auth/telegram/webhook', env.APP_URL).toString(); }
  catch { throw new SetupError('WEBHOOK_URL_INVALID'); }
  if (!isPublicWebhookUrl(url)) throw new SetupError('WEBHOOK_URL_INVALID');
  return { token, username, botId, secret, url };
}

/** fetchImpl is injectable only for isolated tests; runtime always calls the official Bot API. */
async function runBotSetup({ env = process.env, mode = 'register', fetchImpl = globalThis.fetch } = {}) {
  if (!['register', 'verify-bot', 'check-config', 'status'].includes(mode)) throw new SetupError('INVALID_MODE');
  const config = readConfiguration(env, mode);
  if (mode === 'check-config') return { configurationValid: true, networkChecked: false, webhookRegistered: false };
  async function call(method, body = {}) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || data?.ok !== true || !data.result) throw new Error();
      return data.result;
    } catch { throw new SetupError('TELEGRAM_UNAVAILABLE'); }
  }
  const me = await call('getMe');
  if (me.is_bot !== true || !Number.isSafeInteger(me.id) || me.id <= 0 || String(me.id) !== config.token.split(':')[0] || typeof me.username !== 'string' || me.username.toLowerCase() !== config.username.toLowerCase() || (config.botId && String(me.id) !== config.botId)) throw new SetupError('BOT_IDENTITY_MISMATCH');
  if (mode === 'verify-bot') return { botIdentityVerified: true, usernameMatches: true, botIdMatches: true, webhookChanged: false };
  if (mode === 'register') await call('setWebhook', { url: config.url, secret_token: config.secret, allowed_updates: ['message'], drop_pending_updates: false });
  const info = await call('getWebhookInfo');
  const matches = info.url === config.url;
  if (mode === 'register' && !matches) throw new SetupError('WEBHOOK_MISMATCH');
  return { botIdentityVerified: true, webhookRegistered: Boolean(info.url), destinationMatches: matches, webhookChanged: mode === 'register', pendingUpdates: Number.isSafeInteger(info.pending_update_count) ? info.pending_update_count : null, lastErrorRecorded: Boolean(info.last_error_date), realAuthenticationVerified: false };
}

if (require.main === module) {
  Promise.resolve().then(() => {
    loadRootEnv();
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !['--register', '--verify-bot', '--check-config', '--status'].includes(args[0]))) throw new SetupError('INVALID_MODE');
    return runBotSetup({ mode: args[0]?.slice(2) || 'register' });
  }).then(result => console.log(JSON.stringify(result))).catch(error => {
    const safe = error instanceof SetupError ? error : new SetupError('TELEGRAM_UNAVAILABLE');
    console.error(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
    process.exitCode = 1;
  });
}
module.exports = { runBotSetup, isPublicWebhookUrl, loadRootEnv };
