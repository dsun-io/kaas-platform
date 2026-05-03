import { useQuery, type UseQueryOptions, type QueryFunctionContext } from '@tanstack/react-query';
import type { ZodSchema } from 'zod';
import { captureException } from '@/lib/error/sentry';

export function useSafeQuery<TData>(
  options: UseQueryOptions<TData> & {
    schema?: ZodSchema<TData>;
  },
) {
  const { schema, queryFn, ...rest } = options;

  const wrappedQueryFn = schema && queryFn && typeof queryFn === 'function'
    ? async (ctx: QueryFunctionContext) => {
        const raw = await (queryFn as (ctx: QueryFunctionContext) => Promise<TData>)(ctx);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          console.warn('[zod] Response validation failed:', parsed.error.issues);
          captureException(parsed.error, {
            queryKey: Array.isArray(rest.queryKey) ? rest.queryKey.join('/') : String(rest.queryKey),
          });
          return raw as TData;
        }
        return parsed.data;
      }
    : queryFn;

  return useQuery({ ...rest, queryFn: wrappedQueryFn });
}
