import { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AppController } from '../src/app.controller';
import { HealthModule } from '../src/health';
import { getVersionInfo } from '../src/health/version';
import { LivestreamModule } from '../src/livestream';
import { setupCors, setupSecurity, setupSwagger } from '../src/main';

/**
 * A booted app, assembled the way bootstrap() assembles it, for the suites whose
 * subject is the wiring around the endpoints — headers, CORS, the served spec —
 * rather than livestream behaviour. Suites that need particular feed or API
 * responses build their own app with their own stubs instead.
 */
export interface TestApp {
  app: INestApplication;
  server: Server;
  /** Shuts the app down and restores the real fetch. */
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /** Value for CORS_ORIGINS. Omitted leaves it unset, i.e. no CORS headers. */
  corsOrigins?: string;
}

/**
 * One channel is enough for every suite that uses this fixture: none of them
 * assert on channel content, they just need a valid list so the app boots.
 */
const CHANNELS = 'FixtureAlpha:fixture-alpha';

/**
 * Minimal stand-ins for the two upstreams the livestream service talks to on
 * startup: enough for discovery to complete without reaching the network.
 */
const fetchStub = (input: unknown): Response => {
  const url = new URL(String(input));
  if (url.hostname === 'www.googleapis.com') {
    return new Response(JSON.stringify({ items: [{ id: 'UCfixture' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" ' +
      'xmlns="http://www.w3.org/2005/Atom"><title>Fixture Alpha</title></feed>',
    { status: 200, headers: { 'content-type': 'application/atom+xml' } },
  );
};

export const startTestApp = async ({
  corsOrigins,
}: TestAppOptions = {}): Promise<TestApp> => {
  const originalFetch = globalThis.fetch;
  // Stubbed before init() because the livestream service calls out on startup.
  globalThis.fetch = jest.fn((input: unknown) =>
    Promise.resolve(fetchStub(input)),
  );

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            YOUTUBE_API_KEY: 'test-key',
            LIVESTREAM_CHANNELS: CHANNELS,
          }),
        ],
      }),
      HealthModule.register({ version: getVersionInfo() }),
      LivestreamModule,
    ],
    controllers: [AppController],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  // Same order as bootstrap(), which matters: Express walks middleware and route
  // handlers in registration order, so anything mounted before these would
  // answer without their headers.
  setupSecurity(app);
  setupCors(app, corsOrigins);
  setupSwagger(app);
  await app.init();

  return {
    app,
    server: app.getHttpServer(),
    close: async () => {
      // Clears the discovery/reconcile intervals so Jest can exit cleanly.
      await app.close();
      globalThis.fetch = originalFetch;
    },
  };
};
