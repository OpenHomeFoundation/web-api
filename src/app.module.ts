import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppGateway } from './app.gateway';
import { EventsModule } from './events';
import { HealthModule } from './health';
import { getVersionInfo } from './health/version';
import { LivestreamModule } from './livestream';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HealthModule.register({ version: getVersionInfo() }),
    LivestreamModule,
    EventsModule,
  ],
  providers: [AppGateway],
})
export class AppModule {}
