import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LumaModule } from '../luma';
import { EVENTS_CALENDARS, parseCalendars } from './events.calendars';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [LumaModule],
  controllers: [EventsController],
  providers: [
    {
      provide: EVENTS_CALENDARS,
      inject: [ConfigService],
      // Parsed once at startup, so malformed config fails the boot rather than
      // every request.
      useFactory: (config: ConfigService) =>
        parseCalendars(config.get<string>('EVENTS_CALENDARS')),
    },
    EventsService,
  ],
})
export class EventsModule {}
