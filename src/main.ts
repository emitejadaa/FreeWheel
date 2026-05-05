import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import {  parseCorsOrigins } from './cors.config';
import cors from 'cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigins = parseCorsOrigins();

  if (process.env.NODE_ENV === 'production' && corsOrigins.length === 0) {
    console.warn(
      'No CORS origins configured. Set FRONTEND_URL or CORS_ORIGINS for browser clients.',
    );
  }

  app.use(cors({
    origin: '*', // Permitir cualquier origen
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Métodos permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Cabeceras permitidas
  }));
  
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
