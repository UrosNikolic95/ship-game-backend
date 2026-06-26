import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Allow the Angular dev server (and any local origin) to call the API, and to
  // send/receive the session cookie. Credentialed CORS can't use a wildcard
  // origin, so we reflect the request's origin instead.
  app.enableCors({ origin: true, credentials: true });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
