import { Logger, NotFoundException } from '@nestjs/common';

import { LumaClient } from '../luma';
import { Calendar } from './events.calendars';
import { EventsService } from './events.service';

const MINUTE_MS = 60_000;
/** The service's feed refresh interval. */
const REFRESH_MS = 15 * MINUTE_MS;

/**
 * The calendar list is configuration, injected into the service, so these
 * tests own their own fixture instead of depending on whatever is deployed.
 * Display names are deliberately absent: they come from the feed, not config.
 */
const CALENDARS: Calendar[] = [
  { slug: 'home-assistant-meetups', calendarId: 'cal-ha' },
  { slug: 'esphome-events', calendarId: 'cal-esphome' },
];

const [HA, ESPHOME] = CALENDARS;

/** A VCALENDAR wrapping the given VEVENT bodies, CRLF-separated like Luma's. */
const vcalendar = (
  name: string | undefined,
  events: string[][],
  { header = [] as string[] } = {},
): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Luma//Test//EN',
    ...(name === undefined ? [] : [`X-WR-CALNAME:${name}`]),
    ...header,
    ...events.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');

/** A complete, realistic VEVENT; tests override or drop lines as needed. */
const lumaEvent = (
  uid: string,
  overrides: Partial<Record<string, string | undefined>> = {},
): string[] => {
  const lines: Record<string, string | undefined> = {
    DTSTART: '20260604T173000Z',
    DTEND: '20260604T203000Z',
    UID: `${uid}@events.lu.ma`,
    SUMMARY: 'Dublin - Hosted by the OHF',
    DESCRIPTION:
      'Get up-to-date information at: https://luma.com/n5mzdtvb\\n\\nHosted by the OHF',
    LOCATION: '26 Wexford St\\, Dublin\\, Ireland',
    GEO: '53.336691;-6.26573',
    STATUS: 'TENTATIVE',
    ...overrides,
  };
  return Object.entries(lines)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}:${value}`);
};

/**
 * Mutable stand-in for Luma's iCalendar export. Tests mutate it between time
 * advances to simulate the calendar changing, or its feed breaking.
 */
class FakeLuma {
  private readonly bodies = new Map<string, string>();
  private readonly broken = new Set<string>();

  serve(calendarId: string, body: string): void {
    this.bodies.set(calendarId, body);
    this.broken.delete(calendarId);
  }

  break(calendarId: string): void {
    this.broken.add(calendarId);
  }

  readonly fetch = async (input: unknown): Promise<Response> => {
    const url = new URL(String(input));
    if (
      url.hostname !== 'api.luma.com' ||
      url.pathname !== '/ics/get' ||
      url.searchParams.get('entity') !== 'calendar'
    ) {
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }
    const id = url.searchParams.get('id') ?? '';
    if (this.broken.has(id)) {
      return new Response('boom', { status: 500 });
    }
    const body = this.bodies.get(id);
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/calendar' },
    });
  };
}

describe('EventsService', () => {
  let luma: FakeLuma;
  let fetchMock: jest.Mock;
  let originalFetch: typeof globalThis.fetch;
  let services: EventsService[];
  /** Frozen wall clock for the test; all expected times derive from it. */
  let now: number;

  const createService = (calendars: Calendar[] = CALENDARS): EventsService => {
    const service = new EventsService(calendars, new LumaClient());
    services.push(service);
    return service;
  };

  /** onModuleInit kicks off a refresh without awaiting it; let it finish. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await jest.advanceTimersByTimeAsync(0);
    }
  };

  const start = async (
    service: EventsService = createService(),
  ): Promise<EventsService> => {
    service.onModuleInit();
    await settle();
    return service;
  };

  const advance = async (ms: number): Promise<void> => {
    await jest.advanceTimersByTimeAsync(ms);
    await settle();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    now = Date.parse('2026-08-18T12:00:00.000Z');
    jest.setSystemTime(now);
    services = [];
    luma = new FakeLuma();
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn(luma.fetch);
    globalThis.fetch = fetchMock;
    // The refresh-failure tests exercise paths that log; keep the output quiet.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    luma.serve(
      HA.calendarId,
      vcalendar('Home Assistant Meetups', [lumaEvent('evt-dublin')]),
    );
    luma.serve(ESPHOME.calendarId, vcalendar('ESPHome Events', []));
  });

  afterEach(() => {
    for (const service of services) {
      service.onModuleDestroy();
    }
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('parsing a Luma feed', () => {
    it('parses each VEVENT into the documented event shape', async () => {
      const service = await start();

      const [event] = service.getCalendar(HA.slug).events;
      expect(event).toEqual({
        id: 'evt-dublin@events.lu.ma',
        summary: 'Dublin - Hosted by the OHF',
        start: '2026-06-04T17:30:00.000Z',
        end: '2026-06-04T20:30:00.000Z',
        description:
          'Get up-to-date information at: https://luma.com/n5mzdtvb\n\nHosted by the OHF',
        location: '26 Wexford St, Dublin, Ireland',
        url: 'https://luma.com/n5mzdtvb',
        host: 'the OHF',
        latitude: 53.336691,
        longitude: -6.26573,
        status: 'tentative',
      });
    });

    it('unfolds continuation lines the way Luma folds long descriptions', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          [
            'DTSTART:20260604T173000Z',
            'UID:evt-folded',
            'SUMMARY:Fol',
            ' ded summary',
            'DESCRIPTION:Get up-to-date information at: https://luma.com/n5',
            ' mzdtvb\\n\\nAd',
            '\tdress continues',
          ],
        ]),
      );
      const service = await start();

      const [event] = service.getCalendar(HA.slug).events;
      expect(event.summary).toBe('Folded summary');
      expect(event.description).toBe(
        'Get up-to-date information at: https://luma.com/n5mzdtvb\n\nAddress continues',
      );
      expect(event.url).toBe('https://luma.com/n5mzdtvb');
    });

    it('unescapes \\n, commas, semicolons and backslashes in text values', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          [
            'DTSTART:20260604T173000Z',
            'UID:evt-escaped',
            'SUMMARY:One\\, two\\; three \\\\ four\\nfive',
          ],
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].summary).toBe(
        'One, two; three \\ four\nfive',
      );
    });

    it('is not derailed by quoted parameters carrying colons and semicolons', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          [
            'DTSTART:20260604T173000Z',
            'UID:evt-organizer',
            'ORGANIZER;CN="Quarry; Missy: OHF":MAILTO:calendar-invite@lu.ma',
            'SUMMARY:Still parsed',
          ],
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].summary).toBe(
        'Still parsed',
      );
    });

    it('prefers an explicit URL property over a link found in the description', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-url', { URL: 'https://luma.com/explicit' }),
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].url).toBe(
        'https://luma.com/explicit',
      );
    });

    it('also recognises lu.ma links in the description', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-luma', { DESCRIPTION: 'See https://lu.ma/abc123' }),
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].url).toBe(
        'https://lu.ma/abc123',
      );
    });

    it('does not capture sentence punctuation trailing the link', async () => {
      // The link is lifted out of prose, so a description ending its sentence
      // right after the URL must not turn the full stop into a dead link.
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-punct', {
            DESCRIPTION:
              'Details at https://luma.com/n5mzdtvb.\n\nHosted by the OHF',
          }),
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].url).toBe(
        'https://luma.com/n5mzdtvb',
      );
    });

    it('serves no url when neither a URL property nor a Luma link exists', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-nourl', { DESCRIPTION: 'No link here' }),
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].url).toBeUndefined();
    });

    it('extracts several hosts from the "Hosted by" line as one string', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-hosts', {
            DESCRIPTION:
              'Get up-to-date information at: https://luma.com/cqime8fa\\n\\nHosted by AIsling Krewer & Liam Krewer',
          }),
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].host).toBe(
        'AIsling Krewer & Liam Krewer',
      );
    });

    it('serves no host when the description has no "Hosted by" line', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-nohost', {
            DESCRIPTION:
              'Find more information on https://luma.com/homeassistant',
          }),
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].host).toBeUndefined();
    });

    it('only reads a host off the final line, not free-form text', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-midtext', {
            DESCRIPTION:
              'Last year was Hosted by someone else entirely\\nCome along!',
          }),
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].host).toBeUndefined();
    });

    it('omits coordinates when GEO is malformed', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [lumaEvent('evt-geo', { GEO: 'not;numbers' })]),
      );
      const service = await start();

      const [event] = service.getCalendar(HA.slug).events;
      expect(event.latitude).toBeUndefined();
      expect(event.longitude).toBeUndefined();
    });

    it('omits a STATUS the spec does not define', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [lumaEvent('evt-status', { STATUS: 'MAYBE' })]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].status).toBeUndefined();
    });

    it('skips a VEVENT with no UID, keeping the rest', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-kept'),
          lumaEvent('ignored', { UID: undefined }),
        ]),
      );
      const service = await start();

      expect(
        service.getCalendar(HA.slug).events.map((event) => event.id),
      ).toEqual(['evt-kept@events.lu.ma']);
    });

    it('skips a VEVENT whose DTSTART is missing or unparseable', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-nostart', { DTSTART: undefined }),
          lumaEvent('evt-garbage', { DTSTART: 'whenever' }),
          lumaEvent('evt-kept'),
        ]),
      );
      const service = await start();

      expect(
        service.getCalendar(HA.slug).events.map((event) => event.id),
      ).toEqual(['evt-kept@events.lu.ma']);
    });

    it('sorts events soonest first regardless of feed order', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          lumaEvent('evt-later', { DTSTART: '20261001T170000Z' }),
          lumaEvent('evt-sooner', { DTSTART: '20260901T170000Z' }),
          lumaEvent('evt-soonest', { DTSTART: '20260801T170000Z' }),
        ]),
      );
      const service = await start();

      expect(
        service.getCalendar(HA.slug).events.map((event) => event.id),
      ).toEqual([
        'evt-soonest@events.lu.ma',
        'evt-sooner@events.lu.ma',
        'evt-later@events.lu.ma',
      ]);
    });
  });

  describe('date forms', () => {
    it('serves an all-day VALUE=DATE event as a bare date', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          [
            'DTSTART;VALUE=DATE:20260604',
            'DTEND;VALUE=DATE:20260605',
            'UID:evt-allday',
            'SUMMARY:All day',
          ],
        ]),
      );
      const service = await start();

      const [event] = service.getCalendar(HA.slug).events;
      expect(event.start).toBe('2026-06-04');
      expect(event.end).toBe('2026-06-05');
    });

    it('converts a TZID-local time to the UTC instant it names', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          [
            // Irish Standard Time is UTC+1 in June.
            'DTSTART;TZID=Europe/Dublin:20260604T183000',
            'UID:evt-zoned',
            'SUMMARY:Zoned',
          ],
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].start).toBe(
        '2026-06-04T17:30:00.000Z',
      );
    });

    it('reads a floating time (no zone, no Z) as UTC', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          ['DTSTART:20260604T173000', 'UID:evt-floating', 'SUMMARY:Floating'],
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].start).toBe(
        '2026-06-04T17:30:00.000Z',
      );
    });

    it('falls back to a UTC reading for a TZID Intl does not know', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          [
            'DTSTART;TZID=Atlantis/Lost:20260604T173000',
            'UID:evt-badzone',
            'SUMMARY:Bad zone',
          ],
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events[0].start).toBe(
        '2026-06-04T17:30:00.000Z',
      );
    });

    it('rejects a date whose components roll the calendar over', async () => {
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          ['DTSTART:20261340T173000Z', 'UID:evt-month13', 'SUMMARY:Month 13'],
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events).toEqual([]);
    });

    it('rejects an all-day date whose components roll the calendar over', async () => {
      // The bare-date path serves the regex captures directly, so without its
      // own round-trip check "2025-02-30" would go out as an ISO date.
      luma.serve(
        HA.calendarId,
        vcalendar('HA', [
          [
            'DTSTART;VALUE=DATE:20250230',
            'UID:evt-feb30',
            'SUMMARY:February 30th',
          ],
        ]),
      );
      const service = await start();

      expect(service.getCalendar(HA.slug).events).toEqual([]);
    });
  });

  describe('calendar metadata', () => {
    it('reads the display name from the feed X-WR-CALNAME', async () => {
      const service = await start();

      expect(service.getCalendar(HA.slug).calendarName).toBe(
        'Home Assistant Meetups',
      );
    });

    it('falls back to the slug when the feed carries no name', async () => {
      luma.serve(HA.calendarId, vcalendar(undefined, [lumaEvent('evt-x')]));
      const service = await start();

      expect(service.getCalendar(HA.slug).calendarName).toBe(HA.slug);
    });

    it('serves calendars in configured order', async () => {
      const service = await start();

      expect(service.getAll().map((entry) => entry.calendar)).toEqual([
        HA.slug,
        ESPHOME.slug,
      ]);
    });

    it('serves a calendar with an empty feed as an empty event list', async () => {
      const service = await start();

      expect(service.getCalendar(ESPHOME.slug).events).toEqual([]);
    });
  });

  describe('before and without a successful fetch', () => {
    it('serves default entries before onModuleInit has run', () => {
      const service = createService();

      expect(service.getAll()).toEqual(
        CALENDARS.map(({ slug }) => ({
          calendar: slug,
          calendarName: slug,
          events: [],
          updatedAt: new Date(now).toISOString(),
        })),
      );
    });

    it('serves an empty event list for a calendar that has never fetched', async () => {
      luma.break(HA.calendarId);
      const service = await start();

      expect(service.getCalendar(HA.slug)).toEqual({
        calendar: HA.slug,
        calendarName: HA.slug,
        events: [],
        updatedAt: new Date(now).toISOString(),
      });
    });

    it('one broken calendar does not stop the others from refreshing', async () => {
      luma.break(ESPHOME.calendarId);
      const service = await start();

      expect(service.getCalendar(HA.slug).events).toHaveLength(1);
    });
  });

  describe('refresh cycle', () => {
    it('picks up feed changes on the next interval', async () => {
      const service = await start();
      expect(service.getCalendar(ESPHOME.slug).events).toEqual([]);

      luma.serve(
        ESPHOME.calendarId,
        vcalendar('ESPHome Events', [lumaEvent('evt-new')]),
      );
      await advance(REFRESH_MS);

      expect(service.getCalendar(ESPHOME.slug).events).toHaveLength(1);
    });

    it('keeps serving the last good content when the feed breaks later', async () => {
      const service = await start();
      const before = service.getCalendar(HA.slug);
      expect(before.events).toHaveLength(1);

      luma.break(HA.calendarId);
      await advance(REFRESH_MS);

      expect(service.getCalendar(HA.slug)).toEqual(before);
    });

    it('treats a 200 that is not an iCalendar feed as a failed fetch', async () => {
      const service = await start();
      const before = service.getCalendar(HA.slug);

      luma.serve(HA.calendarId, '<html>captive portal</html>');
      await advance(REFRESH_MS);

      expect(service.getCalendar(HA.slug)).toEqual(before);
    });

    it('keeps updatedAt still while the feed content is unchanged', async () => {
      const service = await start();
      const before = service.getCalendar(HA.slug).updatedAt;

      await advance(REFRESH_MS);

      expect(service.getCalendar(HA.slug).updatedAt).toBe(before);
      // The feed really was re-fetched; the content just did not change.
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes(HA.calendarId),
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it('moves updatedAt when the served content changes', async () => {
      const service = await start();
      const before = service.getCalendar(HA.slug).updatedAt;

      luma.serve(
        HA.calendarId,
        vcalendar('Home Assistant Meetups', [
          lumaEvent('evt-dublin'),
          lumaEvent('evt-galway', { SUMMARY: 'Galway Meetup' }),
        ]),
      );
      await advance(REFRESH_MS);

      const after = service.getCalendar(HA.slug).updatedAt;
      expect(after).not.toBe(before);
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    });

    it('stops refreshing once the module is destroyed', async () => {
      const service = await start();
      service.onModuleDestroy();
      const calls = fetchMock.mock.calls.length;

      await advance(REFRESH_MS);

      expect(fetchMock.mock.calls.length).toBe(calls);
    });
  });

  describe('getCalendar', () => {
    it('throws NotFoundException for an unknown slug', async () => {
      const service = await start();

      expect(() => service.getCalendar('nope')).toThrow(NotFoundException);
    });

    it('does not echo the requested slug back in the error', async () => {
      const service = await start();

      expect(() => service.getCalendar('<script>')).toThrow('Unknown calendar');
      try {
        service.getCalendar('<script>');
      } catch (err) {
        expect(String(err)).not.toContain('<script>');
      }
    });
  });
});
