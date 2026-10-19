# 总执行计划清单（2026-10-19 · 工作区全面盘点后汇总）

> 🔄 **方向变更（2026-10-19 晚场，全部已确认，见 [README 主交接](../README.md) §9 决策记录）**：
> - **决策 1**：**P1 生产库迁 PPG 批次废弃**（放弃 PPg 回 Neon，`feat/convergence-aprime` 分支中的
>   PPG 相关改动不得合并）；本文批次 1–5 中的"P1 迁库"与相关并入项全部作废。
> - **决策 3**：双后端优化方向由 A′ 升级为**方案 B**（评估结论 B-可行 + 三项已确认修正）；
>   执行细节以 [docs/PLAN_B_EVALUATION_2026-10-19.md](./PLAN_B_EVALUATION_2026-10-19.md) 与
>   README §3/§10 为准（阶段二 9–13 人日 / 阶段三 5–8 人日）。
> - 未受影响：批次 0（已完成）、批次 6（技术栈债，仍排收敛后）、批次 U、批次 7。

> **状态：已排定执行顺序，批次 0 开工中。** 本文是全工作区待办的唯一执行入口：
> 两份审计（状态类 36 处 + 计划类全量文档）交叉验证去重后的结果 + 今日新定计划。
> 每个批次完成必须：勾选本文 + 更新 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md)
> 交接摘要 + 推送 `main`（项目规则 1）。
> 专项细节仍在各自文档，本文只管"做什么、什么顺序、谁做、依赖谁"。
>
> 📌 **2026-10-19 平行线交接（必读，避免重复劳动）**：
> [HANDOVER_2026-10-19_CI_AND_PROD_FIXES.md](./HANDOVER_2026-10-19_CI_AND_PROD_FIXES.md)
> —— 生产注册 500 / 报价页白屏已修并部署；CI `backend:test` 的 **db-tests 长期红已修绿**
> （main `backend:test` = success，`6c08900`）；含**本机无 Postgres ⇒ 本地 db 测试全 skip**
> 等环境坑与「不要重做」清单（§5）与留给主线的事项（§6）。

---

## 0. 执行顺序总览

```
批次 0  即时小修（代码 5 项 + 文档收口 4 项）      ✅ 已完成（`846d4ab` / `1350c87` / `dbf2b54`）
批次 U  用户操作包（dashboard/GitHub/业务配置 4 项） ← 不阻塞开发，随时可做
批次 1  收敛 P0：POC（0.5–1 天）                    ✅ 已完成（路线 A 否决，证据 POC 文档）
批次 2  ~~收敛 P1：生产库迁 Neon→PPG（半天）~~ ❌ 决策 1 废弃（回 Neon；Hyperdrive 缓存关闭仍为独立待办）
批次 3  收敛 P2：预览环境（1 天）                    ← 随方案 B 阶段二 S5 落地（README §2 四列矩阵）
批次 4  收敛 P3 → **方案 B 阶段二 S1–S6（9–13 人日）** ← 当前主链
批次 5  收敛 P4 → **方案 B 阶段三（5–8 人日）+ 观察期（1 周）**
批次 6  技术栈安全债（Next 15+/16、Node 22、ESLint 10、TS 6）← 硬性串行排在收敛之后
批次 7  独立排期项（见 §5，按依赖与拍板情况插入）
```

硬性规则：方案 B **阶段二 → 阶段三严格按序**（见收敛执行计划的风险 R5：大变更不可叠加归因）；
批次 0 与 U 与之并行不悖；批次 6 不与收敛交叉。

---

## 1. 批次 0 · 即时小修（现在开工）

> ✅ **已完成（2026-10-19）**：B0-1~B0-4（提交 `846d4ab`，门禁 typecheck/lint/test 全绿）；
> B0-5/B0-6（提交 `1350c87`，orchestrator 1200 passed / worker 303 passed / route-parity PASS）。
> 印花税口径变更（定义删除并入杂税 3%，fixed/ratio 生效）已按用户裁决落地，详见 PROBLEM_STATUS
> 交接摘要。D0-1~4 文档收口已推送（`dbf2b54`）。

