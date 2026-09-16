import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  app.setGlobalPrefix('api/v1');

  app.use(
    helmet({
      contentSecurityPolicy: env.isDev ? false : undefined,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin || env.corsOrigins.includes(origin) || env.isDev) cb(null, true);
      else cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  // 轻量 cookie 解析（仅用于 refresh token cookie）
  app.use((req: any, _res: any, next: () => void) => {
    const header: string = req.headers?.cookie ?? '';
    req.cookies = Object.fromEntries(
      header
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const i = s.indexOf('=');
          return i > 0 ? [s.slice(0, i), decodeURIComponent(s.slice(i + 1))] : [s, ''];
        }),
    );
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(env.port, '0.0.0.0');
  new Logger('Bootstrap').log(`zongce backend listening on :${env.port} (redis=${process.env.REDIS_URL ? 'on' : 'memory-mode'})`);
}
bootstrap();
