import 'reflect-metadata';
import './load-env';
import { authHttpMetadata } from './common/auth-http.middleware';
import { corsOptions } from './common/origin-policy';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { AppLogger, workerLogger } from './common/services/logger.service';
import { env, loadEnv } from './common/env';
import { listenForApi } from './common/http-listener';
import { startupFailureMessage } from './common/startup-error';
import { buildHelmetOptions } from './common/security-headers';

let application: NestExpressApplication | undefined;

async function bootstrap() {
  loadEnv();
  const logger = new AppLogger('bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger, forceCloseConnections: true });
  application = app;
  let closing = false;
  const closeFromParent = () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0)).catch(error => { console.error('[fatal] API shutdown failed; check dependency availability.'); process.exit(1); });
  };
  process.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'clipforge:shutdown') closeFromParent();
  });
  if (process.send) process.once('disconnect', closeFromParent);

  app.disable('etag'); // Session/CSRF responses must never become conditional 304s.
  app.use(authHttpMetadata);
  app.use(cookieParser());
  // Helmet configuration lives in common/security-headers.ts so a unit test can assert it.
  const isProduction = env.NODE_ENV === 'production';
  app.use(helmet(buildHelmetOptions(isProduction)));
  // One hop (Vercel/Render/nginx) is the default; a two-proxy chain would otherwise make every
  // request look like it came from the proxy, which corrupts throttling and fraud signals.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  // JSON compresses; media does not (compression's own filter consults `compressible`, which
  // rejects video/audio/image types, and byte ranges must never be re-encoded).
  app.use(compression({ threshold: 1024 }));
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { limit: '2mb', extended: true });

  app.enableCors(corsOptions(env.ALLOWED_ORIGINS));

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ClipForge AI API')
    .setDescription(
      'AI video repurposing and automatic social publishing API. Session cookie authentication with CSRF double-submit. ' +
        'Configuration-dependent endpoints return 428 CONFIGURATION_REQUIRED with the exact missing keys.',
    )
    .setVersion('1.0.0')
    .addCookieAuth('cf_session')
    .build();
  // The OpenAPI document is an inventory of every admin route; it is a development tool, not a
  // public artefact. Mounted only outside production (set API_DOCS_ENABLED=true to force it on).
  if (!isProduction || env.API_DOCS_ENABLED) {
    try {
      const document = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs/openapi.json' });
    } catch (error) {
      logger.warn(`OpenAPI generation disabled: ${(error as Error).message}`);
    }
  }

  const port = await listenForApi(app, env);
  workerLogger.child({ port, host: '0.0.0.0', env: env.NODE_ENV }).info('ClipForge API listening');
}

if (require.main === module) void bootstrap().catch(async (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    console.error(`[fatal] Port ${env.PORT ?? env.API_PORT} (PORT takes precedence over API_PORT) is already in use. Stop only the API instance you own, or inspect the listener PID before taking action. Do not run dev:api and start:api together. No process was killed and the port was not changed.`);
  }
  // Fail loudly: a misconfigured environment must never start a half-working API.
  console.error('[fatal]', startupFailureMessage(error));
  const deadline = setTimeout(() => process.exit(1), 10000);
  try { await application?.close(); } catch { console.error('[fatal] API resource cleanup failed.'); }
  clearTimeout(deadline);
  process.exit(1);
});
