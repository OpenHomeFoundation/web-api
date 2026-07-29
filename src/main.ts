import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import {
  ANY_ORIGIN,
  CORS_ORIGINS_ENV,
  corsOriginMatchers,
  parseCorsOrigins,
} from './cors';
import { getVersionInfo } from './health/version';
import { CorsIoAdapter } from './websocket.adapter';

/** Where the Swagger UI is served from. */
export const SWAGGER_PATH = 'docs';
/** Where the generated OpenAPI document itself is served from. */
export const SWAGGER_JSON_PATH = `${SWAGGER_PATH}-json`;

/**
 * Apply the standard security response headers.
 *
 * Helmet's defaults are taken unchanged, because they already fit what this app
 * serves. The only HTML it returns is the Swagger UI, and that page satisfies
 * the default Content-Security-Policy: every script it loads is external and
 * same-origin, so `script-src 'self'` covers them, and its inline `<style>`
 * blocks fall under a default `style-src` that includes `'unsafe-inline'`.
 * test/security.e2e-spec.ts asserts that pairing, so a future Swagger release
 * that inlines a script fails a test instead of silently breaking the UI.
 *
 * Must run before any route is registered: Express walks middleware and route
 * handlers in registration order, so a route mounted earlier would answer
 * without these headers.
 */
export function setupSecurity(app: INestApplication): void {
  app.use(helmet());
}

/**
 * Allow the origins named in CORS_ORIGINS to read this API from a browser.
 *
 * The consuming sites are deployed independently of this service, so who may
 * call it is configuration rather than code: adding a site is an environment
 * change. An entry may name one origin or, as `https://*.example.com`, every
 * subdomain of a domain; `*` alone opts every origin in.
 *
 * With nothing configured, no cross-origin headers are sent at all — the API
 * still answers, but a browser on another site will not hand the response to the
 * page that asked for it. That is deliberate: a deployment that has not said who
 * may read it should not be guessed at.
 *
 * Returns the parsed origins so the WebSocket side can be held to the same list
 * without parsing it a second time.
 */
export function setupCors(
  app: INestApplication,
  raw: string | undefined,
): string[] {
  const logger = new Logger('Cors');
  const origins = parseCorsOrigins(raw);

  if (origins.length === 0) {
    logger.warn(
      `${CORS_ORIGINS_ENV} is not set — no origin can read this API from a browser`,
    );
    return origins;
  }

  const anyOrigin = origins[0] === ANY_ORIGIN;
  app.enableCors({
    // A list is matched against the request's Origin and echoed back, which is
    // why it cannot be collapsed into the "*" case: that sends a literal "*".
    origin: anyOrigin ? ANY_ORIGIN : corsOriginMatchers(origins),
    // Every endpoint here is a read, so no other method needs advertising.
    methods: ['GET'],
  });

  logger.log(
    anyOrigin
      ? 'Cross-origin reads allowed from any origin'
      : `Cross-origin reads allowed from ${origins.join(', ')}`,
  );

  return origins;
}

/**
 * Hold the Socket.IO gateway to the same origins as the HTTP endpoints.
 *
 * Must be called before the app is initialised, since that is when gateways bind
 * their server. See CorsIoAdapter for why socket.io's own `cors` option is not
 * enough on its own.
 */
export function setupWebsocketCors(
  app: INestApplication,
  origins: readonly string[],
): void {
  app.useWebSocketAdapter(new CorsIoAdapter(app, origins));
}

/**
 * Mount the OpenAPI document generated from the codebase, plus its UI.
 *
 * Served in every environment, including production: the API is public, so its
 * documentation is too.
 *
 * The reported version is the running build's, so the spec a deployment serves
 * always describes that deployment rather than a hardcoded number.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Open Home Foundation Web API')
    .setDescription(
      'Public web API for openhomefoundation.org. Serves the livestream status ' +
        "of the foundation's YouTube channels, derived from their feeds and the " +
        'YouTube Data API.',
    )
    .setVersion(getVersionInfo().version)
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupSecurity(app);
  // Read through ConfigService so a value from .env is picked up like any other.
  const origins = setupCors(
    app,
    app.get(ConfigService).get<string>(CORS_ORIGINS_ENV),
  );
  // The same list governs both, so the socket transport cannot become the way
  // around the HTTP allow-list.
  setupWebsocketCors(app, origins);
  setupSwagger(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

// Guarded so importing this module for its Swagger setup (as the e2e spec does)
// does not boot a listening server.
if (require.main === module) {
  void bootstrap();
}
