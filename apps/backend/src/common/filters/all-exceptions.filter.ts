import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '服务器内部错误';
    if (exception instanceof HttpException) {
      const r = exception.getResponse();
      message = typeof r === 'string' ? r : ((r as any).message ?? exception.message);
      if (Array.isArray(message)) message = message.join('；');
    } else if (exception instanceof Error) {
      this.logger.error(`${request.method} ${request.url} -> ${exception.message}`, exception.stack);
      message = env0(exception);
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}

function env0(e: Error): string {
  // 生产环境不暴露内部堆栈细节
  return process.env.NODE_ENV === 'production' ? '服务器内部错误' : e.message;
}
