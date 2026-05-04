import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { createCorsOptions, parseCorsOrigins } from './cors.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigins = parseCorsOrigins();

  if (process.env.NODE_ENV === 'production' && corsOrigins.length === 0) {
    console.warn('No CORS origins configured. Set FRONTEND_URL or CORS_ORIGINS for browser clients.');
  }

  // app.enableCors(createCorsOptions(corsOrigins));
  app.enableCors({
    origin: 'https://freewheel-5a.vercel.app/', // URL de tu frontend
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true, // Permitir cookies
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

