# KaaS Platform v2

> **Knowledge as a Service** — 为传统制造业提供 AI 岗位能力托管
>
> 当前业务重点：丝网行业 AI 智能客服 (SaaS)，基于 CoR (Chain of Role) 架构实现复杂咨询的自动化处理。
>
> v2 架构重构阶段 — 已进入 Deep Integration (Int R1-R4) 阶段。

---

## 项目定位

KaaS 不只是通用的 AI 聊天工具，而是深入制造业垂直场景，将非标报价逻辑、行业术语、产业带生态转化为可托管的 AI 能力。

**护城河**：理解复杂的非标报价计算、行业专业知识，以及产业带生态，并将这些能力以 SaaS 形式托管给制造业商家。

---

## 项目架构

```
kaas-platform/
├── frontend/                          # Next.js 14 管理后台
│   ├── src/app/                       # 页面路由
│   │   ├── admin/gray-release/        # 灰度发布管理 (flag-toggle, audit-timeline)
│   │   ├── audit-log/                 # 审计日志查看
│   │   ├── customers/                 # 客户管理 + 能力编辑器
│   │   ├── dashboard/                 # 仪表盘 (6 统计卡片 + 区间选择)
│   │   ├── events/                    # 事件列表 + 详情 + 采样标记
│   │   ├── kb/                        # 知识库概览
│   │   ├── quotations/                # 报价管理列表
│   │   │   └── v2-quote/              # V2 丝网报价引擎 (form + result)
│   │   └── settings/                  # 系统设置 (租户管理, 重载)
│   ├── src/components/
│   │   ├── layout/                    # 通用布局 (sidebar, header, app-layout)
│   │   └── ui/                        # shadcn/ui + 自定义组件
│   ├── src/lib/                       # 工具库
│   │   ├── api/                       # API 客户端 + TanStack Query hooks
│   │   ├── auth/                      # 会话缓存
│   │   ├── events/                    # 前端事件采集 (队列/worker/flush)
│   │   ├── form/                      # 表单工具 + zod 契约校验
│   │   ├── query/                     # TanStack Query 配置
│   │   └── schemas/                   # 响应校验 (zod)
│   ├── src/mocks/                     # MSW mock 数据工厂 + 请求处理器
│   ├── e2e/                           # Playwright E2E 测试 (9 套件)
│   ├── vitest.config.ts
│   └── playwright.config.ts
├── backend/
│   └── orchestrator/                  # FastAPI 核心编排服务
│       ├── app/
│       │   ├── api/                   # REST 路由 (events, quote_v2, product_specs, admin, ...)
│       │   ├── middleware/            # 中间件链 (tenant, trace, sampling, route_version, rate_limit, body_limit)
│       │   ├── domain/               # 领域逻辑 (schema_registry, tenant_config, spec_hash)
│       │   ├── repositories/         # 数据访问层 (events, admin, quotations, pricing, specs, ...)
│       │   ├── schemas/              # Pydantic 请求/响应模型
│       │   ├── services/             # 业务服务 (quote_engine, pricing, llm_client, kb_client, ...)
│       │   ├── db/                   # 数据库模型与会话管理
│       │   ├── jobs/                 # 定时任务 (archive)
│       │   └── config/               # 应用配置
│       ├── tests/                    # Pytest 测试套件 (30+ 测试文件)
│       ├── alembic/                  # 数据库迁移 (4 个版本)
│       ├── scripts/                  # seed_dev, export_openapi
│       └── Dockerfile
├── shared/
│   └── contracts/                    # 前后端共享契约 (zod 类型 + 校验)
│       ├── quote.ts                  # 报价契约 (V2 报价完整字段集)
│       ├── events.ts                 # 事件契约 (event_type 字面量)
│       ├── admin.ts, capabilities.ts # 管理员/能力契约
│       └── ...                       # categories, dataset, errors, feature_flags, ...
├── scripts/
│   └── contracts-check.ts            # 三方比对校验 (events/quote 契约一致性)
├── .ai/                              # AI 辅助开发规则
│   ├── KAAS_RULES.md                 # 核心规则与设计不变量
│   ├── KAAS_SKILL.md                 # 任务流水线技能
│   └── GIT_BRANCH_STRATEGY.md        # 分支策略
└── .github/workflows/                # CI 配置 (backend-test, frontend-ci)
```

