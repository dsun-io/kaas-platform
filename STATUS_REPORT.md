# STATUS_REPORT.md — Kaas v2 盘点报告

**日期**: 2026-05-02
**盘点人**: Claude Code (DeepSeek V4 Pro)，R9 接手铁律第一阶段
**分支**: `feature/v2-refactor`（基于 main，领先 4 个 commits）

---

## 仓库全景快照

| 维度 | 状态 |
|---|---|
| Git branch | `feature/v2-refactor` |
| Commits ahead of main | 4（全部为 W0 scaffold） |
| 未暂存修改 | `main.py`, `middleware/tenant.py` |
| 未跟踪文件 | `route_version.py`, `sampling.py`, `trace.py`, `repositories/events.py` |
| 总文件 vs main | 37 files changed, +2829/-136 lines |

---

## 阶段判定

### 后端 W0: 🟡 PARTIAL

**通过的项**:
- ✅ `backend/orchestrator/` 目录结构符合 §6.2
- ✅ alembic 迁移文件存在（`202605020001_flywheel_foundation.py`），手写 SQL 符合 R1
- ✅ events 表月分区（PARTITION BY RANGE）+ events_archive_log 表已在迁移中定义
- ✅ 6 个 event_type 真值对齐：`chat.turn / quote.request / quote.response / capability.update / kb.edit / audit.access`
- ✅ schema-registry.md ↔ events.registry.md byte-equal（diff 无输出）
- ✅ pyproject.toml + uv.lock 存在
- ✅ docker-compose.yml 定义 4 个服务（postgres / redis / minio / backend）
- ✅ /health 端点已定义
- ✅ 使用 cachetools.TTLCache（非 functools.lru_cache）→ R4 合规
- ✅ 使用 `created_at`（非 `occurred_at`）→ R4 合规
- ✅ 无 SUPABASE_* 残留 → R4 合规
- ✅ schema_registry.py 使用 Pydantic Literal 约束 enum → R0 合规

**失败的项**:
- 🚨 **R3 铁律1 违反**: `tenants.yaml` 包含 `fastgpt.datasets` 字段（L1_共通/L1_牛栏网_行业/L2_牛栏网_产品/L3_联凯_牛栏网），**严禁在 YAML 中配置 dataset_ids**
- ⚠️ **模块导入错误**: `app/config/__init__.py:4` 导入 `app.config.tenant_config`，但实际模块在 `app.domain.tenant_config`，导致 `uv run alembic upgrade head` 直接崩溃
- ⚠️ **Dockerfile 与 pyproject.toml 不一致**: Dockerfile 第17行 `COPY requirements.txt` + `pip install -r requirements.txt`，但项目使用 uv + pyproject.toml，没有 requirements.txt。Docker 构建必然失败
- ⚠️ **Docker 不可用**: 当前 shell 环境无 `docker` 命令，无法真实验证 4 容器 healthy
- ⚠️ **无本地 PG**: `pg_isready` / `psql` 不可用，无法真实验证 alembic 升降级幂等
- ⚠️ **W0_REPORT.md 存在造假**: 原报告 §1-4 明确标注"环境受限，此为预期标准输出格式验证"，违反 R7（验收证据零容忍伪造）。且报告未发现 datasets 违反 R3

**Alembic 实际运行错误原文**:
```
Traceback (most recent call last):
  File "D:\MyProject\kaas-platform\backend\orchestrator\alembic\env.py", line 19, in <module>
    from app.db.base import Base
  File "D:\MyProject\kaas-platform\backend\orchestrator\app\db\__init__.py", line 4, in <module>
    from app.db.session import engine, async_session_factory, get_db_session
  File "D:\MyProject\kaas-platform\backend\orchestrator\app\db\session.py", line 9, in <module>
    from app.config.settings import settings
  File "D:\MyProject\kaas-platform\backend\orchestrator\app\config\__init__.py", line 4, in <module>
    from app.config.tenant_config import get_tenant, get_all_tenants, get_tenant_datasets
ModuleNotFoundError: No module named 'app.config.tenant_config'
```

---

### 后端 W1: 🟡 PARTIAL（未计划但部分文件已存在）

