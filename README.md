# KaaS Platform

> **Knowledge as a Service** —— 面向传统制造业的外贸业务平台。
> 以「工位（Workstation）」为交付单元，把客户/询盘、报价、订单、出运、单证、税务、情报与 AI 串成可追溯的业务链。

- 生产站点：`https://kaas.powervoy.com`
- 生产 API：`https://api.kaas.powervoy.com`
- 本地前端：`http://localhost:3000`
- 本地后端：`http://localhost:8000`（`/health`、`/docs`）

> 📌 **交接先看 [docs/README.md](docs/README.md)**（当前权威 / 运行手册 / 归档分层）。
> 本文只保留：架构、环境、命令、门禁、业务规则；历史决策与已完成计划在 `docs/archive/`。
> **当前状态（2026-10-21 最终收口）**：A 组除 **A-11（D6 冷启动，用户决定挂起）** 外全部完成
> （A6 真实单据校准、A14 包装事实、A5-W2/W3、C36 24 条 API 全部接 UI、A10 五类模板、A8 归档实跑、
> D2 presign、C27 越权审计+修复、C12 真 PDF 归档 22/23 类、重置邮件 UI）；**B 组用户已确认关闭**。
> 生产版本 **`83647f7a`**、迁移头 **`202610210001`**；门禁：worker **1560+12skip** / orchestrator 247 /
> 前端 **926（108 files）** / e2e **27=27+0** / build `out` **286**。

---

## 1. 当前架构

```
                   一份 FastAPI app（backend/worker/src = 唯一运行时）
                  /                                            \
   本地开发：uvicorn local_run.py --reload          生产：Cloudflare Worker "kaas"
                  │                                            ├─ kaas.powervoy.com（页面 + /api/v1/*）
                  │                                            └─ api.kaas.powervoy.com（仅 API）
                  └────────── backend/kaas_common（唯一"脑"）────► Neon / R2 / Hyperdrive
```

- **单应用已落地**：不再有 orchestrator 业务壳。`backend/orchestrator` 只保留 `app/db`（ORM 模型）与
  `alembic/`（迁移链）；本地生产跑同一份 `backend/worker/src/main.py`。
- **`backend/kaas_common/` 是唯一源**：参数化 SQL、纯函数规则、报价引擎、业务枚举；
  改完必须跑 `scripts/sync-shared.ps1`。
- **生产运行时只用 asyncpg**：不得依赖 sqlalchemy/alembic/greenlet；ORM 只在迁移期加载。
- **前端**：Next 16 + React 19，`NEXT_EXPORT=1` 静态导出到 `frontend/out/`。

## 2. 环境与资源（以线上实配为准）

| | 开发（默认） | 预览 | 生产 |
|---|---|---|---|
| 数据库 | 本地 Docker PG `kaas_dev` | 每 PR 独立 Neon 分支 `preview-pr-<num>` | Neon **新加坡** `cold-king-20466417` / 分支 `production` |
| 存储 | 本地 MinIO `kaas-dev` | R2 `kaas-preview-storage`，键前缀 `pr-<num>/` | R2 **`kaas-files`**（永久保留此名） |
| Hyperdrive | 本地直连 | 每 PR 独立 `kaas-preview-<num>`（`caching.disabled=true`） | `kaas-apac`（`68304207…`）→ 新加坡库 |
| KV | 不用 | `KAAS_PREVIEW`，前缀 `pr-<num>:` | **无 KV 绑定** |
| Worker | uvicorn | `kaas-preview-pr-<num>.workers.dev` | **`kaas-edge`（TS 门面，对外）+ `kaas`（Python 内核，仅 Service Binding）** |
| 入口 | `docker compose up -d` + `pnpm dev` | PR 自动 / `workflow_dispatch` | push main 只跑 CI；**部署仅手动 dispatch** |

**原则**：环境物理隔离；开发默认不触云；预览之间共享预览资源、按 PR 前缀隔离。

> 生产配置的事实源是 `backend/worker/wrangler.jsonc`，不是任何设计图。预览链路见
> `scripts/preview/README.md` 与 `.github/workflows/preview.yml`。

## 3. 本地开发

> ⚠️ **先同步共享内核，再起后端**：`backend/worker/src/kaas_common/` 是 `scripts/sync-shared.ps1`
> 从 `backend/kaas_common/` 生成的**镜像**（已被 `backend/worker/.gitignore:15` 忽略，不在 git 里）。
> 新 clone / 换设备若跳过这步直接起 backend，会报
> `ModuleNotFoundError: No module named 'kaas_common.preview'`（镜像缺 `preview.py`，另有 4 个文件过期）。
> 正确顺序：**装依赖 → `sync-shared` → `docker compose up -d` → 空库 `alembic upgrade head` → `pnpm dev`**。

