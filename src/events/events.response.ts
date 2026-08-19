import { ApiProperty } from '@nestjs/swagger';

import {
  CalendarInfo,
  EVENT_STATUSES,
  EventInfo,
  EventStatus,
} from './events.service';

/**
 * What each member of the status union means. The values themselves live in
 * the service's EVENT_STATUSES, the single source of truth for parsing and
 * this schema alike; the Record keys make a status added there fail to compile
 * until it is documented here.
 */
const STATUS_DESCRIPTIONS: Record<EventStatus, string> = {
  confirmed: 'the event is definitely happening',
  tentative: 'the event is planned but not final',
  cancelled: 'the event was called off',
};

const STATUS_DESCRIPTION = `The event's iCalendar status: ${EVENT_STATUSES.map(
  (status) => `\`${status}\` — ${STATUS_DESCRIPTIONS[status]}`,
).join('; ')}. Absent when the feed does not carry one.`;

/**
 * The documented shape of one event.
 *
 * `EventInfo` is an interface, and interfaces leave no runtime metadata for
 * `@nestjs/swagger` to read, so the served schema lives here instead — see
 * LivestreamInfoResponse for the full rationale. Drift is a compile error in
 * both directions: `implements` requires every documented field to exist on
 * `EventInfo`, and the controller assigning service objects to these types
 * requires every field here to be one the service actually serves.
 */
export class EventInfoResponse implements EventInfo {
  @ApiProperty({
    description: "Stable event identifier, the feed's UID.",
    example: 'evt-HJ5eO3aJOiCob3z@events.lu.ma',
  })
  id!: string;

  @ApiProperty({
    description: 'Event title.',
    example: 'Dublin - Hosted by the OHF',
  })
  summary!: string;

  @ApiProperty({
    description:
      'ISO 8601 start: a UTC date-time for timed events, a bare date ' +
      '(YYYY-MM-DD) for all-day ones.',
    example: '2026-06-04T17:30:00.000Z',
  })
  start!: string;

  @ApiProperty({
    description:
      'ISO 8601 end, in the same form as "start". Absent when the feed ' +
      'omits it.',
    example: '2026-06-04T20:30:00.000Z',
    required: false,
  })
  end?: string;

  @ApiProperty({
    description: "The event's description, as the feed carries it.",
    example: 'Get up-to-date information at: https://luma.com/n5mzdtvb',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'Human-readable venue or address.',
    example: '26 Wexford St, Portobello, Dublin, D02 HX93, Ireland',
    required: false,
  })
  location?: string;

  @ApiProperty({
    description: "The event's Luma page.",
    example: 'https://luma.com/n5mzdtvb',
    required: false,
  })
  url?: string;

  @ApiProperty({
    description:
      'Venue latitude in decimal degrees, when the feed carries coordinates.',
    example: 53.336691,
    required: false,
  })
  latitude?: number;

  @ApiProperty({
    description:
      'Venue longitude in decimal degrees, when the feed carries coordinates.',
    example: -6.26573,
    required: false,
  })
  longitude?: number;

  @ApiProperty({
    description: STATUS_DESCRIPTION,
    enum: [...EVENT_STATUSES],
    example: 'confirmed',
    required: false,
  })
  status?: EventStatus;
}

/** The documented shape of one calendar and its events. */
export class CalendarInfoResponse implements CalendarInfo {
  @ApiProperty({
    description: 'Calendar slug, e.g. "home-assistant-meetups".',
    example: 'home-assistant-meetups',
  })
  calendar!: string;

  @ApiProperty({
    description: 'Human-friendly calendar name, as the Luma feed reports it.',
    example: 'Home Assistant Meetups',
  })
  calendarName!: string;

  @ApiProperty({
    description:
      'Every event the feed advertises, soonest first — including past ' +
      'ones, so the consumer decides the window it shows.',
    type: EventInfoResponse,
    isArray: true,
  })
  events!: EventInfoResponse[];

  @ApiProperty({
    description:
      "ISO 8601 timestamp of when this calendar's served content last changed.",
    example: '2026-08-18T12:00:00.000Z',
    format: 'date-time',
  })
  updatedAt!: string;
}
