import {
  Calendar,
  EVENTS_CALENDARS,
  icsUrl,
  parseCalendars,
} from './events.calendars';

const FORMAT = 'expected a comma-separated list of calendarId:slug pairs';

describe('parseCalendars', () => {
  describe('valid configuration', () => {
    it('parses a single calendarId:slug pair', () => {
      expect(
        parseCalendars('cal-6Tm2FkWzoBpLXWr:home-assistant-meetups'),
      ).toEqual([
        { slug: 'home-assistant-meetups', calendarId: 'cal-6Tm2FkWzoBpLXWr' },
      ]);
    });

    it('parses several pairs and preserves their configured order', () => {
      const calendars = parseCalendars(
        'cal-alpha:alpha-events,cal-bravo:bravo-events,cal-charlie:charlie-events',
      );

      expect(calendars).toEqual([
        { slug: 'alpha-events', calendarId: 'cal-alpha' },
        { slug: 'bravo-events', calendarId: 'cal-bravo' },
        { slug: 'charlie-events', calendarId: 'cal-charlie' },
      ]);
    });

    it('trims whitespace around entries, IDs and slugs', () => {
      expect(
        parseCalendars(
          '  cal-alpha : alpha-events  ,\n\tcal-bravo\t:\tbravo\n',
        ),
      ).toEqual([
        { slug: 'alpha-events', calendarId: 'cal-alpha' },
        { slug: 'bravo', calendarId: 'cal-bravo' },
      ]);
    });

    it.each([
      ['an underscore', 'cal_alpha'],
      ['a hyphen', 'cal-alpha'],
      ['digits', 'cal123'],
      ['mixed case', 'cal-6Tm2FkWzoBpLXWr'],
    ])('accepts a calendar ID containing %s', (_description, calendarId) => {
      const [calendar] = parseCalendars(`${calendarId}:some-slug`);

      expect(calendar.calendarId).toBe(calendarId);
    });

    it.each([
      ['a single word', 'meetups'],
      ['several hyphen-separated words', 'home-assistant-meetups'],
      ['digits only', '123'],
      ['letters and digits', 'meetups-2026'],
    ])('accepts a slug that is %s', (_description, slug) => {
      const [calendar] = parseCalendars(`cal-alpha:${slug}`);

      expect(calendar.slug).toBe(slug);
    });

    it('tolerates a trailing comma', () => {
      expect(parseCalendars('cal-alpha:alpha,')).toEqual([
        { slug: 'alpha', calendarId: 'cal-alpha' },
      ]);
    });

    it('tolerates a doubled comma between entries', () => {
      expect(parseCalendars('cal-alpha:alpha,,cal-bravo:bravo')).toEqual([
        { slug: 'alpha', calendarId: 'cal-alpha' },
        { slug: 'bravo', calendarId: 'cal-bravo' },
      ]);
    });

    it('returns objects with exactly the slug and calendarId keys', () => {
      const [calendar] = parseCalendars('  cal-Alpha : alpha-events ');

      expect(Object.keys(calendar).sort()).toEqual(['calendarId', 'slug']);
      expect(calendar).toEqual({
        slug: 'alpha-events',
        calendarId: 'cal-Alpha',
      });
    });
  });

  describe('missing or empty configuration', () => {
    it('throws when the variable is not set', () => {
      expect(() => parseCalendars(undefined)).toThrow(
        `EVENTS_CALENDARS is not set: ${FORMAT}`,
      );
    });

    it.each([
      ['an empty string', ''],
      ['only whitespace', '   \n\t '],
      ['only commas', ',,,'],
    ])('throws when the variable is %s', (_description, raw) => {
      expect(() => parseCalendars(raw)).toThrow(
        `EVENTS_CALENDARS is set but lists no calendars: ${FORMAT}`,
      );
    });
  });

  describe('malformed entries', () => {
    it('rejects an entry with no colon', () => {
      expect(() => parseCalendars('cal-alpha')).toThrow(
        `EVENTS_CALENDARS[0] "cal-alpha" must be one calendar ID and one slug separated by ":" — ${FORMAT}`,
      );
    });

    it('rejects an entry with too many colons', () => {
      expect(() => parseCalendars('cal-alpha:alpha:extra')).toThrow(
        'must be one calendar ID and one slug separated by ":"',
      );
    });

    it('names the pasted-URL mistake instead of blaming the colon count', () => {
      expect(() =>
        parseCalendars(
          'https://api.luma.com/ics/get?entity=calendar&id=cal-a:alpha',
        ),
      ).toThrow('looks like a URL — use the bare calendar ID and slug');
    });

    it('rejects an entry with an empty calendar ID', () => {
      expect(() => parseCalendars(':alpha')).toThrow(
        'has no calendar ID before the ":"',
      );
    });

    it('rejects an entry with an empty slug', () => {
      expect(() => parseCalendars('cal-alpha:')).toThrow(
        'has no slug after the ":"',
      );
    });

    it.each([
      ['punctuation only', '---'],
      ['a space inside', 'cal alpha'],
      ['a slash', 'cal/alpha'],
    ])('rejects a calendar ID that is %s', (_description, calendarId) => {
      expect(() => parseCalendars(`${calendarId}:alpha`)).toThrow(
        'must be a bare Luma calendar ID',
      );
    });

    it.each([
      ['uppercase', 'Alpha-Events'],
      ['an underscore', 'alpha_events'],
      ['a doubled hyphen', 'alpha--events'],
      ['a leading hyphen', '-alpha'],
      ['a trailing hyphen', 'alpha-'],
    ])('rejects a slug containing %s', (_description, slug) => {
      expect(() => parseCalendars(`cal-alpha:${slug}`)).toThrow(
        'must be lowercase letters, digits and single hyphens',
      );
    });

    it('reports the failing entry by index and content', () => {
      expect(() => parseCalendars('cal-alpha:alpha,cal-bravo')).toThrow(
        'EVENTS_CALENDARS[1] "cal-bravo"',
      );
    });
  });

  describe('duplicates', () => {
    it('rejects a duplicate slug', () => {
      expect(() =>
        parseCalendars('cal-alpha:meetups,cal-bravo:meetups'),
      ).toThrow('EVENTS_CALENDARS has a duplicate slug "meetups"');
    });

    it('rejects two entries pointing at the same calendar ID', () => {
      expect(() => parseCalendars('cal-alpha:alpha,cal-alpha:bravo')).toThrow(
        'EVENTS_CALENDARS has two calendars pointing at the same ID "cal-alpha"',
      );
    });
  });
});

describe('icsUrl', () => {
  it("builds Luma's iCalendar export URL for a calendar", () => {
    expect(icsUrl('cal-6Tm2FkWzoBpLXWr')).toBe(
      'https://api.luma.com/ics/get?entity=calendar&id=cal-6Tm2FkWzoBpLXWr',
    );
  });

  it('URL-encodes the calendar ID', () => {
    // parseCalendars never lets one through, but the function should still be
    // safe on its own.
    expect(icsUrl('cal a&b')).toBe(
      'https://api.luma.com/ics/get?entity=calendar&id=cal%20a%26b',
    );
  });
});

describe('EVENTS_CALENDARS token', () => {
  it('is a symbol, so no string can collide with it in the DI container', () => {
    expect(typeof EVENTS_CALENDARS).toBe('symbol');
  });
});

describe('Calendar type', () => {
  it('is exercised by the parser (compile-time check)', () => {
    const calendar: Calendar = parseCalendars('cal-alpha:alpha')[0];

    expect(calendar.slug).toBe('alpha');
    expect(calendar.calendarId).toBe('cal-alpha');
  });
});
