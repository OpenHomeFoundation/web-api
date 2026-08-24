import { Module } from '@nestjs/common';

import { LumaClient } from './luma.client';

/**
 * The Luma API client, shared by whichever feature modules read from Luma.
 * Feature modules import this rather than talking to api.luma.com themselves,
 * so the transport lives in one place.
 */
@Module({
  providers: [LumaClient],
  exports: [LumaClient],
})
export class LumaModule {}
