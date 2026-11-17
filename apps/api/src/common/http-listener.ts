import type { NestExpressApplication } from '@nestjs/platform-express';

/** PORT belongs to the host; API_PORT is the backward-compatible local fallback. */
export async function listenForApi(
  app: Pick<NestExpressApplication, 'listen'>,
  config: { PORT?: number; API_PORT: number },
): Promise<number> {
  const port = config.PORT ?? config.API_PORT;
  await app.listen(port, '0.0.0.0');
  return port;
}