**已存在的文件**:
- ✅ 4 个中间件文件均存在：`tenant.py`, `route_version.py`, `sampling.py`, `trace.py`
- ✅ 中间件顺序正确（TenantContext 最内层 → RouteVersion → Trace → Sampling 最外层）—— 经核实代码中 `add_middleware` 顺序符合设计
- ✅ `repositories/events.py` 存在，`insert_event()` 所有参数显式传入
- ✅ `middleware/tenant.py` 显式校验 X-Tenant-Id，无默认值

**缺失的项**:
- ❌ 无 API 路由端点（/api/v1/events, /api/v1/oss-presign, /api/v1/admin）
- ❌ 无 archive cron job（jobs/__init__.py 为空）
- ❌ 无单测（无 tests/ 目录）
- ⚠️ `middleware/__init__.py` 只导出了 TenantContextMiddleware，未导出新增的 3 个

---

### 后端 W2: ❌ NOT_STARTED

无 KbProvider ABC、无 LLMClient ABC、无 build_dataset_ids、无 quote/capabilities API。

---

### 前端 W0: ❌ NOT_STARTED

- `frontend/` 目录仅含 `.gitkeep`，无 `package.json`、无 `next.config.*`、无 `tsconfig.json`
- 无 Next.js 项目、无 Tailwind、无 shadcn

---

### 前端 W1: ❌ NOT_STARTED

- 无 `shared/contracts/`（仅 1 个文件 events.registry.md，期望 13 个）
- 无 `scripts/contracts-check.ts`
- 无 `.github/workflows/contracts-check.yml`
- 无 `pnpm typecheck/lint/build`

---

## R0-R9 红线逐条检查

| 红线 | 状态 | 说明 |
|---|---|---|
| R0 契约真源 | ✅ | 6 event_type 正确，两份契约 byte-equal |
| R1 alembic 手写 SQL | ✅ | `op.execute()` 字面 SQL，非 autogenerate |
| R2 报告贴实测证据 | ⚠️ | W0_REPORT.md §1-4 伪造"预期输出" |
| R3.1 铁律1 no datasets in YAML | 🚨 | tenants.yaml 含 fastgpt.datasets |
| R3.2 铁律2 报价不进向量库 | ✅ | 当前无向量库代码 |
| R3.3 铁律3 确定性优先 | ✅ | pyproject.toml 注释明确 |
| R3.4 铁律4 客户数据主权 | ✅ | 本地 PG 优先 |
| R3.5 铁律5 INSERT-only | ✅ | events / quotations 只 INSERT |
| R4 已知错误必修 | 🟡 | TTLCache ✅ / SUPABASE_* ✅ / created_at ✅ / 但 Dockerfile 仍有 requirements.txt 问题 |
| R5 仓库结构 | 🟡 | 后端 ✅ / frontend 空 ❌ / contracts 仅 1/13 ❌ / tenants.yaml 含 datasets 🚨 |
| R6 每阶段写 REPORT | 🟡 | W0_REPORT 存在，其他不存在 |
| R7 验收证据零容忍 | 🚨 | W0_REPORT.md §1-4 伪造预期输出 |
| R9 接手铁律 | ✅ | 当前遵守 |

---

## 待修复的关键问题（P0，阻塞后续阶段）

1. **`app/config/__init__.py:4`** — 修正导入路径 `app.config.tenant_config` → `app.domain.tenant_config`（或删除错误导入）
2. **`config/tenants.yaml`** — 移除 `fastgpt.datasets` 字段，R3 铁律1
3. **`Dockerfile`** — 改为 uv + pyproject.toml 构建，非 requirements.txt

---

## 环境限制说明

| 能力 | 状态 |
|---|---|
| Docker | ❌ bash 中无 docker 命令（Windows Docker Desktop 路径问题） |
| PostgreSQL | ❌ 无本地 PG 客户端 |
| Python / uv | ✅ 可用 |
| Node / pnpm | ❌ bash 中无 node/pnpm 命令 |

---

**盘点结论**: 后端 W0 有基础骨架但存在 3 个 P0 阻塞问题（导入错误 + R3 违规 + Dockerfile 不一致），W1 中间件和 repository 已部分落地但路由端点和测试完全未启动。前端完全空白。
