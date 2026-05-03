import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import type { UseFormProps } from 'react-hook-form';

export function formDefaults<T extends z.ZodType>(
  schema: T,
  overrides?: UseFormProps<z.infer<T>>,
): UseFormProps<z.infer<T>> {
  return {
    resolver: zodResolver(schema as unknown as Parameters<typeof zodResolver>[0]),
    ...overrides,
  };
}
