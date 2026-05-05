/**
 * 产品品类验证规则 — 各品类所需的规格字段。
 *
 * 添加新品类时在此处定义其必填字段即可，
 * 前端/后端共用，无需修改组件逻辑。
 */
import { ProductCategory } from './categories';

/** 各品类对应的必填规格字段列表。 */
export const REQUIRED_SPEC_FIELDS: Record<
  string,
  { field: string; label: string }[]
> = {
  [ProductCategory.牛栏网]: [
    { field: 'product_type', label: '产品类型' },
    { field: 'wire_diameter', label: '丝径' },
    { field: 'height', label: '高度' },
    { field: 'mesh_width', label: '网孔宽度' },
    { field: 'roll_length', label: '卷长' },
  ],
  [ProductCategory.立柱]: [
    { field: 'product_type', label: '产品类型' },
    { field: 'height', label: '高度' },
  ],
};
