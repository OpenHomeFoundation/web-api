export interface Calendar {
  /** URL-safe identifier used in the API path, e.g. "home-assistant-meetups". */
  slug: string;
  /** Luma calendar ID, e.g. "cal-6Tm2FkWzoBpLXWr". */
  calendarId: string;
}

/** DI token for the parsed, validated calendar list. */
export const EVENTS_CALENDARS = Symbol('EVENTS_CALENDARS');

/** Slugs appear in the API path, so keep them unambiguous. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What a Luma calendar ID may contain: letters, digits, underscores and
 * hyphens, and at least one alphanumeric so punctuation alone ("--", "__") is
 * rejected. Enforced so a malformed ID fails the deploy rather than every
 * feed request at runtime.
 */
const CALENDAR_ID_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_-]+$/;

const ENV_VAR = 'EVENTS_CALENDARS';
const FORMAT = 'expected a comma-separated list of calendarId:slug pairs';

/**
 * Luma's iCalendar export for a calendar — the source of every event this API
 * serves. Public and unauthenticated; the calendar ID is the only input.
 */
export const icsUrl = (calendarId: string): string =>
  `https://api.luma.com/ics/get?entity=calendar&id=${encodeURIComponent(
    calendarId,
  )}`;

/**
 * Parse the tracked calendars out of the EVENTS_CALENDARS environment
 * variable, e.g. `cal-6Tm2FkWzoBpLXWr:home-assistant-meetups`. Adding or
 * removing a calendar is a config change, not a code change.
 *
 * Each entry pairs the Luma calendar ID the feed is fetched by with the slug
 * this API serves it under. The slug is pinned here rather than derived from
 * the calendar's Luma name so that renaming the calendar cannot silently
 * change our public URLs. Display names are read from the feed at runtime, so
 * they are deliberately not configured.
 *
 * Throws on missing or malformed config rather than quietly tracking nothing,
 * so a bad deploy fails loudly instead of serving an empty calendar list.
 */
export function parseCalendars(raw: string | undefined): Calendar[] {
  if (raw === undefined || raw === null) {
    throw new Error(`${ENV_VAR} is not set: ${FORMAT}`);
  }

  // A trailing or doubled comma is a typo, not a calendar.
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Reported distinctly from unset, so an operator who did set the variable is
  // not sent looking for a missing one. Blank and comma-only values are the
  // same mistake, so they share this message.
  if (entries.length === 0) {
    throw new Error(`${ENV_VAR} is set but lists no calendars: ${FORMAT}`);
  }

  const calendars = entries.map(toCalendar);
  const slugs = new Set<string>();
  const ids = new Set<string>();
  for (const { slug, calendarId } of calendars) {
    if (slugs.has(slug)) {
      throw new Error(`${ENV_VAR} has a duplicate slug "${slug}"`);
    }
    slugs.add(slug);
    // Two entries with the same ID would poll one calendar twice and serve it
    // under two slugs.
    if (ids.has(calendarId)) {
      throw new Error(
        `${ENV_VAR} has two calendars pointing at the same ID "${calendarId}"`,
      );
    }
    ids.add(calendarId);
  }
  return calendars;
}

function toCalendar(entry: string, index: number): Calendar {
  const at = `${ENV_VAR}[${index}] "${entry}"`;

  // A pasted feed URL carries its own colon, so name the real mistake rather
  // than blaming the colon count.
  if (entry.includes('://')) {
    throw new Error(
      `${at} looks like a URL — use the bare calendar ID and slug, e.g. cal-6Tm2FkWzoBpLXWr:home-assistant-meetups`,
    );
  }

  const parts = entry.split(':');
  if (parts.length !== 2) {
    throw new Error(
      `${at} must be one calendar ID and one slug separated by ":" — ${FORMAT}`,
    );
  }

  const calendarId = parts[0].trim();
  if (!calendarId) {
    throw new Error(`${at} has no calendar ID before the ":"`);
  }
  if (!CALENDAR_ID_PATTERN.test(calendarId)) {
    throw new Error(
      `${at} calendar ID "${calendarId}" must be a bare Luma calendar ID — letters, digits, underscores and hyphens only, not a URL`,
    );
  }

  const slug = parts[1].trim();
  if (!slug) {
    throw new Error(`${at} has no slug after the ":"`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `${at} slug "${slug}" must be lowercase letters, digits and single hyphens — it appears in the API path`,
    );
  }

  return { slug, calendarId };
}
