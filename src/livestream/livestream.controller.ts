import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { LivestreamInfoResponse } from './livestream.response';
import { LivestreamService } from './livestream.service';

@ApiTags('livestream')
@Controller('livestream')
export class LivestreamController {
  constructor(private readonly livestream: LivestreamService) {}

  @Get()
  @ApiOperation({
    summary: 'List the livestream status of every tracked channel',
    description:
      'One entry per configured channel, in configuration order. Channels with ' +
      'nothing to report are still listed, with status "none".',
  })
  @ApiOkResponse({
    description: 'The current status of every tracked channel.',
    type: LivestreamInfoResponse,
    isArray: true,
  })
  getAll(): LivestreamInfoResponse[] {
    return this.livestream.getAll();
  }

  @Get(':slug')
  @ApiOperation({
    summary: "Get one channel's livestream status",
    description:
      "Reports the channel's live stream, else its soonest upcoming one, else " +
      'the most recent one that ended within the last 24 hours.',
  })
  @ApiParam({
    name: 'slug',
    description:
      'Slug of a configured channel, as served in the "channel" field.',
    example: 'home-assistant',
  })
  @ApiOkResponse({
    description: "The channel's current status.",
    type: LivestreamInfoResponse,
  })
  @ApiNotFoundResponse({
    description: 'No channel is configured with that slug.',
  })
  getStatus(@Param('slug') slug: string): LivestreamInfoResponse {
    return this.livestream.getStatus(slug);
  }
}
