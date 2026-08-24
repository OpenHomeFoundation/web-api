import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { CalendarInfoResponse } from './events.response';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @ApiOperation({
    summary: 'List every tracked calendar with its events',
    description:
      'One entry per configured Luma calendar, in configuration order. ' +
      'Calendars with nothing to report are still listed, with an empty ' +
      'event list.',
  })
  @ApiOkResponse({
    description: 'Every tracked calendar and its events.',
    type: CalendarInfoResponse,
    isArray: true,
  })
  getAll(): CalendarInfoResponse[] {
    return this.events.getAll();
  }

  @Get(':slug')
  @ApiOperation({
    summary: "Get one calendar's events",
    description:
      "Every event the calendar's Luma feed advertises, soonest first — " +
      'including past ones, so the consumer decides the window it shows.',
  })
  @ApiParam({
    name: 'slug',
    description:
      'Slug of a configured calendar, as served in the "calendar" field.',
    example: 'home-assistant-meetups',
  })
  @ApiOkResponse({
    description: "The calendar's events.",
    type: CalendarInfoResponse,
  })
  @ApiNotFoundResponse({
    description: 'No calendar is configured with that slug.',
  })
  getCalendar(@Param('slug') slug: string): CalendarInfoResponse {
    return this.events.getCalendar(slug);
  }
}