```powershell
# 0) 首次装依赖（后端 uv / 前端 pnpm）
cd backend/orchestrator; uv sync --extra migrations; cd ../..
cd frontend; pnpm install; cd ..

# 1) 同步共享内核镜像（新 clone 必做；每次改 backend/kaas_common 后也要重跑）
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1

# 2) 基础设施 + 本地后端（worker local_run；compose 映射 8000）
docker compose up -d

# 3) 首次建表（空库快径；与生产同一套 Alembic）
cd backend/orchestrator
$env:DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev"
uv run --extra migrations alembic upgrade head
cd ../..

# 4) 前端
cd frontend
pnpm dev
```

- 本地后端 = `http://localhost:8000`（compose 的 backend 容器映射 8000）；`GET /health` 实测 200 且返回
  `shared.loaded=true` —— **这条可用来确认共享内核镜像已同步成功**（`loaded=false` 说明镜像没打进/没同步）。
- 前端默认 `.env.development`：`NEXT_PUBLIC_API_MODE=real`、`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`。
  只跑 mock 时改 `NEXT_PUBLIC_API_MODE=mock`。
- 本地首次登录：用 `ADMIN_SETUP_TOKEN` 调 `POST /api/v1/auth/bootstrap-admin` 引导管理员；
  没有预置账号。API 文档：`http://localhost:8000/docs`。
- 日常开发**不要**用 `wrangler dev`（冷启动/热重载远慢于 uvicorn）；它只作部署前冒烟。

## 4. 测试与门禁

```powershell
# 迁移/模型测试
cd backend/orchestrator
uv run --extra migrations pytest tests -q

# TS 门面（对外唯一入口）
cd backend/ts-worker; pnpm typecheck; pnpm test      # 99 测 / 17 文件

# worker（Python 内核）
cd backend/worker
uv run --frozen --with pytest --with httpx2 python -m pytest tests -q

# 前端
cd frontend
pnpm typecheck
pnpm lint
pnpm test
pnpm contracts:check
pnpm ui:contrast      # light/dark token 对比度，>=4.5 才过
pnpm e2e              # MSW contract e2e；real-backend 见 E2E_GUIDE
$env:NEXT_EXPORT="1"; pnpm build   # → frontend/out
```

静态断言（迁移/依赖/契约/共享内核）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check
backend/orchestrator/.venv/Scripts/python.exe scripts/check-runtime-deps.py
backend/orchestrator/.venv/Scripts/python.exe scripts/check-schema-coverage.py
backend/orchestrator/.venv/Scripts/python.exe scripts/check-schema-drift.py
backend/orchestrator/.venv/Scripts/python.exe scripts/check-worker-bundle.py
```

> 本机工具链/踩坑（pnpm 路径、CJK 用户名、PowerShell 版本、commitlint 等）见
> [`AGENTS.md`](AGENTS.md)，不在本文重复。

## 5. 数据库迁移与部署

> **2026-10-21 切流后：生产分两个 Worker**——① `kaas-edge`（TS 门面，对外域名 + 静态资产）；
> ② `kaas`（Python 内核，无公网域名，仅 Service Binding + cron）。部署顺序：先内核后门面；
> 门面资产需先 `cd frontend; $env:NEXT_EXPORT="1"; pnpm build`。两者部署都必须带
> `$env:CLOUDFLARE_API_TOKEN`（wrangler OAuth 已过期）：
> ```
> cd backend/worker;   uv run pywrangler deploy     # 内核
> cd backend/ts-worker; pnpm wrangler deploy         # 门面（含 frontend/out 资产）
> ```
> 回滚：`wrangler versions deploy <prev>@100% --name <worker>`；域名回切见
> `docs/W4_CUTOVER_RUNBOOK_2026-10-21.md` §5。

- **Alembic 是唯一 Schema 变更来源**；执行位置是 CI/独立 CLI，不在 Worker 请求路径中执行 DDL。
- 开发迁移目标永远是**本地 Docker PG**；生产连接串只放本机环境变量 / `.env.local`，不提交。
- **部署必须手动触发**：`deploy.yml` 只保留 `workflow_dispatch`；未收到用户明确部署指令不发布。
- 生产发布顺序：迁移 → secrets → 前端静态导出 → `pywrangler deploy` → 冒烟/回滚检查；
  详细检查单见 [`HANDOVER_2026-10-21_CUTOVER.md`](docs/HANDOVER_2026-10-21_CUTOVER.md) 与
[切流 runbook](docs/W4_CUTOVER_RUNBOOK_2026-10-21.md)（2026-10-20 批次检查单已归档）。

```powershell
cd backend/orchestrator
alembic heads
alembic current
alembic upgrade head
```

常用运维：`cd backend/worker` 后 `npx wrangler deployments list --name kaas`、
`npx wrangler versions deploy <version-id>@100% --name kaas --yes`。

## 6. 当前业务模块

| 工位 | 状态 | 说明 |
|---|---|---|
| 进出口情报 | 已上线 | 海关/贸易数据、货运记录、竞争格局 |
| 市场调研 | 已上线 | 从地图源挑选并深化（品类/价格/观察/能否提供） |
| 地图源客户信息获取 | 已上线 | Google Places 拓店铺 + 官网产品 + CSV 导入 |
| 线索池 | 已上线 | `lead_candidates` 共享池 |
| 客户/询盘 | 已上线 | 客户阶段、询盘三态、询盘编号 |
| 报价 | 已上线 | 多产品算价、成本手填、产品税率、整单保险、批量报价 |
| 订单 | 已上线 | 报价转化、状态机、应收/付款计划、汇兑损益 |
| 外贸单证 | 已上线 | PI/CI/PL 等，快照留档、签发/预览/上传 |
| 出运台账 | 已上线 | 出运记录、单号、订单关联 |
| 税务管理 | 已上线 | 企业税档 + 产品税率（进项/退税） |
| AI 层 | 已上线 | BYOK Provider、任务模板、用量审计 |
| 客户触达 | 已上线 | 邮箱/campaign/发送/重发 |

关键口径：租户恒为 `default`，**团队 `team_id` 才是隔离边界**；询盘编号生成报价后锁定；
单号统一 `类型-国家-客户-时间戳`（`INQ/QUO/PI/CI/PL/ORD/SHP`）。

## 7. 仓库结构

```
backend/
  kaas_common/     共享内核（SQL/纯函数/报价引擎/枚举，唯一源）
  orchestrator/    迁移与模型工具（仅 app/db + alembic；不可运行后端）
  worker/          唯一运行时（Cloudflare Worker + local_run.py 本地入口）
