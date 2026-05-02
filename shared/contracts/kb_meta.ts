/**
 * Single source of truth: v2 design document §3.4 (knowledge base model)
 */

export interface KbDocument {
  id: string;
  dataset_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KbChunk {
  id: string;
  document_id: string;
  dataset_id: string;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
}

export interface KbEditPayload {
  dataset_name: string;
  chunk_id: string | null;
  action: 'create' | 'update' | 'delete';
  actor_id: string;
}
