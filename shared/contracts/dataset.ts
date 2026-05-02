/**
 * Single source of truth: v2 design document §3.1 (dataset model)
 *
 * R3 铁律1: 前端不构造 datasetId，只定义类型。
 * datasetId 由后端 build_dataset_ids 拼，前端只接收。
 */

export type DatasetScope = 'L1_共通' | 'L1_牛栏网_行业' | 'L2_牛栏网_产品' | 'L3_联凯_牛栏网';

export type DatasetId = string & { readonly __brand: 'DatasetId' };

export interface DatasetRef {
  scope: DatasetScope;
  dataset_id: DatasetId;
}