| ID | 事项 | 证据 | 负责 | 写范围 |
|---|---|---|---|---|
| B0-1 | 前端 `crypto.subtle.digest` 加 jsdom/CI 兜底（Frontend CI 红） | `frontend/src/hooks/use-products.ts:110` 裸调 | teammate A | `frontend/src/hooks/use-products.ts` + 测试 |
| B0-2 | 货代询价文案补 DAP/DDP 费用项说明 | `frontend/src/app/(app)/quotes/freight-panel.tsx:189` 仍只列五项 | teammate A | `freight-panel.tsx` |
| B0-3 | 报价「定价数据」tab 改名「成本历史/产品历史成本价」（用户裁决 #10） | `frontend/src/app/(app)/quotes/page.tsx:41` | teammate A | `quotes/page.tsx`（+ 相关 test） |
| B0-4 | 报价产品下拉过滤已停用产品 | quotes 前端无 inactive 过滤 | teammate A | quotes 产品下拉组件 + test |
| B0-5 | 印花税 fixed/ratio 遗留模式归并 | `pricing.py:115-157` 仍有 `fixed_per_unit/fixed_total/fixed`（`6437646` 明确"待归并"） | teammate B | `backend/orchestrator/app/services/export_quote/pricing.py` + 单测；⚠️ 算价逻辑，改完跑全量报价测试 |
| B0-6 | 诊断端点收敛（`_r2_debug`、`fx-rates/_debug` 移除或加保护） | `ws_files.py:890`、`ws_extras.py:196`；route-parity 白名单同步删项 | teammate B | orchestrator + worker 两侧 + `route-parity` 白名单文件；改完必须跑 `route-parity.py` |

### 批次 0 · 文档收口（lead 自己做）

| ID | 事项 |
|---|---|
| D0-1 | `DEPLOYMENT_PLAN_2026-10-18.md` §9 执行清单 11 个 `[ ]` 打勾 + 加注执行时间（10-18 22:00） |
| D0-2 | `HANDOVER_2026-10-18.md` §0/§7、`PROBLEM_STATUS` L102-122 旧"尚未部署"段落加删除线 |
| D0-3 | `CONTRACT_AND_MOCK_DECISIONS.md` 归档（S1–S3 步骤被收敛方案取代，保留为决策记录） |
| D0-4 | `PLATFORM_UPGRADE_PLAN.md` 文末状态行改为"主体已收口" |

## 2. 批次 U · 用户操作包（需用户动手，不阻塞任何开发）

| ID | 事项 | 位置 |
|---|---|---|
| U-1 | R2 `S3_ACCESS_KEY` 重建 32 位（dashboard 操作） | `PRODUCT_MEDIA_STORAGE_PLAN §5.3` |
| U-2 | 生产 `product_tax_rates` 配置数据（0 条则批量报价不放行） | DEPLOY_PLAN 顶部 |
| U-3 | 仓库改回 private + 确认 Actions billing | GitHub 设置 |
| U-4 | 智能表格 21 行缺失输入补全（业务动作） | `SHEET_CALC_VERIFICATION §4-5` |

## 3. 批次 1–5 · 双后端收敛（主链 · 现行 = 方案 B）

> ✅ **批次 1（P0 POC）已完成**：路线 A 否决（greenlet 无 wasm wheel ⇒ `sqlalchemy.ext.asyncio`
> ImportError；冷启动 +1854ms 超线）。证据见 [POC_WORKER_SQLALCHEMY_2026-10-19.md](./POC_WORKER_SQLALCHEMY_2026-10-19.md)。
> 🔄 **2026-10-19 晚场决定**：双后端优化采用**方案 B**（一份 app 代码双入口、运行时 asyncpg-only），
> 取代原 A′ 路线；评估与三项已确认修正见 [PLAN_B_EVALUATION_2026-10-19.md](./PLAN_B_EVALUATION_2026-10-19.md)，
> 权威口径见 [README](../README.md) §3 / §10。

- **批次 2（P1 迁库）❌ 已废弃**（决策 1：放弃 PPG 回 Neon）。原并入的「生产测试数据/拒绝文件历史清理」
  须用户确认后另行执行；「Hyperdrive 查询缓存关闭」保留为独立待办。
- **批次 3（P2 预览环境）**：按 README §2 四列矩阵重新定义（每 PR 独立 Neon 子分支 + 独立 Hyperdrive），
  随方案 B 阶段二 **S5（preview + deploy）** 落地。
- **批次 4（方案 B 阶段二 S1–S6，≈9–13 人日）**：依赖拆分 / 迁移归位 / 路由合并（5–8 人日，最大块）/
  删壳 + CI / preview + deploy / 静态门禁。
