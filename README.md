# KaaS Platform v2

> **Knowledge as a Service** — 为传统制造业提供 AI 岗位能力托管
>
> 当前业务重点：丝网行业 AI 智能客服 (SaaS)，基于 CoR (Chain of Role) 架构实现复杂咨询的自动化处理。
>
> v2 架构重构阶段。

---

## 项目定位

KaaS 不只是通用的 AI 聊天工具，而是深入制造业垂直场景，将非标报价逻辑、行业术语、产业带生态转化为可托管的 AI 能力。

**护城河**：理解复杂的非标报价计算、行业专业知识，以及产业带生态，并将这些能力以 SaaS 形式托管给制造业商家。

---

## 项目架构

```
kaas-platform/
├── frontend/                          # Next.js 管理后台
│   └── src/
│       ├── app/                       # 页面路由 (dashboard, events, settings)
│       ├── components/
│       │   ├── layout/                # 通用布局 (sidebar, header, app-layout)
│       │   └── ui/                    # shadcn/ui 组件
│       └── lib/                       # 工具库 (api.ts, utils.ts)
├── backend/
│   └── orchestrator/                  # FastAPI 核心编排服务
│       ├── app/
│       │   ├── api/                   # REST 路由 (events, admin, oss_presign)
│       │   ├── middleware/            # 中间件链 (tenant, trace, sampling, route_version)
│       │   ├── domain/               # 领域逻辑 (schema_registry, tenant_config)
│       │   ├── repositories/         # 数据访问层 (events, admin)
│       │   ├── db/                   # 数据库模型与会话管理
│       │   ├── jobs/                 # 定时任务 (archive)
│       │   └── config/               # 应用配置
│       ├── tests/                    # Pytest 测试套件
│       ├── alembic/                  # 数据库迁移
│       └── Dockerfile
├── .ai/                              # AI 辅助开发规则
│   ├── KAAS_RULES.md                 # 核心规则与设计不变量
│   ├── KAAS_SKILL.md                 # 任务流水线技能
│   └── GIT_BRANCH_STRATEGY.md        # 分支策略
└── .github/workflows/                # CI 配置
```

## 技术栈

| 层 | 技术 |
|---|---|
| **AI 编排** | Orchestrator + CoR (Chain of Role) |
| **AI 引擎** | FastGPT / Dify API 集成 |
| **后端** | Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic, structlog |
| **前端** | Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| **数据库** | PostgreSQL (业务数据), Redis (缓存/状态) |
| **基础设施** | Docker, uv (Python), pnpm (Node) |

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
| **W2+** | 📋 规划中 | |

## 协作规范

1. **三方协作**：Nano Auto (Notion AI Agent，拆任务/验收) → Runner (AI 编程工具，编码) → David (决策者)
2. **Notion 是唯一真相源**：所有任务 Spec、验收标准在 Notion 任务流水线数据库
3. **设计不变量优先**：进入 AI 引擎前必须完成订阅校验、配额校验、限频
4. **交付三要素**：自检清单 + 详细日志 + git push

## 分支策略

- **`main`** — 经过验证的交付版本
- **`feature/v2-refactor`** — v2 重构主分支（当前活跃）
- **`archive/`** — 历史 v1 备份

---

**最后更新**: 2026-05-03
**维护者**: David Sun
