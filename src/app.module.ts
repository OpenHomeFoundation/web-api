import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppGateway } from './app.gateway';
import { HealthModule } from './health';
import { getVersionInfo } from './health/version';
import { LivestreamModule } from './livestream';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HealthModule.register({ version: getVersionInfo() }),
    LivestreamModule,
  ],
  providers: [AppGateway],
})
export class AppModule {}
