import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formDefaults } from '../form-utils';

describe('formDefaults', () => {
  it('returns resolver with zodResolver for the given schema', () => {
    const schema = z.object({ name: z.string() });
    const result = formDefaults(schema);
    expect(result.resolver).toBeDefined();
    expect(typeof result.resolver).toBe('function');
  });

  it('merges overrides into returned props', () => {
    const schema = z.object({ name: z.string() });
    const result = formDefaults(schema, {
      defaultValues: { name: 'test' },
      mode: 'onChange' as const,
    });
    expect(result.resolver).toBeDefined();
    expect(result.defaultValues).toEqual({ name: 'test' });
    expect(result.mode).toBe('onChange');
  });
});