## 技术栈

| 层 | 技术 |
|---|---|
| **AI 编排** | Orchestrator + CoR (Chain of Role) |
| **AI 引擎** | FastGPT / Dify API 集成 |
| **后端** | Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic, structlog |
| **前端** | Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| **测试** | Pytest (后端), Playwright E2E + Vitest (前端), MSW |
| **数据库** | PostgreSQL (业务数据), Redis (缓存/状态), MinIO (OSS 归档) |
| **基础设施** | Docker, uv (Python), pnpm (Node) |

## 快速开始

### 1. 基础设施 (Docker)

项目依赖 PostgreSQL、Redis、MinIO，通过 Docker Compose 一键启动：

```bash
docker compose up -d
```

### 2. 后端 (FastAPI)

```bash
cd backend/orchestrator

# 安装依赖（首次）
uv venv && uv sync

# 数据库迁移 + 种子数据
uv run alembic upgrade head
uv run python scripts/seed_dev.py

# 启动开发服务器
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

后端运行在 `http://localhost:8000`，API 文档在 `http://localhost:8000/docs`。

### 3. 前端 (Next.js)

```bash
cd frontend

# 安装依赖（首次）
pnpm install

# 启动开发服务器
pnpm dev
```

前端运行在 `http://localhost:3000`。

> 当前 `.env.development` 配置了 `NEXT_PUBLIC_API_MODE=mock`，前端以 MSW 模拟模式运行，**不依赖后端即可独立开发**。若需联调真实后端，改为 `real-backend` 并配置对应 API 地址。

### 常用命令

| 操作 | 命令 |
|------|------|
| 启动基础设施 | `docker compose up -d` |
| 停止基础设施 | `docker compose down` |
| 启动后端 | `uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000` |
| 运行后端测试 | `uv run pytest` |
| 启动前端 | `cd frontend && pnpm dev` |
| 运行前端单元测试 | `cd frontend && pnpm test` |
| 运行前端 E2E 测试 | `cd frontend && pnpm e2e` |
| 运行契约校验 | `cd frontend && pnpm contracts:check` |

### E2E 测试模式

| 模式 | 命令 | 说明 |
|------|------|------|
| **MSW Contract E2E** | `pnpm e2e` | 默认模式。Playwright 通过 MSW (Mock Service Worker) 拦截网络请求，使用 mock 数据进行端到端测试。**无需后端运行**，适合快速验证 UI 逻辑和契约一致性。 |
| **Real Backend E2E** | `NEXT_PUBLIC_API_MODE=real-backend pnpm e2e` | 连接真实后端。需要先启动 Docker 基础设施 + 后端服务 + 种子数据。适合验证真实 API 联调、数据库状态变更、OSS 归档等场景。 |

> 当 `NEXT_PUBLIC_API_MODE=mock`（默认）时，前端使用 MSW 拦截所有 API 请求并返回 mock 数据。
> 当 `NEXT_PUBLIC_API_MODE=real-backend` 时，前端直接请求 `http://localhost:8000` 的真实后端 API。

### 本地生成物与 .gitignore

以下目录/文件为本地运行产物，已被 `.gitignore` 忽略，**请勿提交**：

| 产物 | 来源 | 清理方式 |
|------|------|---------|
| `frontend/test-results/` | Playwright 测试结果 | `rm -rf frontend/test-results/` |
| `frontend/playwright-report/` | Playwright HTML 报告 | `rm -rf frontend/playwright-report/` |
| `frontend/blob-report/` | Playwright blob 报告 | `rm -rf frontend/blob-report/` |
| `frontend/.next/` | Next.js 构建输出 | `rm -rf frontend/.next/` |
| `frontend/out/` | Next.js 静态导出 | `rm -rf frontend/out/` |
| `frontend/coverage/` | Vitest 覆盖率报告 | `rm -rf frontend/coverage/` |
| `frontend/.turbo/` | Turbopack 缓存 | `rm -rf frontend/.turbo/` |
| `backend/orchestrator/.pytest_cache/` | Pytest 缓存 | `rm -rf backend/orchestrator/.pytest_cache/` |
| `backend/orchestrator/htmlcov/` | Pytest 覆盖率 | `rm -rf backend/orchestrator/htmlcov/` |
| `backend/orchestrator/__pycache__/` | Python 编译缓存 | `find . -name __pycache__ -exec rm -rf {} +` |
| `data/` | 本地种子/快照数据 | 标记待确认 |
| `*.log` | 日志文件 | `rm -f *.log` |
| `.env` / `.env.*` | 环境变量（除 `.env.example`） | 不要删除 `.env.example` |

