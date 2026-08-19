import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { Calendar, EVENTS_CALENDARS, icsUrl } from './events.calendars';

/**
 * The iCalendar STATUS values the spec defines — the single source of truth
 * for both parsing and the documented schema (events.response.ts derives its
 * enum and descriptions from it).
 */
export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface EventInfo {
  /** Stable event identifier, the feed's UID (e.g. "evt-…@events.lu.ma"). */
  id: string;
  /** Event title. */
  summary: string;
  /**
   * ISO 8601 start: a UTC date-time for timed events, a bare date
   * (`YYYY-MM-DD`) for all-day ones.
   */
  start: string;
  /** ISO 8601 end, in the same form as `start`. Absent when the feed omits it. */
  end?: string;
  description?: string;
  /** Human-readable venue or address, as the feed carries it. */
  location?: string;
  /** The event's Luma page. */
  url?: string;
  /** Who is hosting, as the description's "Hosted by …" line names them. */
  host?: string;
  /** Venue latitude in decimal degrees, when the feed carries coordinates. */
  latitude?: number;
  /** Venue longitude in decimal degrees, when the feed carries coordinates. */
  longitude?: number;
  /** iCalendar STATUS, when it is one of the values the spec defines. */
  status?: EventStatus;
}

export interface CalendarInfo {
  /** Calendar slug, e.g. "home-assistant-meetups". */
  calendar: string;
  /** Human-friendly calendar name. */
  calendarName: string;
  /** Every event the feed advertises, soonest first. */
  events: EventInfo[];
  /** ISO 8601 timestamp of when this calendar's served content last changed. */
  updatedAt: string;
}

/** One property line of an iCalendar component: NAME;PARAM=…:value. */
interface ContentLine {
  name: string;
  params: Map<string, string>;
  value: string;
}

/** What a fetch of one calendar feed yields. */
interface ParsedCalendar {
  /** The feed's X-WR-CALNAME, i.e. the calendar's display name. */
  name: string;
  events: EventInfo[];
}

/**
 * Refresh cadence. Events change on the scale of days, so this is generous
 * already; the feed itself advertises a 12-hour TTL.
 */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** 20250604T173000Z or 20250604T173000 (the trailing Z marks UTC). */
const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
/** 20250604 — an all-day date, no time or zone at all. */
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * Luma does not export a URL property; the event's page link only appears
 * inside the DESCRIPTION text ("Get up-to-date information at: https://…").
 * Matched against the unescaped text, where \n has become a real newline.
 */
const LUMA_LINK_PATTERN =
  /https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[^\s"'<>]+/;

/**
 * The host is also only in the description, as the templated final line
 * "Hosted by {NAME}" — where {NAME} may list several people ("AIsling Krewer
 * & Liam Krewer"). Anchored to the last line so a stray "Hosted by" inside
 * free-form text cannot match; events without the line simply have no host.
 */
const HOST_PATTERN = /(?:^|\n)Hosted by ([^\n]+?)\s*$/;

const stackOf = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

/**
 * Every EventInfo field, typed as a Record so a field added to the interface
 * fails to compile until eventsEqual compares it too.
 */
const EVENT_INFO_FIELDS: Record<keyof EventInfo, true> = {
  id: true,
  summary: true,
  start: true,
  end: true,
  description: true,
  location: true,
  url: true,
  host: true,
  latitude: true,
  longitude: true,
  status: true,
};

const EVENT_FIELDS = Object.keys(EVENT_INFO_FIELDS) as (keyof EventInfo)[];

/**
 * Field-by-field equality over two already-sorted event lists, so an unchanged
 * feed is detected without serialising both arrays on every refresh.
 */
const eventsEqual = (a: EventInfo[], b: EventInfo[]): boolean =>
  a.length === b.length &&
  a.every((event, index) =>
    EVENT_FIELDS.every((field) => event[field] === b[index][field]),
  );

/**
 * Undo iCalendar text escaping: \n (either case) is a newline, and an escaped
 * backslash, comma or semicolon becomes the character itself. Any other
 * escaped character keeps itself and drops the backslash, the mildest reading
 * of input the spec does not allow.
 */
const unescapeText = (value: string): string =>
  value.replace(/\\(.)/g, (_match, ch: string) =>
    ch === 'n' || ch === 'N' ? '\n' : ch,
  );

/**
 * Undo iCalendar line folding: a CRLF (or bare LF) followed by a space or tab
 * continues the previous line, and the break plus that one character vanish.
 */
const unfold = (ics: string): string => ics.replace(/\r?\n[ \t]/g, '');

/**
 * Split one content line into name, parameters and value. The value separator
 * is the first colon outside double quotes — a colon inside a quoted parameter
 * (ORGANIZER;CN="a:b":…) or inside the value itself (URLs) is data, not
 * structure. Returns undefined for a line with no separator at all.
 */
const parseContentLine = (line: string): ContentLine | undefined => {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ':' && !inQuotes) {
      return {
        ...parseNameAndParams(line.slice(0, i)),
        value: line.slice(i + 1),
      };
    }
  }
  return undefined;
};

