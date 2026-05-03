import { apiClient } from '@/lib/api/client';
import type { EventType } from '@contracts/events';

const OSS_SIZE_THRESHOLD = 10240; // 10 KB

/**
 * If payload JSON exceeds 10 KB, upload via OSS presign and return { _oss_key }.
 * Otherwise return the payload directly.
 */
export async function maybeUploadOssIfLarge(
  payload: unknown,
): Promise<unknown> {
  try {
    const json = JSON.stringify(payload);
    if (json.length <= OSS_SIZE_THRESHOLD) {
      return payload;
    }

    // Upload via OSS presign
    const { data } = await apiClient.post<{ presigned_url: string; key: string }>(
      '/oss/presign',
      {
        content_type: 'application/json',
        content_length: json.length,
      },
    );

    await fetch(data.presigned_url, {
      method: 'PUT',
      body: json,
      headers: { 'Content-Type': 'application/json' },
    });

    return { _oss_key: data.key };
  } catch (err) {
    console.error('[events/client] OSS upload failed:', err);
    // Fallback: return payload directly if OSS unavailable
    return payload;
  }
}

/**
 * POST /api/v1/events — create a single event.
 * Never called directly from UI; use useCreateEvent for queue-based writes.
 */
export async function createEvent(body: {
  schema_version: number;
  event_type: EventType;
  event_source: 'frontend' | 'backend';
  tenant_id?: string;
  actor_id?: string;
  session_id?: string;
  trace_id?: string;
  payload: unknown;
}): Promise<{ id: string }> {
  const processed = await maybeUploadOssIfLarge(body.payload);

  const { data } = await apiClient.post<{ id: string }>('/events', {
    ...body,
    payload: processed,
  });

  return data;
}
