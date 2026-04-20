import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    httpsOptions: {
      key: readFileSync(join(process.cwd(), 'certs/key.pem')),
      cert: readFileSync(join(process.cwd(), 'certs/cert.pem')),
    },
  });
  await app.listen(3000, '0.0.0.0');
}
bootstrap();
