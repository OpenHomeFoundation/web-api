import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { LumaClient } from '../luma';
import { Calendar, EVENTS_CALENDARS } from './events.calendars';
import {
  ContentLine,
  eventsEqual,
  extractAddress,
  HOST_PATTERN,
  LUMA_LINK_PATTERN,
  parseContentLine,
  parseIcsDate,
  stackOf,
  unescapeText,
  unfold,
} from './events.helpers';

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
  /**
   * The venue address as the description's "Address:" block lists it, one
   * line per array item. Empty when the description carries no such block,
   * or the block only holds Luma's "Check event page for more details."
   * placeholder.
   */
  address: string[];
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
    private readonly luma: LumaClient,
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
    const ics = await this.luma.fetchCalendarFeed(calendar.calendarId);
    const { name, events } = this.parseCalendar(ics);
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
      address: extractAddress(description ?? ''),
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
