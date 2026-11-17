/** Probe the same compiled API target used by rewrites; never start another API process. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const target = process.env.CLIPFORGE_API_TARGET;
  if (!target) return;
  try {
    const response = await fetch(`${target}/api/system/health`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const body: unknown = await response.json();
    const recognized = body !== null && typeof body === 'object' && 'checks' in body && Array.isArray(body.checks);
    if (!response.ok || !recognized) throw new Error(`Readiness returned HTTP ${response.status}${recognized ? '' : ' without ClipForge health metadata'}`);
    console.info('[web] Backend readiness check passed.');
  } catch {
    console.warn('[web] Backend readiness check failed. Open /healthz for the target and diagnosis. For local development run exactly one npm run dev:api, verify API_PORT/API_INTERNAL_URL, then retry. Next will remain available while the API recovers.');
  }
}
