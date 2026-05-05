/**
 * Single source of truth: v2 design document §3.1 (dataset model)
 *
 * R3 rule 1: frontend never constructs datasetId, only types it.
 * datasetId is assembled by backend build_dataset_ids.
 */
import { z } from 'zod';

export const DatasetScope = {
  L1_COMMON: 'L1_共通',
  L1_CATTLE_FENCE_INDUSTRY: 'L1_牛栏网_行业',
  L2_CATTLE_FENCE_PRODUCT: 'L2_牛栏网_产品',
  L3_LIANJIA_CATTLE_FENCE: 'L3_联佳丝网_牛栏网',
} as const;
export type DatasetScope = (typeof DatasetScope)[keyof typeof DatasetScope];

export type DatasetId = string & { readonly __brand: 'DatasetId' };

export const DatasetRefSchema = z.object({
  scope: z.enum([
    'L1_共通',
    'L1_牛栏网_行业',
    'L2_牛栏网_产品',
    'L3_联佳丝网_牛栏网',
  ]),
  dataset_id: z.string(),
});

export type DatasetRef = z.infer<typeof DatasetRefSchema>;