- **批次 5（方案 B 阶段三，≈5–8 人日）**：10 项收口（`kaas_common/db.py` 事务包裹执行、schema 完备性门禁、
  依赖断言、包体积断言、downgrade 审计等）；冷启动验收线 **≤2,950 ms**（基线 2,680ms +10%）。
- **批次 5 之后（观察期，1 周）**：冷启动 / 5xx / 延迟与基线对比。

**顺带项（不单独立项）**：
- `attribute-proposals` 3 条路由随阶段二合并补进 worker（修既存生产 404，前端有活页面）。
- ✅ **CF Cron 重建 2 个定时任务已完成（2026-10-19）**：`backend/worker/src/ws_cron.py`
  （15 分钟 replied→询盘扫描 + 每日 events 归档，纯 asyncpg，scheduled 钩子按 `controller.cron` 分派），
  `wrangler.jsonc` 加 `triggers.crons`（UTC：`*/15 * * * *` / `30 16 * * *` = 上海 00:30），
  30 条单测；`INQUIRY_SYNC_MAP` 在 worker 侧有 2 份（ws_cron + ws_crm_ext），后续挪进 `kaas_common`。
- 订阅门禁两套口径（`chain.py _require_sub` 仍查 `tenant_subscriptions`）、Excel xlsx 上传闭环
  （`_reject_spreadsheet`，POC 证实 in-Worker 跑纯 Python 包无硬阻塞）——在阶段二逐路由合并时一并核对。

### 阶段二 S1–S6 执行清单（唯一进度账 · 2026-10-19 起）

**S1 依赖拆分（0.5 人日）**
- [x] **S1-a** `kaas_common/db.py` 运行时数据访问层：`Session` + `transaction()`（嵌套 = SAVEPOINT，
      复刻测试 savepoint 回滚语义）+ `execute/fetch/fetchrow/fetchval` + Record→dict；单测 5 条
- [x] **S1-b** 运行时依赖静态断言 `scripts/check-runtime-deps.py`（禁止 sqlalchemy/alembic/greenlet/psycopg2），
      接入 `backend:test` 与 `deploy` 两道 CI
- [x] **S1-c** 边界固化：`kaas_common` 铁律补充 `db.py` 例外；worker 运行时依赖保持 6 个
- [ ] **S1-d** 依赖清单正式拆分（orchestrator 主依赖移除 sqlalchemy/alembic/psycopg2）——**并入 S4**：
      路由合并完成前 ORM 仍在用，提前拆会让本地装不上

**S2 迁移归位（1 人日）**
> S2-a/b 并入 **S4**：路由合并完成前运行时仍 import ORM，提前搬模型只会制造 import 风险、
> 没有任何运行时收益；删壳时一次性归位（S4-a）。
- [ ] **S2-a**（→ S4）SQLAlchemy models + Alembic 归位到迁移期（运行时 import 不触发）
- [ ] **S2-b**（→ S4）Alembic 入口改造（`env.py` 不再被 runtime 路径 import）
- [x] **S2-c** `deploy.yml` 新增 `migrate` job：`alembic upgrade head` 后再部署 Worker
      （secret `PROD_DATABASE_URL`；未配置时告警跳过，保持手动迁移现状）
- [x] **S2-d** schema 完备性门禁 `scripts/check-schema-coverage.py`：worker SQL 引用的表 ⊆ metadata；
      接入 `backend:test`
- [x] **S2-e** 补齐 8 张 worker 独有/遗留表模型（`app/db/legacy_models.py`，按生产 DDL：
      82 列 / 65 约束 / 23 索引，2026-10-19 只读 dump）
- [x] **S2-f** 真库验收（本地 Docker PG16）：空库 `alembic upgrade head` → **102 表** / head
      `202610180010` / 8 表 DDL 与生产**逐列一致** / `alembic check` **零漂移**；
      worker 真 PG 集成测试 **5 passed**

**S3 路由按域合并（5–8 人日，最大块）**
- [ ] **S3-a** 基础设施域（health / auth / accounts）——先验证整条链
- [ ] **S3-b** CRM 域（客户 / 询盘 / 线索池）
- [ ] **S3-c** 算价域（报价 / 订单；金额逻辑最重，放中段）
- [ ] **S3-d** 文档域（单证 / 出运 / 税务）
- [ ] **S3-e** 集成域（情报 / 市场调研 / AI / 触达）
- [x] **S3-f** `attribute-proposals` 3 条路由补进 worker（修既存生产 404）—— ✅ **已完成（2026-10-19）**：
      `backend/worker/src/ws_admin_proposals.py`（列表/推荐/审核 approve·reject·merge，平台运营鉴权），
      12 条 worker 单测；route-parity 缺失从 11 → **8**，allowlist 同步删 3 行
