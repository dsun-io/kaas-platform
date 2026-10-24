/**
 * 产品注册表**展示字段**镜像（数据镜像，不是第二份实现）。
 *
 * 真源 = backend/kaas_common/export_quote/products/{chain_link,deer_net,field_fence}.py 里
 * `ProductSpec(key=, name=, name_en=, category_code=)` 四个标量；注册表本身
 * （products/__init__.py:38 `keys()`）返回 `sorted(_REGISTRY)`。
 *
 * 为什么需要：`GET /api/v1/products`（ws_files.py:385-431）的 items 来自**代码注册表**
 * （产品定义人人可读，Q1=B），DB 里只有团队可编辑的图片数 / 资料（product_profiles）。
 * P0 要让产品页首屏不依赖 Python 冷启动，就必须在 TS 侧拿到这 4 个展示标量。
 *
 * ⚠️ 镜像边界（刻意很窄）：
 * - **只**镜像列表页用到的 `key/name/name_en/category_code`；
 * - 引擎内容（axes / variants / formulas / pricing_key / numeric_inputs …）**不镜像** ——
 *   报价、单证、spec 校验仍然只在 Python（backend/kaas_common/export_quote/**）一处实现；
 * - 本文件**不参与任何计算**，只被 /products 列表拼装使用；新增真实产品时必须同步这里，
 *   tests/product-registry.test.ts 用固定快照锁死当前 3 个产品的标量，漂移会红。
 *
 * TODO(TODO:TS1)：与 generated/schemas.ts 同一条生成流水线，从 Python 注册表自动产出
 * （或由内核暴露只读 `/internal/product-registry` 后改走 Service Binding）。
 */
export interface ProductRegistryEntry {
  /** ProductSpec.key（注册表登记 key） */
  key: string;
  /** ProductSpec.name（中文名；展示回落 key） */
  name: string;
  /** ProductSpec.name_en（英文名；团队资料没配英文名时是唯一来源） */
  nameEn: string;
  /** ProductSpec.category_code（品类编码，前端下拉/筛选用） */
  categoryCode: string;
}

/** 逐条对应 products/*.py 的 ProductSpec 标量（行号见注释）。 */
const ENTRIES: readonly ProductRegistryEntry[] = [
  // backend/kaas_common/export_quote/products/chain_link.py:47-50
  { key: "chain_link", name: "勾花网", nameEn: "Chain Link Fence", categoryCode: "gouhuawang" },
  // backend/kaas_common/export_quote/products/deer_net.py:58-61
  { key: "deer_net", name: "鹿网", nameEn: "Deer Net", categoryCode: "luwang" },
  // backend/kaas_common/export_quote/products/field_fence.py:51-54
  { key: "field_fence", name: "牛栏网", nameEn: "Field Fence", categoryCode: "niulanwang" },
];

/** key → 标量（同名注册表；重复 key 视为编程错误，由构造时的 Map 覆盖暴露）。 */
export const PRODUCT_REGISTRY: Record<string, ProductRegistryEntry> = Object.fromEntries(
  ENTRIES.map((entry) => [entry.key, entry]),
);

/** products/__init__.py:38 `keys()` = `sorted(_REGISTRY)`：列表顺序口径（必须稳定）。 */
export const PRODUCT_KEYS: readonly string[] = ENTRIES.map((entry) => entry.key).sort();
