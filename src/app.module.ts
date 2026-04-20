import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppGateway } from './app.gateway';

@Module({
  controllers: [AppController],
  providers: [AppGateway],
})
export class AppModule {}
