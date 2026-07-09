import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  // YouTube WebSub pushes arrive as Atom XML; register a raw parser for those
  // content types so `req.rawBody` is populated for signature verification.
  app.useBodyParser('raw', {
    type: ['application/atom+xml', 'application/xml', 'text/xml'],
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}
bootstrap();
