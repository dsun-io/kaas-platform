/**
 * Single source of truth: backend/orchestrator/config/tenants.yaml product_categories
 * Reference: v2 design document §2.2 (business domain)
 *
 * 联凯五金 product category enum. W0 MVP uses 牛栏网 only.
 */
import { z } from 'zod';

export const ProductCategory = {
  牛栏网: '牛栏网',
  石笼网: '石笼网',
  镀锌: '镀锌',
  包塑: '包塑',
} as const;
export type ProductCategory = (typeof ProductCategory)[keyof typeof ProductCategory];

export const ProductCategorySchema = z.enum(['牛栏网', '石笼网', '镀锌', '包塑']);
