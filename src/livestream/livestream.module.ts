import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { YouTubeModule } from '../youtube';
import { LIVESTREAM_CHANNELS, parseChannels } from './livestream.channels';
import { LivestreamController } from './livestream.controller';
import { LivestreamService } from './livestream.service';

@Module({
  imports: [YouTubeModule],
  controllers: [LivestreamController],
  providers: [
    {
      provide: LIVESTREAM_CHANNELS,
      inject: [ConfigService],
      // Parsed once at startup, so malformed config fails the boot rather than
      // every request.
      useFactory: (config: ConfigService) =>
        parseChannels(config.get<string>('LIVESTREAM_CHANNELS')),
    },
    LivestreamService,
  ],
})
export class LivestreamModule {}
