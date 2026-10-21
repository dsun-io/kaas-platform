# 产品定义配置化（租户级）—— 已完成事项说明（原「未完成清单」）

> **✅ 状态（2026-10-21）：本文列举的未完成项已全部收口，保留作实现口径与验收记录。**
> 活跃待办以 [`docs/TODO.md`](./TODO.md) 为准；产品配置化的当前状态见 TODO §B（B1/B2/B3/B4/B5/B6 全部 ✅）。
>
> **更新（2026-10-10 续做）**：
> - 权限矩阵 API 已**落到生产 Worker**（`backend/worker/src/ws_products.py`，8 条路由：
>   `/tenant-products` CRUD 4 条 + `/workstation-products` 2 条 + `/tenant-product-status` 2 条）。
> - **工位订阅校验已完成**：报价工位按 `full_chain` 校验，未订阅 → 404
>   `SUBSCRIPTION_REQUIRED` 且不写任何数据（共享内核 `kaas_common/workstation/subscriptions.py`
>   为工位→路径映射真源，worker `ws_workstations.py` 提供团队/个人订阅端点）。
> - **租户隔离口径两端统一**：列表 = 本团队/本租户 + 系统级产品；跨租户改/删一律 404
>   （不泄露存在性）；系统级产品改/删一律 403。
> - **✅ 租户开通报价工位 UI 交互已完成（2026-10-21）**：`frontend/src/app/(app)/team/components/team-subscriptions-panel.tsx`
>   （管理员开通/撤销，PUT 后重拉列表）+ 产品页启用开关。端到端验收：`PUT /teams/1/subscriptions/full_chain`
>   后同一进程内 `/me/workstations` codes `[]→["full_chain"]`、中间件门从 404 变放行；`DELETE` 后立即回退。
> - ~~产品定义可视化编辑器~~ → ✅ **已完成**（2026-10-17，P16 三小步：数值参数/变体/
>   公式表单 → 列/校验/扣减 → 参数/说明/常量 + 公式试算；JSON 保留为高级模式）。

## 现状

产品知识（规格轴、变体包、公式、成本口径、列定义）的系统级底座仍是 **Python 代码**定义
（唯一源：`backend/kaas_common/export_quote/products/field_fence.py`；`backend/orchestrator`
在 S4 后只剩迁移与 ORM，**不再有 `app/services/export_quote/`**）：

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

**租户级产品**（2026-10-21 已端到端验收）：`tenant_products` 表 + `spec` JSONB，每请求读库；
新增/改租户产品**无需改代码或重启**。**系统级**新增产品仍需写 Python 注册表（4 个）——这是
§G-3 待用户拍板的口径，不是缺陷。

## 目标

将 `ProductSpec` 配置化，支持：
1. **租户级产品管理**：租户开通报价工位后，可选择添加/启用某些产品
2. **可视化编辑**：管理界面配置规格轴、变体、公式、成本口径
3. **权限控制**：产品定义可设为「系统级」（所有租户可见）或「租户级」（仅本租户）

## 设计（已按此实现，保留作数据/口径说明）

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

### 权限设计（已完成）

- **系统级产品**（`is_system=true`）：所有租户可见，仅平台管理员可编辑
  → **已实现**：列表对全部租户可见；改/删一律 403
- **租户级产品**（`is_system=false`）：仅本团队可见，团队管理员可编辑
  → **已实现（2026-10-21 B4 修复）**：跨团队/跨租户改/删一律 404（不泄露存在性）；
  `team_id IS NULL` 历史行只有无团队者本人可写（写读对称）
- **租户开通控制**：租户开通报价工位后，可选择「启用」某些产品（多对多关系）
  → **已全部完成（2026-10-21 B3/B6）**：API（`/workstation-products` + `/tenant-product-status`）
  + 前端「团队 → 订阅」面板开通/撤销 + 产品页启用开关；开通/撤销即时生效
- **权限矩阵**：见 `docs/WORKSTATION_DESIGN.md` §5.4（订阅模型）与 `docs/TODO.md` §B（B1/B4/B6 验收记录）

当前实现（S4 起）：**`TenantProductLoader` 已删除**；租户级产品由
`kaas_common/export_quote/tenant_products.py` 的 `spec_from_dict/spec_to_dict` +
worker 裸 asyncpg 查 `tenant_products`（`quote_api.py` 发现层合并）实现，
`ProductSpec.profit_mode/profit_value/misc_fee_rate` 支持产品级配置。

## 实施步骤（全部完成）

1. [x] 建 `tenant_products` 表（迁移 `202610100006`）
2. [x] 租户级加载逻辑（先查 `tenant_products`，再回退 Python 注册表）
3. [x] 管理界面：产品列表 + 表单编辑（`/settings/tenant-products`）
4. [x] 权限矩阵 API：`/api/v1/workstation-products`（启用/停用产品，多对多表 `tenant_workstation_products`）
5. [x] 租户开通报价工位 UI 交互（2026-10-21 B3：团队订阅面板开通/撤销 + 产品页启用开关，已端到端验收）
6. [x] 工位订阅校验（2026-10-10 续做完成，见上方更新说明）
7. [x] 线上 Worker 同步 `ws_products.py`（2026-10-10 续做完成，消除生产 404）

## 关联决策

- **利润默认用利润率形式**（`margin_on_price`）：`售价 = 成本 ÷ (1 − 利润率 − 综合税费系数)`
- **产品级利润配置优先**：产品定义了 `profit_mode/profit_value/misc_fee_rate` 时，
  若报价单未显式覆盖，则用产品级值
- **利润字段精简为利润率**：不再暴露「固定额 vs 比率」双模式，统一为利润率（%）