const parseNameAndParams = (
  head: string,
): { name: string; params: Map<string, string> } => {
  // Same quote rule as the value separator: a semicolon inside a quoted
  // parameter value separates nothing. The quotes themselves are dropped.
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of head) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ';' && !inQuotes) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);

  const params = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq > 0) {
      params.set(segment.slice(0, eq).toUpperCase(), segment.slice(eq + 1));
    }
  }
  return { name: segments[0].toUpperCase(), params };
};

/**
 * The zone's UTC offset at a given instant, computed from what a clock in that
 * zone shows then. Intl carries the full IANA zone database, so this needs no
 * dependency of its own.
 */
const zoneOffsetMs = (timeZone: string, utcMs: number): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utcMs);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      read('hour'),
      read('minute'),
      read('second'),
    ) - utcMs
  );
};

/**
 * Convert a wall-clock time in a zone to the UTC instant it names. The first
 * pass guesses using the offset in force at the wall time read as UTC; the
 * second corrects it when a DST change sits between the guess and the answer.
 */
const zonedToUtcMs = (wallMs: number, timeZone: string): number => {
  const guess = wallMs - zoneOffsetMs(timeZone, wallMs);
  return wallMs - zoneOffsetMs(timeZone, guess);
};

/**
 * Parse a DTSTART/DTEND value into the ISO 8601 string this API serves.
 *
 * Luma exports UTC date-times exclusively, but the other forms iCalendar
 * allows are handled rather than served wrong: an all-day date stays a bare
 * date, and a local time with a TZID parameter is converted to UTC. A floating
 * time (no zone, no Z) is read as UTC — the only self-consistent choice for a
 * feed that otherwise serves UTC — as is a TZID Intl does not recognise.
 * Returns undefined for a value that is not a date at all.
 */
