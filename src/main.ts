import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { getVersionInfo } from './health/version';

/** Where the Swagger UI is served from. */
export const SWAGGER_PATH = 'docs';
/** Where the generated OpenAPI document itself is served from. */
export const SWAGGER_JSON_PATH = `${SWAGGER_PATH}-json`;

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
  setupSwagger(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

// Guarded so importing this module for its Swagger setup (as the e2e spec does)
// does not boot a listening server.
if (require.main === module) {
  void bootstrap();
}
