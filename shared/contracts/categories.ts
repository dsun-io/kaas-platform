/**
 * 平台产品品类枚举（未来应支持租户自定义）
 *
 * 设计原则:
 * - 系统内部使用稳定 code（如 niulanwang, post）
 * - UI 展示使用中文 label（如 牛栏网, 立柱）
 * - API 传输优先使用 code
 * - 中文 label 仅用于展示，不作为长期内部匹配字段
 *
 * 当前支持的品类：
 * - 牛栏网 (niulanwang): 拧编规格（上疏下密）/ 环扣规格（鹿网）
 * - 勾花网 (gouhuawang)
 * - 立柱 (post)
 * - 石笼网 (gabion)
 *
 * Reference: v2 design document §2.2 (business domain)
 */
import { z } from 'zod';

/** 品类 code → label 映射（系统唯一真实源） */
export const CATEGORY_LABEL_MAP: Record<string, string> = {
  niulanwang: '牛栏网',
  gouhuawang: '勾花网',
  post: '立柱',
  gabion: '石笼网',
  chain_link: '勾花网',
};

/** 所有品类 code 列表（用于下拉选项 value） */
export const CATEGORY_CODES = ['niulanwang', 'gouhuawang', 'post', 'gabion'] as const;
export type CategoryCode = (typeof CATEGORY_CODES)[number];

/** code → label（类型安全） */
export const CATEGORY_LABEL: Record<CategoryCode, string> = {
  niulanwang: '牛栏网',
  gouhuawang: '勾花网',
  post: '立柱',
  gabion: '石笼网',
};

export function categoryLabel(code: string): string {
  return CATEGORY_LABEL_MAP[code] ?? code;
}

/**
 * ProductCategory — 品类常量（向后兼容）
 * 现在 value 为 code，UI 展示用 categoryLabel() 转换
 */
export const ProductCategory = {
  牛栏网: 'niulanwang' as const,
  勾花网: 'gouhuawang' as const,
  立柱: 'post' as const,
  石笼网: 'gabion' as const,
};
export type ProductCategory = (typeof ProductCategory)[keyof typeof ProductCategory];

export const ProductCategorySchema = z.enum([
  'niulanwang',
  'gouhuawang',
  'post',
  'gabion',
]);