---

## 核心概念

### CoR (Chain of Role)
将丝网行业电商客服流程标准化为多个角色分工处理：咨询引导 → 规格确认 → 报价计算 → 议价促成 → 订单追踪。不同 Role 可调用 AI 或执行业务逻辑。

### 设计不变量 (R3)
- 幂等由 DB 兜底：`usage_events.request_id` UNIQUE
- 并发由原子 SQL 兜底：预扣用单条 `UPDATE ... WHERE ...`
- 可对账：每次请求对应一条 `usage_event`
- 失败不亏钱：下游失败默认全额退款
- 透支有上限：credit line 超额强拦截

## 开发进度 (v2)

| 阶段 | 状态 | 说明 |
|---|---|---|
| **W0 — Scaffold** | ✅ 完成 | 前后端脚手架、数据库模型、契约层、Docker 构建 |
| **W1 — Core** | ✅ 完成 | 中间件链、API 路由、Archive 定时任务、pytest 套件 |
| **Int R1 — 前后端联调** | ✅ 完成 | CORS/Auth/Error 对齐, 77 个 API 端点, 30+ pytest, Playwright E2E, CI 配置 |
| **Int R2 — 深度联调** | ✅ 完成 | Seed data, CRUD E2E, OSS fix, integration tests (10 文件, +356/-76) |
| **Int R3 — 报价领域** | ✅ 完成 | Quote Engine v2, 产品规格/报价/定价/运费/配件服务, 4 条数据库迁移, 45 文件 (+5209) |
| **Int R4 — 契约校验** | ✅ 完成 | contracts-check.ts 三方比对, quote 契约字段一致性验证, real-backend E2E |
| **Int R5** | 📋 规划中 | |

## 协作规范

1. **三方协作**：Nano Auto (Notion AI Agent，拆任务/验收) → Runner (AI 编程工具，编码) → David (决策者)
2. **Notion 是唯一真相源**：所有任务 Spec、验收标准在 Notion 任务流水线数据库
3. **设计不变量优先**：进入 AI 引擎前必须完成订阅校验、配额校验、限频
4. **交付三要素**：自检清单 + 详细日志 + git push

## 分支策略

- **`main`** — 经过验证的交付版本
- **`feature/v2-refactor`** — v2 重构主分支（当前活跃）
- **`archive/`** — 历史 v1 备份

## PR 规范

每个 PR 需附带 §10 自检清单，涵盖：
- 调用链铁律 (不直连 PG/FastGPT/LLM)
- 类型契约校验 (zod parse, 无手写后端类型)
- 数据获取 (TanStack Query, 无 useEffect+fetch)
- 错误处理 (toast + 错误边界)
- 鉴权多租户 (tenant 从 session 读)
- 关键路径 E2E 覆盖

详情见 `.github/PULL_REQUEST_TEMPLATE.md`。

---

**最后更新**: 2026-05-17
**维护者**: David Sun

---

## 今日进度归档 (2026-05-03)

### 已完成

- **Contracts Check 重写**: 将 contracts-check 脚本从混合实现重写为纯 TypeScript，新增 R1 报价字段一致性校验（quote.ts ↔ backend schemas ↔ frontend schemas 三方比对）。
- **E2E 拆分 (INT-R4.5)**: 分离 real-backend E2E 与 MSW contract E2E，明确测试边界。
- **根目录 devDependencies 补齐**: 添加 eslint + prettier 到根目录，配置 lint-staged。
- **项目收尾归档**: 完善 .gitignore（覆盖 test-results/、playwright-report/、coverage/、.pytest_cache/ 等运行产物），补充 README 说明（E2E 模式区分、本地生成物清单、.gitignore 覆盖范围），清理 `.last-run.json` 等跟踪中的运行产物。

