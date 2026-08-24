import { Injectable } from '@nestjs/common';

/**
 * Luma's iCalendar export for a calendar — the source of every event this API
 * serves. Public and unauthenticated; the calendar ID is the only input.
 */
export const icsUrl = (calendarId: string): string =>
  `https://api.luma.com/ics/get?entity=calendar&id=${encodeURIComponent(
    calendarId,
  )}`;

/**
 * The low-level Luma API surface. Consumers get a validated iCalendar body or
 * a thrown error — never a half-trusted response — so every feature reading
 * from Luma shares one place where the transport can change.
 */
@Injectable()
export class LumaClient {
  /** Fetch a calendar's public iCalendar feed and return its raw text. */
  async fetchCalendarFeed(calendarId: string): Promise<string> {
    const res = await fetch(icsUrl(calendarId), {
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
    return ics;
  }
}
