import { Module } from '@nestjs/common';

import { YouTubeClient } from './youtube.client';

/**
 * The YouTube API client, shared by whichever feature modules read from
 * YouTube. Feature modules import this rather than talking to the Data API or
 * the channel feeds themselves, so the key handling and transport live in one
 * place.
 */
@Module({
  providers: [YouTubeClient],
  exports: [YouTubeClient],
})
export class YouTubeModule {}
