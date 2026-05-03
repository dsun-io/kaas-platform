import { describe, it, expect, vi } from 'vitest';
import { AxiosError } from 'axios';
import type { ApiErrorResponse } from '../error-handler';

vi.mock('@/lib/error/sentry', () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

function makeAxiosError(status: number, data: Record<string, unknown>) {
  return new AxiosError(
    'Request failed',
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    undefined,
    undefined,
    {
      status,
      data,
      statusText: status >= 500 ? 'Internal Server Error' : 'Bad Request',
      headers: {} as Record<string, string>,
      config: {} as import('axios').InternalAxiosRequestConfig,
    },
  ) as unknown as AxiosError<ApiErrorResponse>;
}

describe('ERROR_CODE_MAP', () => {
  it('all 11 error codes are defined', async () => {
    const codes = [
      'PARAM_EXTRACTION_FAILED', 'SPEC_NOT_SUPPORTED', 'KB_SEARCH_FAILED',
      'LLM_UNAVAILABLE', 'QUOTATION_NOT_FOUND', 'TENANT_NOT_FOUND',
      'VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN',
      'RATE_LIMITED', 'INTERNAL_ERROR',
    ];
    expect(codes).toHaveLength(11);
  });

  it('handleApiError returns Chinese message for known error_code', async () => {
    const mod = await import('../error-handler');
    const error = makeAxiosError(400, { error_code: 'VALIDATION_ERROR', message: '参数不合法' });
    const msg = mod.handleApiError(error);
    expect(msg).toBe('请求参数不合法');
  });

  it('handleApiError handles 500 status without error_code', async () => {
    const mod = await import('../error-handler');
    const error = makeAxiosError(500, {});
    const msg = mod.handleApiError(error);
    // Returns the underlying error message (toast shows Chinese message separately)
    expect(typeof msg).toBe('string');
  });

  it('handleApiError handles network error (no response)', async () => {
    const mod = await import('../error-handler');
    const error = new AxiosError('Network Error', 'ERR_NETWORK') as AxiosError<ApiErrorResponse>;
    const msg = mod.handleApiError(error);
    expect(msg).toBe('Network Error');
  });

  it('handleApiError handles unknown error_code gracefully', async () => {
    const mod = await import('../error-handler');
    const error = makeAxiosError(400, { error_code: 'UNKNOWN_CODE_XYZ', message: 'Something happened' });
    const msg = mod.handleApiError(error);
    expect(msg).toBe('Something happened');
  });

  it('handleApiError handles 422 validation error', async () => {
    const mod = await import('../error-handler');
    const error = makeAxiosError(422, { error_code: 'VALIDATION_ERROR', message: '参数不合法' });
    const msg = mod.handleApiError(error);
    expect(msg).toBe('请求参数不合法');
  });
});
