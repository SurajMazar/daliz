import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { ENV, loadEnv, type Env } from './config/env.js';
import { DomainResolver } from './modules/tenancy/domain-resolver.js';

/** Builds the HTTP application. Shared by main.ts and the integration tests. */
export async function createApp(opts: { logger?: boolean } = {}): Promise<NestExpressApplication> {
  loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
    logger: opts.logger === false ? false : undefined,
  });
  const env = app.get<Env>(ENV);
  if (opts.logger !== false) app.useLogger(app.get(Logger));

  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  // Small default body limit; uploads use multipart with their own per-route limits.
  app.useBodyParser('json', { limit: '256kb' });

  app.use(
    helmet({
      // The API only serves JSON and images; nothing here should ever be framed or run script.
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    }),
  );
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieParser());

  const domains = app.get(DomainResolver);
  app.enableCors({
    credentials: true,
    origin: (origin, cb) => {
      if (!origin) return cb(null, false);
      domains
        .isAllowedOrigin(origin, env.CORS_EXTRA_ORIGINS)
        .then((ok) => cb(null, ok))
        .catch(() => cb(null, false));
    },
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'X-Daliz-Client', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') setupSwagger(app);
  return app;
}

function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Daliz API')
    .setDescription('Multi-tenant business management platform. Tenant context always comes from the session, never from request input.')
    .setVersion('v1')
    .addCookieAuth('daliz_sid')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));
}
