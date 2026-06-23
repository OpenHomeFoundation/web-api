import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppGateway } from './app.gateway';
import { HealthModule } from './health';
import { getVersionInfo } from './health/version';

@Module({
  imports: [HealthModule.register({ version: getVersionInfo() })],
  controllers: [AppController],
  providers: [AppGateway],
})
export class AppModule {}
