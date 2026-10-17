# 未完成事项清单（2026-10-10 收尾）

> ⚠️ **本清单已过期，勿据此施工**：其中「`POST /auth/logout` 线上 404」、
> 「`POST /auth/register` 缺失」、「前端 A/B/D 未做」、「Repository 未接线」等
> 已有明确变化，且遗漏了此后发现的问题。
> 当前问题状态以 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 为准。

## 背景

本次执行了「单证脚本融入 KAAS + 报价/单证模块审计与优化」全量任务，
核心目标（客户-订单-报价-单证 功能正常可投产）已达成。以下是**明确标注的未完成事项**，
供后续跟进。

## 一、产品定义配置化（租户级）

### 已完成

- [x] `tenant_products` 表（迁移 `202610100006`）
- [x] `TenantProductLoader` 加载器（租户级优先，回退 Python 定义）
- [x] 管理界面：`/settings/tenant-products`（产品列表 + 表单编辑 + 规格 JSONB）
- [x] 权限矩阵 API：`/api/v1/workstation-products`（启用/停用产品，多对多）
- [x] `tenant_workstation_products` 表（迁移 `202610100007`）
- [x] 线上 Worker 同步（2026-10-10 续做）：`backend/worker/src/ws_products.py`

### 未完成

- [x] ~~**工位订阅校验**~~ —— **2026-10-10 续做完成**：报价工位按 `full_chain`
      编码校验，未订阅 → 404 `SUBSCRIPTION_REQUIRED` 且不写任何数据。
      orchestrator `app/api/subs.py` 的 `WORKSTATION_CODES["quote"]` ↔
      worker `src/ws_products.py` 的 `QUOTE_SUB_CODES` 逐字对齐。
- [ ] **租户开通报价工位 UI 交互**：租户开通报价工位后，选择「启用」某些产品
      （API 两端都已就绪，仍缺前端交互界面）
- [ ] **产品定义可视化编辑器**：规格轴/变体/公式的可视化编辑
      （当前只有 JSONB 文本编辑）

### 生产对齐（2026-10-10 续做，见 `docs/ROUTE_PARITY_2026-10-10.md`）

产品定义配置化此前**只在 orchestrator 落地，生产 Worker 没有对应路由** ——
前端 `/settings/tenant-products` 一上生产就是 404。同类问题还有公章、出运台账、
单证枚举等。本次共新增 **25 条**线上路由：

- [x] worker 移植 `ws_products.py`（tenant-products 4 条 + workstation-products 2 条）
- [x] worker 移植 `ws_seals.py`（company-seals 5 条）
- [x] **客户 / 订单 / 报价 / 单证 四域缺口全部补齐（14 条）**：
      `ws_enums.py`（单证枚举，走共享内核镜像）、`ws_shipments.py`（自有出运台账 4 条）、
      `ws_docs_ext.py`（单证 confirm / translate / refresh-sources）、
      `ws_crm_ext.py`（客户 PATCH + 询盘 3 条）、`ws_quote_ext.py`（退税率 / 计算说明书）
- [x] `scripts/route-parity.py` 路由对等检查（棘轮）+ CI 接入
- [x] worker 路由/行为测试（`test_ws_products_seals.py` / `test_four_domains.py`）+
      worker 测试进 CI（此前 worker 测试**从未在 CI 跑过**）

**顺带修掉 3 个已在生产会导致 500 的既有缺陷**（详见对等报告）：

- [x] **P0**：单证 4 个端点 + 企业主体查询运行期 `NameError`（`e5ab56e` 删镜像后调用点没改）；
      另修 `render-data` 少传 `build_render_data(doc_status=...)` 的 `TypeError`；
      装配助手已收敛为单一实现 `backend/worker/src/doc_payload.py`
- [x] **P1**：10 处 `db.execute(..., table=...)` 必然 `TypeError`；已加静态守卫测试
- [x] **P2**：`test_trade_docs_api.py` 重复确认的期望值不可达（改为实现口径 `NOT_DRAFT`）

剩余缺口 24 条已登记在 `scripts/route-parity-allowlist.txt`（原因含「待补」的
会在每次 CI 日志里打印成债务清单）：**有意不做 11 条**（平台运维 / 本地探针 /
Pyodide 跑不了）+ **待补 13 条**（认证 2 条 + 规格库 11 条，前端当前未直接调用）。

### 三层组织（管理员/团队/成员）—— 2026-10-11 落地