frontend/          Next.js 16 静态导出（out/）
shared/contracts/  前后端 zod 契约
scripts/           sync-shared / contracts / schema / 包体积等门禁
docs/              交接、运行手册、业务参考；历史文档在 docs/archive/
.github/workflows/ CI 与 preview / deploy
docker-compose.yml 本地基础设施 + 本地后端
```

## 8. 文档

**入口：[docs/README.md](docs/README.md)**（当前权威 / 运行手册 / 归档分层）。

| 文档 | 用途 |
|---|---|
| [docs/HANDOVER_2026-10-21_CUTOVER.md](docs/HANDOVER_2026-10-21_CUTOVER.md) | **当前交接（切流收口）**：两层架构现状/运维命令/剩余事项/实测坑（2026-10-20 交接已归档） |
| [docs/archive/2026-10-21-cutover/HANDOVER_2026-10-20_FINAL.md](docs/archive/2026-10-21-cutover/HANDOVER_2026-10-20_FINAL.md) | 历史交接（归档）：S5 预览、云资源、发布检查单、踩坑 |
| [docs/README.md](docs/README.md) | **交接检索入口**（先读顺序 / 当前权威 / 归档分层） |
| [docs/PROBLEM_STATUS_2026-10-11.md](docs/PROBLEM_STATUS_2026-10-11.md) | 滚动问题状态 |
| [docs/TODO.md](docs/TODO.md) | 活跃待办唯一账本 |
| [docs/UI_UX_OPTIMIZATION_2026-10-20.md](docs/UI_UX_OPTIMIZATION_2026-10-20.md) | UI 方案、报价重构、终验（P0/P1/P2 已完成，§11 为终验） |
| [docs/archive/2026-10-21-final-closeout/UI_BACKEND_DEPENDENCIES_2026-10-20.md](docs/archive/2026-10-21-final-closeout/UI_BACKEND_DEPENDENCIES_2026-10-20.md) | 后端 5 项验收基线（**已完成**；**2026-10-21 已归档**，历史基线，现状以 TODO + 代码为准） |
| [docs/archive/2026-10-21-final-closeout/](docs/archive/2026-10-21-final-closeout/README.md) | **2026-10-21 最终收口批（5 份）**：A5 编辑方案、A6 校准矩阵、C12 PDF 归档、后端 5 项基线、租户产品配置化（替代指针见批次 README） |
| [docs/archive/2026-10-21-doc-closeout/](docs/archive/2026-10-21-doc-closeout/README.md) | 2026-10-21 归档批：平台升级/团队可见性/客户单据视图/产品媒体存储（替代指针见批次 README） |
| [docs/archive/](docs/archive/) | 历史文档（只读，不代表当前架构） |

---

**最后更新**：2026-10-21（最终收口：A 组除 D6 挂起外全部完成、B 组用户确认关闭；过时文档归档到 `docs/archive/2026-10-21-final-closeout/`）。
