/**
 * 平台产品品类枚举（未来应支持租户自定义）
 * 当前支持的品类：牛栏网、勾花网、立柱、石笼网
 * 牛栏网子类型：拧编规格（上疏下密）/ 环扣规格（鹿网）
 * Reference: v2 design document §2.2 (business domain)
 */
import { z } from 'zod';

export const ProductCategory = {
  牛栏网: '牛栏网',
  勾花网: '勾花网',
  立柱: '立柱',
  石笼网: '石笼网',
} as const;
export type ProductCategory = (typeof ProductCategory)[keyof typeof ProductCategory];

export const ProductCategorySchema = z.enum(['牛栏网', '勾花网', '立柱', '石笼网']);