const parseIcsDate = (
  value: string,
  params: Map<string, string>,
): string | undefined => {
  const trimmed = value.trim();

  const date = DATE_PATTERN.exec(trimmed);
  if (date || params.get('VALUE')?.toUpperCase() === 'DATE') {
    if (!date) {
      return undefined;
    }
    const [, year, month, day] = date;
    return `${year}-${month}-${day}`;
  }

  const dateTime = DATE_TIME_PATTERN.exec(trimmed);
  if (!dateTime) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, utcMarker] = dateTime;
  const wallMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  // A nonsense component (month 13) still matches the pattern but rolls the
  // date over; reject anything that does not round-trip.
  if (
    new Date(wallMs).toISOString().slice(0, 10) !== `${year}-${month}-${day}`
  ) {
    return undefined;
  }

  const timeZone = params.get('TZID');
  if (utcMarker === 'Z' || !timeZone) {
    return new Date(wallMs).toISOString();
  }
  try {
    return new Date(zonedToUtcMs(wallMs, timeZone)).toISOString();
  } catch {
    // Intl throws on a zone it does not know; serve the wall time as UTC
    // rather than dropping the event.
    return new Date(wallMs).toISOString();
  }
};

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly calendarsBySlug: Map<string, Calendar>;
  /** Ready-to-serve calendar content per slug. */
  private readonly state = new Map<string, CalendarInfo>();
  /** Stable timestamp used for calendars that have no state yet. */
  private readonly startedAt = new Date().toISOString();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshRunning = false;

  constructor(
    @Inject(EVENTS_CALENDARS) private readonly calendars: readonly Calendar[],
  ) {
    this.calendarsBySlug = new Map(this.calendars.map((c) => [c.slug, c]));
  }

  onModuleInit(): void {
    // Seed initial state so the API is not blank until the first timer fires.
    // Deliberately not awaited: startup must not block on Luma being reachable.
    void this.refresh();
    this.refreshTimer = setInterval(
      () => void this.refresh(),
      REFRESH_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  getAll(): CalendarInfo[] {
    return this.calendars.map((calendar) => this.readState(calendar));
  }

  getCalendar(slug: string): CalendarInfo {
    const calendar = this.calendarsBySlug.get(slug);
    if (!calendar) {
      // The requested slug is deliberately not echoed back. It is attacker
      // controlled, and a consumer that renders this message into a page would
      // inherit an injection we handed it. The path they asked for already tells
      // them which calendar was not found.
      throw new NotFoundException('Unknown calendar');
    }
    return this.readState(calendar);
  }

  private readState(calendar: Calendar): CalendarInfo {
    return this.state.get(calendar.slug) ?? this.defaultInfo(calendar);
  }

  private defaultInfo(calendar: Calendar): CalendarInfo {
    return {
      calendar: calendar.slug,
      calendarName: calendar.slug,
      events: [],
      updatedAt: this.startedAt,
    };
  }

  /**
   * Re-fetch every calendar's feed. Runs on startup and on a timer; a calendar
   * whose fetch fails keeps serving what it served before — stale content
   * beats a blank page — and one that has never succeeded serves an empty
   * event list rather than an error.
   */
  private async refresh(): Promise<void> {
    if (this.refreshRunning) {
      return;
    }
    this.refreshRunning = true;
    try {
      await Promise.all(
        this.calendars.map((calendar) =>
          this.refreshCalendar(calendar).catch((err) => {
            this.logger.error(
              `Refresh failed for ${calendar.slug}`,
              stackOf(err),
            );
            // Ensure the calendar still has a deterministic state entry so the
            // API doesn't fall back to a fresh defaultInfo on every request.
            if (!this.state.has(calendar.slug)) {
              this.state.set(calendar.slug, this.defaultInfo(calendar));
            }
          }),
        ),
      );
    } finally {
      this.refreshRunning = false;
    }
  }

  private async refreshCalendar(calendar: Calendar): Promise<void> {
    const { name, events } = await this.fetchCalendar(calendar);
    const previous = this.state.get(calendar.slug);
    // Display names come from the feed itself rather than config, so they stay
    // right through a rename without a deploy; the slug fills in until the
    // first successful fetch.
    const calendarName = name || calendar.slug;

    // updatedAt reports when the served content last *changed*, so clients can
    // use it for caching and change detection. An unchanged feed therefore
    // keeps the previous timestamp instead of advancing every 15 minutes.
    const changed =
      !previous ||
      previous.calendarName !== calendarName ||
      !eventsEqual(previous.events, events);

    this.state.set(calendar.slug, {
      calendar: calendar.slug,
      calendarName,
      events,
      updatedAt: changed ? new Date().toISOString() : previous.updatedAt,
    });
  }

  private async fetchCalendar(calendar: Calendar): Promise<ParsedCalendar> {
    const res = await fetch(icsUrl(calendar.calendarId), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Feed request failed: ${res.status}`);
    }
    const ics = await res.text();
    // A 200 carrying something other than a calendar (an error page, a proxy
    // interstitial) would otherwise read as "this calendar has no events" and
    // wipe the served list. Treat it as a failed fetch so prior state survives.
    if (!ics.includes('BEGIN:VCALENDAR')) {
      throw new Error('Feed response was not an iCalendar feed');
    }
    return this.parseCalendar(ics);
  }

  private parseCalendar(ics: string): ParsedCalendar {
    let name = '';
    const events: EventInfo[] = [];
    /** Lines of the VEVENT being walked, or undefined between events. */
    let current: ContentLine[] | undefined;

    for (const raw of unfold(ics).split(/\r?\n/)) {
      const line = parseContentLine(raw);
      if (!line) {
        continue;
      }
      if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VEVENT') {
        current = [];
      } else if (line.name === 'END' && line.value.toUpperCase() === 'VEVENT') {
        if (current) {
          const event = this.toEvent(current);
          if (event) {
            events.push(event);
          }
        }
        current = undefined;
      } else if (current) {
        current.push(line);
      } else if (line.name === 'X-WR-CALNAME') {
        name = unescapeText(line.value).trim();
      }
    }

    // Soonest first; the tiebreak keeps the order stable across refreshes so
    // updatedAt does not move for a mere reshuffle.
    events.sort(
      (a, b) =>
        Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id),
    );
    return { name, events };
  }

  /**
   * Assemble one event from its VEVENT lines. Returns undefined for an entry
   * missing the identity this API's contract needs — a UID and a parseable
   * start — which is a malformed feed entry, not a representable event.
   */
  private toEvent(lines: ContentLine[]): EventInfo | undefined {
    const byName = new Map<string, ContentLine>();
    for (const line of lines) {
      // First occurrence wins; the properties read here are single-occurrence
      // by spec, so a duplicate is feed noise.
      if (!byName.has(line.name)) {
        byName.set(line.name, line);
      }
    }
    const text = (name: string): string | undefined => {
      const line = byName.get(name);
      if (!line) {
        return undefined;
      }
      const value = unescapeText(line.value).trim();
      return value || undefined;
    };

    const id = byName.get('UID')?.value.trim();
    const dtstart = byName.get('DTSTART');
    const start = dtstart && parseIcsDate(dtstart.value, dtstart.params);
    if (!id || !start) {
      return undefined;
    }

    const dtend = byName.get('DTEND');
    const description = text('DESCRIPTION');
    const geo = this.parseGeo(byName.get('GEO')?.value);
    const status = text('STATUS')?.toLowerCase();

    return {
      id,
      summary: text('SUMMARY') ?? '',
      start,
      end: dtend ? parseIcsDate(dtend.value, dtend.params) : undefined,
      description,
      location: text('LOCATION'),
      // A URL property when the feed grows one; today the Luma page link only
      // appears inside the description text.
      url:
        text('URL') ??
        (description ? LUMA_LINK_PATTERN.exec(description)?.[0] : undefined),
      host: description ? HOST_PATTERN.exec(description)?.[1] : undefined,
      ...geo,
      status: (EVENT_STATUSES as readonly string[]).includes(status ?? '')
        ? (status as EventStatus)
        : undefined,
    };
  }

  /** GEO is "latitude;longitude" in decimal degrees. */
  private parseGeo(
    value: string | undefined,
  ): { latitude: number; longitude: number } | undefined {
    if (!value) {
      return undefined;
    }
    const [latitude, longitude] = value.split(';').map(Number);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return undefined;
    }
    return { latitude, longitude };
  }
}