### 当前状态

- 分支 `feature/v2-refactor` 领先 `main` 17 个 commits。
- 所有里程碑 W0/W1/INT-R1/INT-R2/INT-R3/INT-R4.5 已完成。
- 前端 mock 模式可独立运行，real-backend 模式需 Docker + 后端服务。
- 待确认：`data/` 目录（含 legacy FastGPT v1 报价样例）是否应纳入版本管理。

### 明天继续前需确认

1. **`data/` 目录归属**: 当前已被 `.gitignore` 忽略。如确属参考数据，需移出 `.gitignore` 并纳入 git 追踪。
2. **`scripts/tsconfig.json`**: 新建文件，是 contracts-check 所需的 TypeScript 编译配置，需在下次提交时一并追踪。
3. **`backend/.gitkeep` / `frontend/.gitkeep`**: 两个占位文件已被删除，确认目录已有实际内容、不再需要占位。
4. **后端真实 E2E 条件**: 若明天需运行 real-backend E2E，需提前启动 Docker（PostgreSQL + Redis + MinIO）并执行种子数据脚本。

---

## Spec System v1 实施报告 (2026-05-17)

### 概述

实施报价规格体系重构，从硬编码字段模型升级为电商「类目-属性-SKU-价格」范式。参考 Notion 方案文档 §9.4 严格实施。

**分支**: `feature/spec-system-v1`
**Migration**: `202605170001_spec_system_v1.py` (down_revision: `feb821f0b9c0`)

### Phase 交付清单

| Phase | 内容 | 状态 |
|-------|------|------|
| **Phase 1** | 数据库基建: 13 张表 + 1 视图 + seed 数据 + RBAC 字段 | ✅ |
| **Phase 2** | 后端服务层: spec_hash / units / price_engine / quote_wizard / attribute_similarity / promotion_recommender | ✅ |
| **Phase 3** | 后端 API: 6 个业务 router + 1 个 admin router + 6 个 repository | ✅ |
| **Phase 4** | Shared Contracts: TypeScript zod schemas + 类型定义 | ✅ |
| **Phase 5** | 前端 Wizard: 5 步向导 + 动态属性表单 + 属性提案弹窗 | ✅ |
| **Phase 6** | 报价数据页重构: 685 行单文件 → hooks + components 化 | ✅ |
| **Phase 7** | Admin 审核页: 晋升推荐引擎 + 审核 API + 前端页面 | ✅ |
| **Phase 8** | 老数据迁移 + quote 流程对接 + 向后兼容 | ✅ |

### 数据库验证 (Block 1)

```
alembic upgrade head        ✅ 全绿
alembic downgrade -1        ✅ 回滚成功
alembic upgrade head        ✅ 重新升级成功

product_categories          ≥ 4 行 ✅
spec_attributes (public)    ≥ 11 行 ✅
category_attribute_bindings ≥ 15 行 ✅ (实际 16)
unit_groups                 = 5 行 ✅
units                       = 7 行 ✅
price_units                 = 6 行 ✅
v_quote_records             可查询 ✅
product_sku_revisions       表存在 ✅
users.is_tenant_admin       字段存在 ✅
```

### pytest 验证 (Block 2)

```
23 passed in 1.47s

覆盖模块:
- quote_wizard.py:         87%
- promotion_recommender.py: 96%
- rbac.py:                 83%
- price_engine.py:         71%
- units.py:                71%
- spec_hash.py:            68%
- models.py:               100%
- schemas/*:               100%
```

### 测试用例明细

