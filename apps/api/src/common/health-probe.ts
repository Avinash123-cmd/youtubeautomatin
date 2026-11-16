/** Bounds monitor latency even for drivers that queue commands during an outage.
 * This limits the wait; it does not cancel an already executing database command.
 */
export async function boundedProbe<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Dependency probe timed out')), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function reportedServiceStatus(responseOk: boolean, body: { status?: string; apiKeyConfigured?: boolean }): 'healthy' | 'down' | 'unconfigured' {
  if (body.status === 'unconfigured' || body.apiKeyConfigured === false) return 'unconfigured';
  return responseOk && body.status === 'ok' ? 'healthy' : 'down';
}
