import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // YouTube WebSub pushes arrive as Atom XML; register a raw parser for those
  // content types so the /pubsub handler receives the exact bytes (needed for
  // HMAC signature verification).
  app.useBodyParser('raw', {
    type: ['application/atom+xml', 'application/xml', 'text/xml'],
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}
bootstrap();