| # | 测试类 | 测试名 | 验证点 |
|---|--------|--------|--------|
| 1 | TestSpecHash | test_same_input_same_hash | 同输入同 hash + 长度 32 |
| 2 | TestSpecHash | test_key_order_invariant | key 顺序不影响 hash |
| 3 | TestSpecHash | test_unit_normalization_cm_m | 150cm = 1.5m 归一化 |
| 4 | TestSpecHash | test_nfc_normalize | NFC/NFD unicode 统一 |
| 5 | TestSpecHash | test_decimal_trailing_zeros | Decimal 末位 0 不影响 |
| 6 | TestSpecHash | test_different_values_different_hash | 不同值不同 hash |
| 7 | TestUnits | test_unknown_unit_raises_sync | 未知单位抛 ValueError |
| 8 | TestUnits | test_unknown_unit_raises_async | 异步版本同上 |
| 9 | TestPriceEngine | test_superseded_on_full_overlap | 完全覆盖 → 老价 superseded |
| 10 | TestPriceEngine | test_truncate_on_partial_overlap | 部分重叠 → effective_to 截断 |
| 11 | TestQuoteWizard | test_non_leaf_category_rejects | 非叶子类目报错 |
| 12 | TestQuoteWizard | test_missing_required_attr_rejects | 缺必填属性报错 |
| 13 | TestQuoteWizard | test_same_hash_reuses_sku | 同 hash 复用 SKU |
| 14 | TestQuoteWizard | test_different_hash_creates_new_sku | 不同 hash 新建 SKU |
| 15 | TestRBAC | test_viewer_cannot_post_attributes | viewer → 403 |
| 16 | TestRBAC | test_tenant_admin_cannot_access_admin_api | 非 admin → 403 |
| 17 | TestRBAC | test_platform_ops_can_access_admin_api | platform_ops → 200 |
| 18 | TestChangeReason | test_post_price_without_change_reason_422 | 缺 change_reason → 422 |
| 19 | TestChangeReason | test_patch_sku_without_change_reason_422 | 缺 change_reason → 422 |
| 20 | TestSkuEdit | test_patch_sku_creates_revision | PATCH → revision+1 + 快照行 |
| 21 | TestSkuEdit | test_patch_sku_hash_conflict_409 | hash 冲突 → conflict |
| 22 | TestExcludeConstraint | test_overlapping_active_prices_fail | EXCLUDE 约束生效 |
| 23 | TestPromotionRecommender | test_three_tenants_same_proposal_gets_recommended | 3 租户 → 推荐晋升 |

### 3x 全量回归

```
Run 1/3: 23/23 passed ✅ (1.29s)
Run 2/3: 23/23 passed ✅ (1.30s)
Run 3/3: 23/23 passed ✅ (1.30s)
```

### 新增/修改文件清单

**新建 (30+ 文件)**:
- `alembic/versions/202605170001_spec_system_v1.py` — 13 表 + 视图 + seed
- `app/deps/rbac.py` — 三级 RBAC
- `app/domain/spec_hash.py` — SKU hash 算法
- `app/domain/units.py` — 单位换算
- `app/services/quote_wizard.py` — Wizard 事务入口
- `app/services/price_engine.py` — 价格引擎
- `app/services/attribute_similarity.py` — 属性相似度
- `app/services/promotion_recommender.py` — 晋升推荐
- `app/schemas/quote_wizard.py` + `spec_system.py` — Pydantic schemas
- `app/repositories/` — 6 个 repo 文件
- `app/api/` — 7 个 router 文件
- `shared/contracts/spec-system.ts` — TypeScript 契约
- `frontend/src/app/(app)/spec-config/` — Wizard 页面 + hooks + 组件
- `frontend/src/app/(app)/admin/spec-proposals/` — 审核页面
- `scripts/migrate_legacy_specs.py` — 老数据迁移

**修改**:
- `app/db/models.py` — 12 个新 ORM 类 + Quotation 3 列
- `app/main.py` — 7 个新 router 注册
- `app/services/quote_engine.py` — SKU 优先查询路径
- `frontend/src/app/(app)/pricing-data/page.tsx` — 拆分重构
- `shared/contracts/validation.ts` — 标记废弃 + 新增 binding 验证

### 明天跟进事项

1. **运行 real-backend E2E**: 启动 Docker + 后端，测试 Wizard 5 步完整流程
2. **前端 tsc 检查**: `cd frontend && pnpm exec tsc --noEmit` 确认 TypeScript 无报错
3. **合并到 feature/v2-refactor**: `git merge feature/spec-system-v1`
4. **部署验证**: staging 环境部署后验证 migration + seed + API
5. **老数据迁移**: 运行 `python scripts/migrate_legacy_specs.py` 迁移 product_specs → product_skus
