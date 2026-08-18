import { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { Calendar } from '../src/events/events.calendars';
import { EventsModule } from '../src/events/events.module';
import { CalendarInfo } from '../src/events/events.service';

/**
 * A tracked calendar plus the things only the *feed* knows about it.
 *
 * `Calendar` is exactly what configuration can express — a calendar ID and a
 * slug. The display name is not configurable: the service reads it from the
 * feed's X-WR-CALNAME at runtime. So the fixtures carry the feed name
 * separately, and every `calendarName` assertion below is an assertion about
 * the feed. Each name is deliberately unlike its slug, so an implementation
 * that fell back to the slug could not pass by accident.
 */
interface CalendarFixture extends Calendar {
  /** X-WR-CALNAME this calendar's feed serves. */
  feedName: string;
  /** Serve a non-calendar body for this calendar, i.e. its feed cannot be read. */
  feedUnreadable?: boolean;
}

const FIXTURE_CALENDARS: CalendarFixture[] = [
  {
    slug: 'fixture-meetups',
    calendarId: 'cal-fixture-meetups',
    feedName: 'Fixture Meetups Around The World',
  },
  {
    slug: 'fixture-conferences',
    calendarId: 'cal-fixture-conf',
    feedName: 'The Fixture Conference Series',
  },
];

/** One healthy calendar and one whose feed cannot be read. */
const MIXED_CALENDARS: CalendarFixture[] = [
  {
    slug: 'readable-feed',
    calendarId: 'cal-readable',
    feedName: 'Readable Feed Events',
  },
  {
    slug: 'unreadable-feed',
    calendarId: 'cal-unreadable',
    feedName: 'Never Served',
    feedUnreadable: true,
  },
];

/** Two events per calendar, served out of order to prove the API sorts. */
interface EventFixture {
  uid: string;
  summary: string;
  start: string;
  end: string;
  lumaUrl: string;
}

const eventsFor = (calendar: CalendarFixture): EventFixture[] => [
  {
    uid: `evt-${calendar.slug}-later@events.lu.ma`,
    summary: `Later event on ${calendar.slug}`,
    start: '20261101T180000Z',
    end: '20261101T210000Z',
    lumaUrl: `https://luma.com/${calendar.slug}-later`,
  },
  {
    uid: `evt-${calendar.slug}-sooner@events.lu.ma`,
    summary: `Sooner event on ${calendar.slug}`,
    start: '20261001T180000Z',
    end: '20261001T210000Z',
    lumaUrl: `https://luma.com/${calendar.slug}-sooner`,
  },
];

const isoOf = (icsStamp: string): string =>
  new Date(
    icsStamp.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  ).toISOString();

/** Render the fixture as Luma renders it: CRLF lines, folded description. */
const icsFor = (calendar: CalendarFixture): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Luma//Fixture//EN',
    `X-WR-CALNAME:${calendar.feedName}`,
    ...eventsFor(calendar).flatMap((event) => [
      'BEGIN:VEVENT',
      `DTSTART:${event.start}`,
      `DTEND:${event.end}`,
      `UID:${event.uid}`,
      `SUMMARY:${event.summary}`,
      // Folded mid-URL, the way Luma folds at 75 octets.
      `DESCRIPTION:Get up-to-date information at: ${event.lumaUrl.slice(0, 30)}`,
      ` ${event.lumaUrl.slice(30)}\\n\\nHosted by the fixture`,
      'LOCATION:26 Wexford St\\, Dublin\\, Ireland',
      'GEO:53.336691;-6.26573',
      'STATUS:CONFIRMED',
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');

const toCalendarsConfig = (calendars: CalendarFixture[]): string =>
  calendars.map((c) => `${c.calendarId}:${c.slug}`).join(',');

const fetchHandlerFor =
  (calendars: CalendarFixture[]) =>
  async (input: unknown): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.luma.com' || url.pathname !== '/ics/get') {
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }
    const calendar = calendars.find(
      (c) => c.calendarId === url.searchParams.get('id'),
    );
    if (!calendar) {
      return new Response('not found', { status: 404 });
    }
    if (calendar.feedUnreadable) {
      return new Response('<html>captive portal</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(icsFor(calendar), {
      status: 200,
      headers: { 'content-type': 'text/calendar' },
    });
  };

const createApp = async (config: string): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ EVENTS_CALENDARS: config })],
      }),
      EventsModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
};

/**
 * The startup refresh is kicked off without being awaited. Drive the event
 * loop turn by turn until the collection satisfies `settled` instead of
 * sleeping.
 */
