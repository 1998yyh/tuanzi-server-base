import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // 关闭默认 bodyParser，手动配置以放宽 JSON 上限：
    // 画布文档是单列大 JSON，express 默认 100kb 会成为「无限画布」保存的隐性天花板
    bodyParser: false,
  });

  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  // 静态文件服务 - 封面上传
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
    setHeaders: (res) => {
      // 存储型 XSS 防护：禁止浏览器嗅探响应类型、禁用脚本执行
      // （上传文件扩展名已由服务端白名单校验，这里是纵深防御）
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    },
  });

  // 全局验证管道
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // CORS 配置：配置了白名单域名才允许携带凭证；
  // 未配置时放开 origin 但关闭 credentials（origin: '*' 与 credentials: true 互斥，浏览器会拒绝）
  const corsOrigins = process.env.CORS_ORIGINS?.split(',').filter(Boolean);
  if (corsOrigins?.length) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  } else {
    app.enableCors({ origin: '*' });
  }

  // API 前缀
  app.setGlobalPrefix('api');

  // Swagger 文档（仅非生产环境暴露）
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('团子后台服务 API')
      .setDescription('团子后台基础服务 API 文档')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 Application is running on: http://localhost:${port}/api`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
  }
}
bootstrap();
