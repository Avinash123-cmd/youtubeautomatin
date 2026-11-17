/** Build input, not a secret. Accept a bare HTTP(S) origin or the common /api suffix only. */
export function apiOrigin(raw: string, hosted: boolean): string | null {
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (!['', '/', '/api', '/api/'].includes(url.pathname)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (hosted && (url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || ['0.0.0.0', '[::]', '[::1]'].includes(host) || host.startsWith('[::ffff:7f'))) return null;
    return url.origin;
  } catch { return null; }
}