完整说明见 `docs/TEAMS_AND_VISIBILITY.md`。要点：**团队由第一个成员创建**（创建者即
团队管理员）、**成员创建的数据本团队可见、其他团队不可见**、**加入必须凭邀请码**；
判定收敛到共享内核 `kaas_common/workstation/scope.py` 与 `.../teams.py`，两端同一份。

- [x] 迁移 `202610110001~0003`（`teams` / `team_invites` / `users.team_id` / 8 张业务表 `team_id`）
- [x] 两端读过滤 + 写入归属（orchestrator 9 处创建点、Worker 8 处 INSERT）
- [x] 团队 API 两端齐全 + 生产端 `/auth/register`（**此前缺失，线上注册直接 404**）
- [ ] **前端界面**：注册页的"加入/新建团队"选择、团队管理页（成员/邀请/移除）
- [ ] `POST /auth/logout`（前端会调，线上仍 404）
- [ ] 团队管理员转让（当前固定为创建者）

- [x] **客户域补齐过滤**（2026-10-11 续做）：列表/详情/联系人/询盘/阶段全部按
      「§10.3 + 团队」判定，不可见一律 404；同时修掉 `is_deleted` **只写不读** 的缺陷
      （客户软删除原先完全没生效）。迁移 `202610110004`：联佳丝网归入联佳团队，
      客户B 与 `[BUYER COMPANY NAME]` 软删除。

⚠️ **需产品决策**：数据里其实是**多租户**（`联佳丝网.tenant_id='lianjia'`、
`客户B='client_b'`、第三行才是 `'default'`），而生产 Worker 是**单租户**实现
（所有查询硬编码 `'default'`）—— 后果是**联佳丝网这一行在生产对任何人都不可见**，
而联佳在生产新建的数据落在 `default`，别的公司也看得到（这正是团队要解决的隔离问题）。
详见 `docs/TEAMS_AND_VISIBILITY.md` §7。本次没有擅自改租户字段。

## 二、数据库层优化（Repository 模式接线）

### 已完成

- [x] `kaas_common/db/queries.py`：SQL 查询模板（客户/报价单/订单/询盘）
- [x] `kaas_common/db/repositories.py`：Repository 模式（4 个 Repository 类 + Adapter 协议）

### 未完成

- [ ] **orchestrator 接线**：API 层改用 Repository（当前仍用 SQLAlchemy ORM 直接查询）
- [ ] **worker 接线**：API 层改用 Repository（当前仍用 asyncpg 直连 SQL）
- [ ] **Adapter 实现**：SQLAlchemy 适配器 + asyncpg 适配器

## 三、前端联调验证

### 已完成

- [x] 后端路由全部生效（8 个核心路由 401）
- [x] 报价模型与智能表格逐分吻合（真实数据回归）

### 未完成

- [ ] **前端产品下拉/报价工位实际功能联调**：需在浏览器实际操作验证
      （路由已生效，但前端交互需点验）
- [ ] **客户-订单-报价-单证 链路端到端联调**：需在生产环境实际跑通全流程

## 四、其他

- [ ] **chain.py 序列化抽取**：worker 独有（AI/线索池/触达域），orchestrator 无对应，
      当前无需抽取；若后续 orchestrator 也实现该域，再抽共享包

## 关联文档

- `docs/ROUTE_PARITY_2026-10-10.md`：路由对等报告（生产缺口清单 + 检查器用法）
- `docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md`：产品定义配置化详细设计与未完成说明
- `docs/DB_LAYER_OPTIMIZATION.md`：数据库层 4 个优化方案（SQL 模板/Repository/视图/GraphQL）
- `docs/PLAN_A_SHARED_API_PROGRESS.md`：方案A 共享 API 进展与剩余
- `docs/EXECUTION_SUMMARY_2026-10-10.md`：全量执行总结

## 后续优先级建议

1. **前端联调验证**（高优先级）：四域的生产路由已补齐，核心目标是「可投产」，
   需实际跑通链路（`客户-订单-报价-单证`）
2. **生产对齐剩余缺口**（中优先级）：`route-parity-allowlist.txt` 里 13 条「待补」
   （认证 2 条 + 规格库 11 条，前端当前未直接调用）
3. **租户开通报价工位 UI 交互**（中优先级）：权限矩阵完整流程
4. **Repository 接线**（中优先级）：消除数据访问层双份维护
5. **产品定义可视化编辑器**（低优先级）：提升产品配置体验
6. **客户可见性口径统一**（需产品决策）：见上文 ⚠️（存量 `owner_id IS NULL` 的回填 or 读接口加过滤）