- [x] **S3-h** **认证/账号域行为对等** —— ✅ **已完成（2026-10-19）**：
      `test_parity_auth.py` 66 条对等测试；修复 worker 8 处差异
      （bootstrap 缺 Bearer 401 / 密码≥8 422 / 邮箱查重 409、login strip+lower、禁用账号 403、
      /me 补 plan·effective_role·tenant_id、workstations=[] 零开通、无 team_name 也校验工位 422）；
      剩余 **2 处**待评估（login/bootstrap 响应扁平化 D4/D6，需同步前端/集成断言）；邀请码与邮箱查重顺序（D12）、
      分页越界 422（D13）已在本轮一并修复
- [x] **S3-i** CRM 域行为对等（2026-10-19，teammate crm-parity）—— `test_parity_crm.py` 61 例
      （38 passed + 23 xfail）；**高危差异待修**：写权限缺口（DELETE 客户 / PATCH stage / POST inquiries 缺
      `_check_write_access`，同团队非属主可操作）、`PATCH contacts` COALESCE 导致显式 null 清空无效、
      询盘缺 channel 校验/任意 status 入库/丢 lead_id（线索池→询盘断链）
- [x] **S3-j** 报价/订单域行为对等（2026-10-19，teammate quote-parity）—— `test_parity_quote.py` 120 例
      （92 passed + 28 xfail）；差异集中在 401 体形状、`closed` 状态枚举、`customer_id` 类型、
      错误码优先级、行项覆盖字段缺失、`days` 越界钳位
- [x] **S3-k** CRM 高危差异已修（2026-10-19）：写权限 5 处（客户删除 / 阶段 / 建询盘 / 联系人增删改）、
      联系人显式 null 清空、`is_primary` 唯一、询盘 channel/status/lead_id/owner_scope、body 不再要求 customer_id；
      CRM xfail **23 → 11**（其余为响应键集/分页/排序/404 体等中低危，按档排期）
- [~] **S3-l** 报价/订单差异：**P0 已修**（Q21 应收列表越权、Q25 签发入账 `customer_id` 类型错→线上 500）；
      其余 26 条 xfail（枚举/错误码/投影/分页等）待按档处理
- [ ] **S3-g** 测试重写 350–380 条 + marker 错位 87 条归位（共用 `queries/` 造数，与 S3 同批）

**S4 删壳 + CI（1 人日）**
> 设计定稿（2026-10-19）：[S4_SINGLE_APP_PLAN_2026-10-19.md](./S4_SINGLE_APP_PLAN_2026-10-19.md)
> —— 保留 **worker 为唯一运行时**（生产已验证），orchestrator 只留 models + Alembic；
> 含本地入口 `local_run.py`、按域退役顺序、测试处置（与 PLAN_B「1085 条保留」的偏差）与回退。
- [~] **S4-a** orchestrator 业务实现退场（仅保留 uvicorn 入口 + 迁移工具）——
      **本地入口已落地（2026-10-19）**：`backend/worker/src/local_run.py` 用 uvicorn 起**生产同一份 app**
      （注入 `workers` stub + `request.scope["env"]`/HYPERDRIVE→本地 Docker PG，绕开 `src/platform`
      对标准库的遮蔽）；真实冒烟全绿：health / bootstrap-admin / login / 建客户 / 报价·订单·应收列表 /
      `export-quote/products` 全部 2xx。剩余：删除 orchestrator 业务实现 + 测试处置。
      > ⚠️ 冒烟同时抓出 **列级 schema 漂移**：`tenant_workstation_products` 生产有 `team_id`（迁移
      > 202610110019）+ FK + `COALESCE(team_id,0)` 函数唯一索引，但 ORM 模型漏写 ⇒ 空库快径缺列
      > ⇒ `export-quote/products` 500。已补模型并新增 `tests/test_team_scope_schema_parity.py`
      > （12 张 team 作用面表 + 4 个函数唯一索引）；教训：S6-a 的表级门禁查不出列/索引漂移，S6 需补列级断言。
- [ ] **S4-b** 主依赖拆分落地（`[project.optional-dependencies].migrations`）
- [ ] **S4-c** CI 改造：db 门禁迁到真 PG 集成；`route-parity` 退役评估（已无第二后端）

