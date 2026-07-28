import { ApiProperty } from '@nestjs/swagger';

import { LivestreamInfo, LivestreamStatus } from './livestream.service';

/**
 * Every member of the status union, with what it means. Typed as a Record so a
 * new LivestreamStatus fails to compile until it is documented here.
 */
const STATUS_DESCRIPTIONS: Record<LivestreamStatus, string> = {
  live: 'a stream is on air now',
  upcoming: 'a stream is scheduled',
  past: 'a stream ended within the last 24 hours',
  none: 'nothing to report for this channel',
};

export const LIVESTREAM_STATUSES = Object.keys(
  STATUS_DESCRIPTIONS,
) as LivestreamStatus[];

const STATUS_DESCRIPTION = `The channel's reportable state: ${Object.entries(
  STATUS_DESCRIPTIONS,
)
  .map(([status, meaning]) => `\`${status}\` — ${meaning}`)
  .join('; ')}.`;

/**
 * The documented shape of a channel's livestream status.
 *
 * `LivestreamInfo` is an interface, and interfaces leave no runtime metadata for
 * `@nestjs/swagger` to read, so the served schema lives here instead. The
 * service keeps returning plain `LivestreamInfo` objects; the controller only
 * declares this class as its response type, which is what puts the schema in the
 * spec. Nothing is instantiated or copied at runtime.
 *
 * Drift is a compile error in both directions: `implements` requires every
 * documented field to exist on `LivestreamInfo`, and the controller assigning a
 * `LivestreamInfo` to this type requires every field here to be one the service
 * actually serves.
 */
export class LivestreamInfoResponse implements LivestreamInfo {
  @ApiProperty({
    description: 'Channel slug, e.g. "home-assistant".',
    example: 'home-assistant',
  })
  channel!: string;

  @ApiProperty({
    description: 'Human-friendly channel name, as YouTube reports it.',
    example: 'Home Assistant',
  })
  channelName!: string;

  @ApiProperty({
    description: STATUS_DESCRIPTION,
    enum: LIVESTREAM_STATUSES,
    example: 'live',
  })
  status!: LivestreamStatus;

  @ApiProperty({
    description: 'Title of the reported stream. Absent when status is "none".',
    example: 'Home Assistant 2026.8 Release Party',
    required: false,
  })
  title?: string;

  @ApiProperty({
    description:
      'Watch URL of the reported stream. Absent when status is "none".',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    required: false,
  })
  url?: string;

  @ApiProperty({
    description:
      'ISO 8601 scheduled start time; present for "upcoming" streams and ' +
      'retained for "live" ones that were scheduled ahead of time.',
    example: '2026-08-01T17:00:00.000Z',
    format: 'date-time',
    required: false,
  })
  startTime?: string;

  @ApiProperty({
    description:
      "ISO 8601 timestamp of when this channel's reported state last changed.",
    example: '2026-07-27T12:00:00.000Z',
    format: 'date-time',
  })
  updatedAt!: string;
}
