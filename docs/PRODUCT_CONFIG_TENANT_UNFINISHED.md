# 产品定义配置化（租户级）—— 未完成事项说明

> **更新（2026-10-10）**：已实施 `tenant_products` 表 + `TenantProductLoader` 加载器。
> 权限矩阵（租户开通报价工位后选择启用产品）**仍未实现**，留口子。

## 现状

产品知识（规格轴、变体包、公式、成本口径、列定义）目前以 **Python 代码**定义：
`backend/orchestrator/app/services/export_quote/products/field_fence.py`

```python
@register("field_fence")
def build_spec() -> ProductSpec:
    return ProductSpec(
        key="field_fence",
        name="牛栏网",
        axes=[Axis("height_m", (1.2, 1.5), "网高(m)")],
        variants=[VariantGroup("inner_wire", (...))],
        derived=[FormulaSpec("weight_base_kg", "0.00617 * ...")],
        ...
    )
```

新增产品 = 写一个 Python 文件 + 重启服务。**不支持运行时动态新增**。

## 目标

将 `ProductSpec` 配置化，支持：
1. **租户级产品管理**：租户开通报价工位后，可选择添加/启用某些产品
2. **可视化编辑**：管理界面配置规格轴、变体、公式、成本口径
3. **权限控制**：产品定义可设为「系统级」（所有租户可见）或「租户级」（仅本租户）

## 设计（待实现）

### 数据结构

```sql
CREATE TABLE tenant_products (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_key TEXT NOT NULL,          -- 稳定标识（如 field_fence）
    product_name TEXT NOT NULL,
    product_name_en TEXT,
    category_code TEXT,
    cost_field TEXT DEFAULT 'raw_price',
    cost_basis TEXT DEFAULT 'pretax',   -- pretax | incl_tax
    cost_unit TEXT,
    -- 产品级利润配置（优先级：产品级 > 报价单级 > 税务档案）
    profit_mode TEXT DEFAULT 'margin_on_price',
    profit_value NUMERIC DEFAULT 0.06,
    misc_fee_rate NUMERIC DEFAULT 0.03,
    -- 完整 ProductSpec（JSONB，含 axes/variants/derived/columns/invariants）
    spec JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(tenant_id, product_key)
);
```

### 加载优先级

```
1. tenant_products 表（租户级，按 tenant_id 过滤）
2. products/ 目录的 Python 定义（系统级兜底）
```

### 权限设计（**未完成**）

> ⚠️ **本节为未完成事项，留口子但尚未实现。**

- **系统级产品**：所有租户可见，仅平台管理员可编辑
- **租户级产品**：仅本租户可见，租户管理员可编辑
- **租户开通控制**：租户开通报价工位后，可选择「启用」某些产品（多对多关系）
- **权限矩阵**：见 `docs/WORKSTATION_DESIGN.md` §10.3（待补充）

当前实现：`ProductSpec.profit_mode/profit_value/misc_fee_rate` 已支持产品级配置，
但**加载来源只有 Python 代码**，未接数据库。接线工作待后续完成。

## 实施步骤（部分完成）

1. [x] 建 `tenant_products` 表（迁移 `202610100006`）
2. [x] `TenantProductLoader` 加载逻辑（先查数据库，再回退 Python 定义）
3. [ ] 管理界面：产品列表 + 可视化编辑器（规格轴/变体/公式）
4. [ ] 权限控制：租户开通报价工位 → 选择启用产品
5. [ ] 租户级 vs 系统级产品权限矩阵

## 关联决策

- **利润默认用利润率形式**（`margin_on_price`）：`售价 = 成本 ÷ (1 − 利润率 − 综合税费系数)`
- **产品级利润配置优先**：产品定义了 `profit_mode/profit_value/misc_fee_rate` 时，
  若报价单未显式覆盖，则用产品级值
- **利润字段精简为利润率**：不再暴露「固定额 vs 比率」双模式，统一为利润率（%）
