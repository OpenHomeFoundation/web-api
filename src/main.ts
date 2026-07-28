import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getVersionInfo } from './health/version';

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
  setupSwagger(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

// Guarded so importing this module for its Swagger setup (as the e2e spec does)
// does not boot a listening server.
if (require.main === module) {
  void bootstrap();
}
