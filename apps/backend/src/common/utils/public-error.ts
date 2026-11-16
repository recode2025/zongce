import { HttpException } from '@nestjs/common';
import { OPERATION_FAILED_MESSAGE, publicErrorText, TASK_FAILED_MESSAGE } from '@zc/shared';

/** Unexpected exception details stay in server logs in every environment. */
export function publicExceptionMessage(error: unknown, fallback = OPERATION_FAILED_MESSAGE): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    return publicErrorText(typeof response === 'string' ? response : (response as { message?: unknown }).message, fallback);
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return ['P2002', 'P2003', 'P2025'].includes(String(code)) ? publicErrorText(code, fallback) : fallback;
}

/** Sanitize failures saved before this fix without changing historical records. */
export function publicJob<T extends { error?: string | null }>(job: T): T {
  return { ...job, error: job.error ? publicErrorText(job.error, TASK_FAILED_MESSAGE) : job.error };
}
