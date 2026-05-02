/**
 * Single source of truth: backend/orchestrator/config/tenants.yaml product_categories
 * Reference: v2 design document §2.2 (business domain)
 *
 * 联凯五金的产品分类枚举。W0 MVP 仅使用 牛栏网。
 */

export enum ProductCategory {
  牛栏网 = '牛栏网',
  石笼网 = '石笼网',
  镀锌 = '镀锌',
  包塑 = '包塑',
}