const pollUntil = async (
  server: Server,
  what: string,
  settled: (entries: CalendarInfo[]) => boolean,
): Promise<void> => {
  for (let turn = 0; turn < 200; turn++) {
    const res = await request(server).get('/events');
    if (res.status === 200 && Array.isArray(res.body) && settled(res.body)) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const waitForRefresh = (
  server: Server,
  populated: number,
  total: number = populated,
): Promise<void> =>
  pollUntil(
    server,
    'the startup refresh to populate every readable calendar',
    (entries) =>
      entries.length === total &&
      entries.filter((entry) => entry.events.length > 0).length === populated,
  );

const isIsoTimestamp = (value: unknown): boolean =>
  typeof value === 'string' &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

describe('Events (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Stubbed before init() because the service calls the network on startup.
    globalThis.fetch = jest.fn(fetchHandlerFor(FIXTURE_CALENDARS));

    app = await createApp(toCalendarsConfig(FIXTURE_CALENDARS));
    server = app.getHttpServer();

    await waitForRefresh(server, FIXTURE_CALENDARS.length);
  }, 30_000);

  afterAll(async () => {
    // Clears the refresh interval so Jest can exit cleanly.
    await app?.close();
    globalThis.fetch = originalFetch;
  });

  describe('GET /events', () => {
    it('returns one entry per configured calendar, in configured order', async () => {
      const res = await request(server).get('/events');

      expect(res.status).toBe(200);
      expect(res.body.map((entry: CalendarInfo) => entry.calendar)).toEqual(
        FIXTURE_CALENDARS.map((calendar) => calendar.slug),
      );
    });

    it('names each calendar from its feed, not its slug', async () => {
      const res = await request(server).get('/events');

      expect(res.body.map((entry: CalendarInfo) => entry.calendarName)).toEqual(
        FIXTURE_CALENDARS.map((calendar) => calendar.feedName),
      );
    });

    it('carries every calendar’s events, so one request serves a site that shows them all', async () => {
      const res = await request(server).get('/events');

      for (const entry of res.body as CalendarInfo[]) {
        expect(entry.events).toHaveLength(2);
      }
    });
  });

  describe('GET /events/:slug', () => {
    const CALENDAR = FIXTURE_CALENDARS[0];

    it('serves the calendar with its events sorted soonest first', async () => {
      const res = await request(server).get(`/events/${CALENDAR.slug}`);
      const [sooner, later] = eventsFor(CALENDAR).sort(
        (a, b) => Date.parse(isoOf(a.start)) - Date.parse(isoOf(b.start)),
      );

      expect(res.status).toBe(200);
      expect(res.body.calendar).toBe(CALENDAR.slug);
      expect(res.body.calendarName).toBe(CALENDAR.feedName);
      expect(res.body.events.map((event: { id: string }) => event.id)).toEqual([
        sooner.uid,
        later.uid,
      ]);
      expect(isIsoTimestamp(res.body.updatedAt)).toBe(true);
    });

    it('serves each event with the documented shape, parsed from the feed', async () => {
      const res = await request(server).get(`/events/${CALENDAR.slug}`);
      const fixture = eventsFor(CALENDAR)[1]; // the sooner one, served first

      expect(res.body.events[0]).toEqual({
        id: fixture.uid,
        summary: fixture.summary,
        start: isoOf(fixture.start),
        end: isoOf(fixture.end),
        description: `Get up-to-date information at: ${fixture.lumaUrl}\n\nHosted by the fixture`,
        location: '26 Wexford St, Dublin, Ireland',
        url: fixture.lumaUrl,
        latitude: 53.336691,
        longitude: -6.26573,
        status: 'confirmed',
      });
    });

    it('404s for an unknown slug without echoing it back', async () => {
      const res = await request(server).get('/events/definitely-not-here');

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('definitely-not-here');
    });
  });

  describe('a calendar whose feed cannot be read', () => {
    let mixedApp: INestApplication;
    let mixedServer: Server;

    beforeAll(async () => {
      globalThis.fetch = jest.fn(fetchHandlerFor(MIXED_CALENDARS));
      mixedApp = await createApp(toCalendarsConfig(MIXED_CALENDARS));
      mixedServer = mixedApp.getHttpServer();
      await waitForRefresh(mixedServer, 1, MIXED_CALENDARS.length);
    }, 30_000);

    afterAll(async () => {
      await mixedApp?.close();
    });

    it('stays listed with an empty event list and its slug as its name', async () => {
      const res = await request(mixedServer).get('/events/unreadable-feed');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        calendar: 'unreadable-feed',
        calendarName: 'unreadable-feed',
        events: [],
      });
    });

    it('does not stop the readable calendar from being served', async () => {
      const res = await request(mixedServer).get('/events/readable-feed');

      expect(res.status).toBe(200);
      expect(res.body.calendarName).toBe('Readable Feed Events');
      expect(res.body.events).toHaveLength(2);
    });
  });
});
