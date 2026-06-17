import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Allow the Angular dev server (and any local origin) to call the API.
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
