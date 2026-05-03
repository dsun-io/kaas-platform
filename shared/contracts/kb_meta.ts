/**
 * Single source of truth: v2 design document §3.4 (knowledge base model)
 */
import { z } from 'zod';

export const KbDocumentSchema = z.object({
  id: z.string(),
  dataset_id: z.string(),
  title: z.string(),
  content: z.string(),
  metadata: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

export const KbChunkSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  dataset_id: z.string(),
  content: z.string(),
  embedding: z.array(z.number()).optional(),
  metadata: z.record(z.unknown()),
});

export const KbEditPayloadSchema = z.object({
  dataset_name: z.string(),
  chunk_id: z.string().nullable(),
  action: z.enum(['create', 'update', 'delete']),
  actor_id: z.string(),
});

export type KbDocument = z.infer<typeof KbDocumentSchema>;
export type KbChunk = z.infer<typeof KbChunkSchema>;
export type KbEditPayload = z.infer<typeof KbEditPayloadSchema>;
