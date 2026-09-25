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
 * - 牛栏网 (niulanwang): 拧编类型，网孔分布固定为「拧编型上疏下密」。
 *   规格空间 = 丝径方案 × 网高 × 竖丝间距 × 镀锌量 × 工艺 = 3×2×2×2×2 = 48 个组合，
 *   权威定义见 `@contracts/niulanwang`（与后端 field_fence 产品定义一致）。
 *   注：「环扣（鹿网）」是另一套规格空间，不在这 48 组合内。
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
