# S4 单应用收口设计（方案 B 阶段二 · 2026-10-19）

> 状态：**设计定稿，待实施**（S3 行为对等完成后执行）。
> 目标：把「两份 API 实现」收敛为**一份运行时实现**，删除 orchestrator 业务壳，
> 保留其**迁移职责**（SQLAlchemy models + Alembic）；本地开发与生产共用同一份 app。
>
> 与 [PLAN_B_EVALUATION](./PLAN_B_EVALUATION_2026-10-19.md) 的关系：方向一致；本文是
> 「S4 删壳 + CI」的具体落法，并显式标注与评估文档「约 1,085 条 orchestrator 测试原样保留」
> 这一前提的偏差（见 §5）。

---

## 1. 现状（2026-10-19 实测）

| 维度 | orchestrator | worker |
|---|---|---|
| 路由 | 231 | 228（本日补 attribute-proposals 后） |
| 路由缺口 | — | 8 条（全部为**故意不做**：运维/探针/OSS SDK/comtrade） |
| 运行时数据访问 | SQLAlchemy ORM（91 文件引用） | 裸 asyncpg（参数化 SQL） |
| 测试 | 1208 passed / 1 skipped（`-m unit`） | 315 passed + 5 skipped（真 PG 5 条） |
| 生产可部署 | ❌ 从未部署 | ✅ 唯一生产 Worker `kaas` |
| 结构 | app/{api,services,repositories,domain,schemas,jobs,middleware,core,db} | `src/main.py` + `ws_*.py` 模块（`import main as _main` 挂路由） |

**关键事实**：生产实际跑的是 worker 实现；orchestrator 只在本地开发与迁移时使用。
因此「保留哪一份」不是对称选择。

## 2. 目标形态（选择：保留 worker 为唯一运行时）

```
backend/
  worker/src/                 ← 唯一运行时 app（生产 Worker 打包的就是它）
      main.py + ws_*.py ...   ← 保持现有结构（避免 197KB 单文件大搬迁带来的回归风险）
      local_run.py（新增）     ← 本地 uvicorn 入口：stub `workers` + 注入本地 DB 适配
  orchestrator/
      app/db/                 ← 仅保留 SQLAlchemy models（迁移期 schema 真源）
      alembic/                ← 仅保留迁移链
      （删除）app/api、app/services、app/repositories、app/domain、
              app/schemas、app/jobs、app/middleware、app/core、app/main.py
  kaas_common/                ← 共享内核（含 db.py / export_quote），继续镜像进 worker/src
```

**理由**：
1. worker 实现是**生产已验证**的那一份（225+ 条路由、asyncpg-only、冷启动达标）；
2. 反方向（把 33,764 行 orchestrator 代码搬进 Worker 并把 ORM 换成 asyncpg）等于把
   91 个 ORM 文件的每一处查询重写一遍，且要重跑全部 1200 条测试——风险与工作量都远高于本方案；
3. 本方案可以**逐域退役** orchestrator 路由（S3 的 parity 测试就是退役判据），随时可停、可回退。

## 3. 实施步骤（≈1 人日）

1. **本地入口**：新增 `backend/worker/src/local_run.py`
   - stub `workers` 模块（`WorkerEntrypoint`/`asgi`），设置 `sys.path`，`uvicorn main:app --reload`；
   - 本地 DB：复用 `platform/db.py` 的 asyncpg 适配，`DATABASE_URL` 指本地 Docker PG（已有）。
2. **本地 Docker**：`docker-compose.yml` 的 backend 服务改指向新入口（Dockerfile COPY worker/src，
   或直接以 orchestrator 目录 + bind mount worker/src 运行）。
3. **删除业务壳**：删 orchestrator 的 api/services/repositories/domain/schemas/jobs/middleware/core/main；
   保留 `app/db/*`（models/legacy_models/migration_bootstrap/session 等）与 `alembic/`。
4. **测试处置**（见 §4）。
5. **CI/门禁**：
   - `backend:test`：unit-tests 改为跑 worker 全量 + orchestrator 的迁移/db 测试；
   - `route-parity.py` 退役（没有第二后端可比）→ 移入 `scripts/archive/` 并注明原因；
   - `sync-shared.ps1 -Check`、`contracts:check`、schema 门禁、依赖断言保留。
6. **文档**：README §1/§3/§13/§18 架构图与命令同步；DEPLOY.md 冒烟不变。

## 4. 测试处置（与 PLAN_B 的偏差 · 显式记录）

PLAN_B §1 的前提是「约 1,085 条 orchestrator 测试原样保留（其 import 的 app.services/domain
在 B 后以新形态存活）」。**本方案不搬迁 orchestrator 的 services/domain**，因此这 1,085 条中：

| 类别 | 处置 |
|---|---|
| 纯 domain/services 逻辑测试（不依赖 HTTP/ORM） | **迁入 worker 测试**（直接 import 共享内核或复制被测纯函数）——优先迁移 |
| API 行为测试（FastAPI + ORM 造数） | **用 worker 侧 parity 测试替代**（S3 已开始：auth/账号域、后续按域补齐） |
| db-marked（288） | 保留为迁移/集成测试，指向 worker 真 PG 路径 |
| 已无对应实现的端点测试（如本地运维端点） | 删除并登记原因 |

**判据**：S3 每域 parity 测试通过 ⇒ 该域 orchestrator 测试可删；删除前在
`docs/S4_TEST_MIGRATION_2026-10-19.md`（实施时新建）逐文件登记「迁/删/替」。

## 5. 风险与回退

| 风险 | 缓解 |
|---|---|
| 删壳后本地开发无 app 可起 | 步骤 1 的 `local_run.py` 先落地并在删壳前验证（uvicorn 热重载 + 登录/报价冒烟） |
| 某些行为只有 orchestrator 正确 | S3 parity 逐域对比；差异先修 worker，再删对应 orchestrator 实现 |
| 本地 Docker 镜像/CI 脚本引用旧路径 | 步骤 5 全量 grep `orchestrator/app` 引用并清零 |
| 回退 | 删壳是一个独立提交，`git revert` 即恢复；迁移职责全程未动 |

## 6. 验收清单（2026-10-19 全部完成）

- [x] `local_run.py` 起本地 app，登录 / 报价 / 客户 3 条往返通过（对本地 Docker PG；实测 health /
      bootstrap / login / 建客户 / 报价·订单·应收列表 / export-quote-products 全 2xx）
- [x] orchestrator 业务目录删除后，`grep -r "orchestrator/app/api"` 0 命中（源码 0；仅历史 docs/archive 保留）
- [x] worker 测试全绿（**954 passed + 5 skipped**，含真 PG 集成 5 条）；迁移测试
      （`alembic upgrade head` + `alembic check`：head `202610190020`，no new operations）全绿；
      orchestrator 保留测试 **222 passed**
- [x] `contracts:check` / 依赖断言 / schema 双门禁 / sync-shared -Check 全绿
- [x] 前端 typecheck / lint / **455 passed** 不受影响（Tenant 定义统一 `display_name`，还掉 R5.1）
- [x] README/AGENTS/docs 架构描述同步；route-parity 归档说明落盘（`scripts/archive/README.md`）；
      测试处置 `docs/S4_TEST_MIGRATION_2026-10-19.md`
- [x] 生产部署**等用户指令**后再执行（当前部署冻结；`deploy.yml` 仍是 `workflow_dispatch` 手动）

---

**与 S3 的衔接**：S3 按域 parity 通过一个域 → 该域可进入 §4 的「替/删」；全部域完成后再执行 §3 删壳，
避免一次性大爆炸。
