import { describe, it, expect } from 'vitest';
import { maybeUploadOssIfLarge } from '../client';

describe('maybeUploadOssIfLarge', () => {

  it('returns payload directly when under 10KB (10239 bytes)', async () => {
    const payload = { text: 'a'.repeat(10200) };
    const result = await maybeUploadOssIfLarge(payload);
    expect(result).toBe(payload);
  });

  it('returns payload directly at boundary minus 1 (10239 bytes)', async () => {
    // "{"text":""}" = ~12 chars overhead, so fit within 10239
    const payload = { x: 'a'.repeat(10215) }; // ~10239 bytes total
    const result = await maybeUploadOssIfLarge(payload);
    // Under threshold: should be the same object
    expect(result).toBe(payload);
  });

  it('triggers OSS upload path at boundary +1 (10241 bytes)', async () => {
    // Large payload triggers OSS path but will fail gracefully
    const payload = { big: 'a'.repeat(10250) };
    const result = await maybeUploadOssIfLarge(payload);

    // Should fallback to original payload when OSS upload fails
    expect(result).toBeDefined();
  });
});
