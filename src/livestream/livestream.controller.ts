import { Controller, Get, Param } from '@nestjs/common';

import { LivestreamInfo, LivestreamService } from './livestream.service';

@Controller('livestream')
export class LivestreamController {
  constructor(private readonly livestream: LivestreamService) {}

  @Get()
  getAll(): LivestreamInfo[] {
    return this.livestream.getAll();
  }

  @Get(':slug')
  getStatus(@Param('slug') slug: string): LivestreamInfo {
    return this.livestream.getStatus(slug);
  }
}
