import type { EventInfo } from './events.service';

/** One property line of an iCalendar component: NAME;PARAM=…:value. */
export interface ContentLine {
  name: string;
  params: Map<string, string>;
  value: string;
}

/** 20250604T173000Z or 20250604T173000 (the trailing Z marks UTC). */
const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
/** 20250604 — an all-day date, no time or zone at all. */
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * Luma does not export a URL property; the event's page link only appears
 * inside the DESCRIPTION text ("Get up-to-date information at: https://…").
 * Matched against the unescaped text, where \n has become a real newline.
 */
export const LUMA_LINK_PATTERN =
  /https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[^\s"'<>]+/;

/**
 * The host is also only in the description, as the templated final line
 * "Hosted by {NAME}" — where {NAME} may list several people ("AIsling Krewer
 * & Liam Krewer"). Anchored to the last line so a stray "Hosted by" inside
 * free-form text cannot match; events without the line simply have no host.
 */
export const HOST_PATTERN = /(?:^|\n)Hosted by ([^\n]+?)\s*$/;

export const stackOf = (err: unknown): string =>
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
export const eventsEqual = (a: EventInfo[], b: EventInfo[]): boolean =>
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
export const unescapeText = (value: string): string =>
  value.replace(/\\(.)/g, (_match, ch: string) =>
    ch === 'n' || ch === 'N' ? '\n' : ch,
  );

/**
 * Undo iCalendar line folding: a CRLF (or bare LF) followed by a space or tab
 * continues the previous line, and the break plus that one character vanish.
 */
export const unfold = (ics: string): string => ics.replace(/\r?\n[ \t]/g, '');

/**
 * Split one content line into name, parameters and value. The value separator
 * is the first colon outside double quotes — a colon inside a quoted parameter
 * (ORGANIZER;CN="a:b":…) or inside the value itself (URLs) is data, not
 * structure. Returns undefined for a line with no separator at all.
 */
export const parseContentLine = (line: string): ContentLine | undefined => {
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
export const parseIcsDate = (
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
