import { Module } from '@nestjs/common';

import { LivestreamController } from './livestream.controller';
import { LivestreamService } from './livestream.service';

@Module({
  controllers: [LivestreamController],
  providers: [LivestreamService],
})
export class LivestreamModule {}