**S5 preview + deploy（1–2 人日，按 README §2 目标态矩阵）**
- [ ] **S5-a** preview workflow：非 main 分支 push → 预览 URL
- [ ] **S5-b** 每 PR 独立 Neon 子分支 + 独立 Hyperdrive config（PR 关闭回收）
- [ ] **S5-c** `kaas-preview-storage` + 预览 KV namespace + `PR_SLUG` 前缀注入
- [ ] **S5-d** CI 防污染断言（生产/预览绑定的 bucket / KV / Hyperdrive 互异）

**S6 静态门禁（0.5–1 人日）**
- [ ] **S6-a** schema 完备性门禁（= S2-d）
- [x] **S6-b** 依赖断言（= S1-b，已落地）
- [ ] **S6-c** 包体积 + 冷启动断言（≤2,950 ms；`wrangler versions upload` 口径）
- [x] **S6-d** 迁移链 downgrade 审计 —— 已完成（2026-10-19）：`scripts/audit-migrations.py` 静态分析 70 个版本，
      精确结论 **drop_table 仅 3 个**（旧估「35 个」口径失真，已更正）；报告见
      `docs/MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md`；3 张被删表默认不可逆，发布前需冷备

## 4. 批次 6 · 技术栈安全债（收敛完成后串行）

按 [TECH_STACK_UPGRADE_2026-10-17.md](./TECH_STACK_UPGRADE_2026-10-17.md) 批次 B：
Next 14.2→15.5+/16（2 critical RCE，修复只发 ≥15.5.24）、CI Node 20→22+、ESLint 8→10、TS→6。
前置：执行前重跑该文档 §1 复现命令（版本继续前进，数字会过期）。
理由：同为前端大改，与收敛交叉会无法归因（收敛动打包链，升级动构建链）。

## 5. 批次 7 · 独立排期项（等待拍板或触发条件）

| ID | 事项 | 卡点 |
|---|---|---|
| I-1 | 「流失」拒绝文件链路迁订单阶段（订单阶段新增 `lost`） | 业务设计先行 + 用户拍板口径 |
| I-2 | 单证加固 P1/P2（事实层/一致性引擎/收款容差等 5 项） | 5 项口径待用户拍板（`UNCERTAIN.md`） |
| I-3 | 文件存储收尾 3 项（真实 DB 用例 / 公章 PI 视觉 QA / 排序过滤测试） | 依赖 U-1 完成后验证更完整 |
| I-4 | PDF 归档尾巴（端到端一次 / 定时调度 / "已变更"标识） | 低优先，可穿插 |
| I-5 | Cloudflare agent 接入 | 无依赖但价值未明，待用户排优先级 |
| I-6 | 单证指纹批量对账定时调度 | 暂缓（测试钉死"无定时调度"，接线需改测试） |
| I-7 | P3 暂缓五项（30/90 自动沉寂、MSW 刷新、e2e 数据层、租户级产品配置化等） | 维持触发条件制 |

## 6. 智能体团队分工

| 成员 | 职责 | 写范围 |
|---|---|---|
| **lead**（我） | 总控、批次调度、文档收口、生产操作窗口、门禁复跑裁决 | `docs/`（收口项） |
| **fixer-frontend**（teammate A） | 批次 0 前端 4 项 | `frontend/src/hooks/use-products.ts`、`quotes/` 下相关文件 |
| **fixer-backend**（teammate B） | 批次 0 后端 2 项 | `pricing.py`、orchestrator/worker 诊断端点 + route-parity 白名单 |
| （后续按需 spawn） | POC 验证 / 收敛分域迁移 | 每 Phase 启动时定义 |

纪律：所有 teammate 遵守 [AGENTS.md](../AGENTS.md) 规则 4（私有 index 提交、自证、归位）；
批次 0 两条线写范围不相交，可并行；任何人不得跨范围改动。

## 7. 已完成/过时总账（审计结论，不再跟进）

**全部落地可收口的方案**：QUOTE 22 项（残留 3 个小尾巴已入批次 0）、TAX-01~07、
BATCH_QUOTE B1~B6、PDF 归档三链、SHEET_CALC §6、PLATFORM_UPGRADE 主体。
**过时不再适用**：30/90 自动沉寂（用户裁决"先手动"）、CONTRACT_AND_MOCK 的 S1–S3 步骤、
PROBLEM 更早的四条历史待拍板（已被 10-17 决策 #17–#20 覆盖）。
