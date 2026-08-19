import { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AppGateway } from '../src/app.gateway';
import { EventsModule } from '../src/events';
import { HealthModule } from '../src/health';
import { getVersionInfo } from '../src/health/version';
import { LivestreamModule } from '../src/livestream';
import {
  setupCors,
  setupSecurity,
  setupSwagger,
  setupWebsocketCors,
} from '../src/main';

/**
 * A booted app, assembled the way bootstrap() assembles it, for the suites whose
 * subject is the wiring around the endpoints — headers, CORS, the served spec —
 * rather than livestream behaviour. Suites that need particular feed or API
 * responses build their own app with their own stubs instead.
 */
export interface TestApp {
  app: INestApplication;
  server: Server;
  /** Base URL of the listening app. Only set when started with `listen`. */
  url?: string;
  /** Shuts the app down and restores the real fetch. */
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /** Value for CORS_ORIGINS. Omitted leaves it unset, i.e. no CORS headers. */
  corsOrigins?: string;
  /** Listen on an ephemeral port, for suites that need a real client to connect. */
  listen?: boolean;
}

/**
 * One channel (and one calendar) is enough for every suite that uses this
 * fixture: none of them assert on content, they just need valid lists so the
 * app boots.
 */
const CHANNELS = 'FixtureAlpha:fixture-alpha';
const CALENDARS = 'cal-fixture:fixture-events';

/**
 * Minimal stand-ins for the upstreams the polling services talk to on
 * startup: enough for their first sweeps to complete without the network.
 */
const fetchStub = (input: unknown): Response => {
  const url = new URL(String(input));
  if (url.hostname === 'www.googleapis.com') {
    return new Response(JSON.stringify({ items: [{ id: 'UCfixture' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.hostname === 'api.luma.com') {
    return new Response(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Fixture Events\r\nEND:VCALENDAR',
      { status: 200, headers: { 'content-type': 'text/calendar' } },
    );
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
  listen = false,
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
            EVENTS_CALENDARS: CALENDARS,
          }),
        ],
      }),
      HealthModule.register({ version: getVersionInfo() }),
      LivestreamModule,
      EventsModule,
    ],
    providers: [AppGateway],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  // Same order as bootstrap(), which matters: Express walks middleware and route
  // handlers in registration order, so anything mounted before these would
  // answer without their headers. The websocket adapter has to be in place
  // before init(), which is when the gateway binds its server.
  setupSecurity(app);
  const origins = setupCors(app, corsOrigins);
  setupWebsocketCors(app, origins);
  setupSwagger(app);
  await app.init();
  if (listen) {
    await app.listen(0);
  }

  return {
    app,
    server: app.getHttpServer(),
    url: listen ? await app.getUrl() : undefined,
    close: async () => {
      // Clears the discovery/reconcile intervals so Jest can exit cleanly.
      await app.close();
      globalThis.fetch = originalFetch;
    },
  };
};
