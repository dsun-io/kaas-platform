# 方案A：API 层业务逻辑共享包 —— 进展与剩余

## 背景

orchestrator（本地开发）与 worker（生产 Cloudflare Workers）是**两套代码**，
API 层各自维护，改动 orchestrator 不会自动同步到 worker，导致重复开发与漂移
（例：`fx-rates`/`actual-costs`/`external-docs` 在 orchestrator 有、worker 没有 → 生产 404）。

**目标**：业务逻辑抽成共享包，`sync-shared.ps1` 自动同步，消除重复开发。

## 已完成（2026-10-10）

| 模块 | 共享包 | orchestrator | worker |
|---|---|---|---|
| 单证渲染数据装配 | `kaas_common/trade_doc/payload_shared.py` | re-export ✓ | import ✓（删除 11KB 镜像） |
| 客户/询盘序列化 | `kaas_common/workstation/customer_serializers.py` | re-export ✓ | 待接线 |
| 客户业务规则 | `kaas_common/workstation/customer_rules.py` | re-export ✓ | 待接线 |
| 报价单/行项序列化 | `kaas_common/workstation/quote_serializers.py` | re-export ✓ | 待接线 |
| 订单/付款计划/应收序列化 | `kaas_common/workstation/order_serializers.py` | re-export ✓ | 待接线 |

**同步机制**：`scripts/sync-shared.ps1` 自动复制 `backend/kaas_common/` →
`backend/worker/src/kaas_common/`（CI 部署时执行，不进 git）。

## 剩余工作

### 1. worker 接线（待做）
worker 的 `main.py` 仍是 asyncpg 直连 + `dict(row)` 模式，需改为 import 共享序列化函数：
- [ ] `main.py` 客户路由 → `customer_serializers.row_to_customer`
- [ ] `main.py` 订单路由 → `order_serializers.row_to_order` 等
- [ ] `quote_api.py` 报价路由 → `quote_serializers.row_to_quote` 等

### 2. 业务规则抽取（待做）
目前只抽了序列化（格式转换），**业务规则**（状态机、校验、金额勾稽）仍双份：
- [ ] 报价单状态机（draft→sent→accepted/rejected/expired）
- [ ] 订单状态机（pending→confirmed→producing→shipped→completed/cancelled）
- [ ] 单证金额勾稽（`trade_docs` 创建时合计 = 行项目合计）
- [ ] 阶段流转（客户 stage，已抽 `customer_rules.validate_stage_transition`）

### 3. 数据库适配层（长期）
orchestrator 用 SQLAlchemy ORM，worker 用 asyncpg 直连 SQL。
**这层无法共享**（绑定方式不同），但可以把「SQL 查询逻辑」抽成参数化模板。

## 验证

- 304 个 export_quote + 真实数据回归测试全绿
- 84 个 order/trade_doc/customer 测试全绿
- 生产探测：`fx-rates`/`actual-costs`/`external-docs` 返回 401（路由已生效）

## 关联决策

- **产品定义配置化**（租户级）：见 `docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md`
- **利润默认用利润率形式**（`margin_on_price`）：产品级配置优先
