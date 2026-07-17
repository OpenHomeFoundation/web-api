import { Module } from '@nestjs/common';

import { LivestreamController } from './livestream.controller';
import { LivestreamService } from './livestream.service';
import { PubSubController } from './pubsub.controller';
import { PubSubService } from './pubsub.service';

@Module({
  controllers: [LivestreamController, PubSubController],
  providers: [LivestreamService, PubSubService],
})
export class LivestreamModule {}
