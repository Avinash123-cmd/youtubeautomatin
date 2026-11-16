import { isIP } from 'node:net';

/** A Telegram webhook must be a public HTTPS hostname, never a local development listener.
 * Syntactic validation only: the operator must still verify DNS/TLS and real Telegram delivery.
 */
export function isTelegramWebhookUrl(value: string): boolean {
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
