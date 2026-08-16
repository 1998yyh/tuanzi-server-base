import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

/**
 * 全局异常过滤器（2026-08-15 代码审查加固）。
 *
 * ⚠️ 该过滤器当前【故意未注册】到 main.ts（注册后错误响应形状从 NestJS 默认
 * 变为 { code, message, timestamp }，会影响前端解析），启用前需先与前端确认。
 * 本文件仅保证：一旦启用，非 HttpException 的原始错误（含 SQL 片段、连接信息）
 * 不会直接泄露给客户端。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = '服务器内部错误';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else {
        const body = exceptionResponse as { message?: string | string[] };
        // class-validator 校验错误的消息是 string[]，原样透传保持前端兼容
        message = Array.isArray(body.message) ? body.message : (body.message ?? '服务器内部错误');
      }
    } else if (exception instanceof Error) {
      // 非 HttpException（DB 错误、网络错误等）一律返回通用文案，
      // 原始错误只进服务端日志，避免泄露内部细节
      console.error('[AllExceptionsFilter] 未处理异常:', exception);
      message = '服务器内部错误';
    }

    response.status(status).json({
      code: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
