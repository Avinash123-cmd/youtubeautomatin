/** Allowlisted transport metadata only: never emit raw errors, headers, cookies or bodies. */
export function upstreamFailureCode(cause: unknown): string {
  const value = cause && typeof cause === 'object' ? cause as { name?: unknown; code?: unknown; cause?: { code?: unknown } } : undefined;
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError') return 'UPSTREAM_TIMEOUT';
  const code = value?.cause?.code ?? value?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'UPSTREAM_DNS_FAILED';
  if (code === 'ECONNREFUSED') return 'UPSTREAM_CONNECTION_REFUSED';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'UPSTREAM_TIMEOUT';
  return 'UPSTREAM_CONNECTION_FAILED';
}

export function logUpstreamFailure(target: string, status: number | null, latencyMs: number, code: string): void {
  let origin = 'invalid-origin';
  try { origin = new URL(target).origin; } catch { /* Do not log malformed raw configuration. */ }
  console.warn('[upstream-health]', { origin, endpoint: '/api/system/health', status, latencyMs, code });
}
