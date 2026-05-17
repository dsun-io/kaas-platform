/**
 * 产品品类验证规则 — 各品类所需的规格字段。
 *
 * @deprecated 新规格系统使用 category_attribute_bindings 动态驱动验证。
 * 旧字段验证保留用于向后兼容老报价流程。
 * 新流程请使用 BindingWithAttribute.is_required 进行校验。
 */
import { ProductCategory } from './categories';

/** 各品类对应的必填规格字段列表（向后兼容）。 */
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

/**
 * 基于 bindings 的动态验证。
 * 用于新规格系统的 Wizard 和表单。
 */
export function validateSpecValuesFromBindings(
  specValues: Record<string, unknown>,
  bindings: { attribute: { id: number; code: string; name: string }; is_required: boolean }[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const b of bindings) {
    if (b.is_required) {
      const v = specValues[b.attribute.code] ?? specValues[String(b.attribute.id)];
      if (v === undefined || v === null || v === '') {
        errors.push(`${b.attribute.name} 为必填项`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
