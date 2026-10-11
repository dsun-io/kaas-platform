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
| 客户/询盘序列化 | `kaas_common/workstation/customer_serializers.py` | re-export ✓ | import ✓（`main.py:47`） |
| 客户业务规则 | `kaas_common/workstation/customer_rules.py` | re-export ✓ | 待接线 |
| 报价单/行项序列化 | `kaas_common/workstation/quote_serializers.py` | re-export ✓ | import ✓（`quote_api.py:1423,1429`） |
| 订单/付款计划/应收序列化 | `kaas_common/workstation/order_serializers.py` | re-export ✓ | import ✓（`main.py:2203`） |
| 状态机 | `kaas_common/workstation/state_machines.py` | import ✓ | 待接线 |
| 金额勾稽 | `kaas_common/workstation/amount_rules.py` | import ✓ | 待接线 |

**同步机制**：`scripts/sync-shared.ps1` 自动复制 `backend/kaas_common/` →
`backend/worker/src/kaas_common/`（CI 部署时执行，不进 git）。

## 剩余工作

### 1. worker 接线（序列化已完成 · 2026-10-10 复核）
worker 的 `main.py` 已完成序列化接线，当前实测：
- [x] `main.py:47` 客户/询盘路由 → `customer_serializers.row_to_customer` / `row_to_inquiry`
- [x] `main.py:2203` 订单路由 → `order_serializers.row_to_order`
- [x] `quote_api.py:1423,1429` 报价路由 → `quote_serializers.row_to_quote` / `row_to_item`
- [ ] `customer_rules` / `state_machines` / `amount_rules` 仍只在 orchestrator 侧使用
      （worker 仍是自己那套逻辑）→ 见下方第 2 条

### 2. 业务规则抽取（部分完成）
序列化（格式转换）已共享；**业务规则**（状态机、校验、金额勾稽）已在
`kaas_common/workstation/` 抽好，但 **worker 端尚未接线**：
- [x] 报价/订单状态机已抽 `state_machines.py`（orchestrator 已用）
- [x] 单证金额勾稽已抽 `amount_rules.py`（orchestrator 已用）
- [x] 客户阶段流转已抽 `customer_rules.validate_stage_transition`
- [ ] worker 侧接线（否则状态机/勾稽仍是双份逻辑）

### 3. 数据库适配层（长期）
orchestrator 用 SQLAlchemy ORM，worker 用 asyncpg 直连 SQL。
**这层无法共享**（绑定方式不同），但可以把「SQL 查询逻辑」抽成参数化模板。
`kaas_common/db/queries.py` + `repositories.py` 已就绪，**两端都还没接线**：
- [ ] orchestrator 接线（SQLAlchemy 适配器 + API 层改用 Repository）
- [ ] worker 接线（asyncpg 适配器 + API 层改用 Repository）

### 4. 路由面对等（新增防线 · 2026-10-10）
共享内核解决的是「同一段逻辑写两遍」，但**接口本身缺一半**（orchestrator 有、
worker 没有）sync 脚本管不到 —— 前端一上生产就 404。已加：
- [x] `scripts/route-parity.py`：静态解析两端路由表，对比清单（棘轮语义）
- [x] `scripts/route-parity-allowlist.txt`：允许缺失的路由必须逐条写明原因
- [x] CI 接入（`.github/workflows/backend-test.yml`）
- [x] worker 路由/行为测试进 CI（`backend-test.yml` 的 `worker-tests` 作业）
- [ ] 27 条已登记「待补」缺口按优先级补齐 → 见 `docs/ROUTE_PARITY_2026-10-10.md`

## 验证

- 304 个 export_quote + 真实数据回归测试全绿
- 84 个 order/trade_doc/customer 测试全绿
- 生产探测：`fx-rates`/`actual-costs`/`external-docs` 返回 401（路由已生效）

## 关联决策

- **产品定义配置化**（租户级）：见 `docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md`
- **利润默认用利润率形式**（`margin_on_price`）：产品级配置优先
