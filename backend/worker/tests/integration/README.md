# worker 真 Postgres 写入路径测试（task-8 / 路线 C 子集）

> 目录：`backend/worker/tests/integration/`（`@pytest.mark.integration` 隔离）
> 用例：`test_worker_write_paths.py`（5 条）
> 底座：`conftest.py`

## 为什么需要它

worker 用**裸 asyncpg 手写 SQL**，orchestrator 用 SQLAlchemy ORM。ORM 里的
`default=` 只是**客户端行为，不会生成 DDL 默认值**。worker 的 INSERT 一旦漏写
「NOT NULL 且无 server_default」的列，就是线上 500；而现有 worker 测试用假 DB
（冒烟/字符串断言），**只能证明 SQL 长这样，证明不了 schema 真接受它**。

真 PG 用例专门堵这个盲区（近两起线上 500 都是这个形状）：

| 用例 | 打到的写入路径 | 对应历史事故 |
|---|---|---|
| `test_bootstrap_admin_writes_internal_system_admin` | `users` INSERT（bootstrap-admin） | `is_tenant_admin` NOT NULL |
| `test_register_writes_user_team_and_subscriptions` | `users` + `teams` + `team_subscriptions` INSERT | 注册 500 / 漏列 |
| `test_register_duplicate_email_rolls_back_without_orphan_team` | 事务整体回滚（无孤儿团队） | 半截注册 |
| `test_create_customer_writes_not_null_columns_then_soft_deletes` | `customers` INSERT + `cust_contacts` INSERT + 软删 UPDATE | 2026-10-17 创建客户 500（`plan`/`status` 无默认值） |
| `test_create_quotation_writes_schema_version_not_null` | `quotations` INSERT | 2026-10-19 手动报价 500（`schema_version` 无默认值） |

用例不是只断言 HTTP 码：每个都直接 `SELECT` 回查落库行，并断言
`plan/status/is_tenant_admin/schema_version` 等**显式列**的值。

## 怎么跑

### 1) 本机自动拉起（推荐，零外置依赖就跳过）

```powershell
cd backend/worker
python -m pytest tests/integration -m integration -q
```

conftest 会：起一台临时 PostgreSQL（随机端口 + `tests/integration/.pytest-pg/` 下
临时数据目录）→ 建库 → `alembic upgrade head` → 跑用例 → 停服 + 删目录。

前置（缺任一则 **skip**，不会红）：

1. **能跑 alembic 的解释器**：需 `import alembic, sqlalchemy, psycopg2`。
   发现顺序：`KAAS_ALEMBIC_PYTHON` → 当前解释器 → 仓库内
   `backend/orchestrator/.venv`（worktree 里没有 .venv 时会继续往主工作区找）。
2. **PG 二进制**（含 `initdb`/`pg_ctl`）：发现顺序 `PG_BIN` → `pgserver` 包自带
   `pginstall` → PATH → `C:\Program Files\PostgreSQL\*\bin` → `/usr/lib/postgresql/*/bin`。

> ⚠️ 本机实测：`pgserver 0.1.4` 的二进制是**精简版**（`share/extension` 为空，
> 无 pg_trgm/btree_gist），且它**没有 cp313/cp314 wheel**（Python 3.14 装不上）。
> 本底座走的是 alembic 空库快径（见下），**不需要 contrib 扩展**，所以 POC 遗留的
> `D:\kaas-poc\pginstall\bin` 直接能用。

本机可选的本地覆盖（**gitignored**）：`tests/integration/.pgtest.local`，`KEY=VALUE`：

```
PG_BIN=D:\kaas-poc\pginstall\bin
KAAS_ALEMBIC_PYTHON=...                # 可选
KAAS_TEST_PGDATA=D:\kaas-pgtest        # 纯 ASCII 数据目录（中文用户名下 initdb 会失败）
```

### 2) 用现成库（CI / 已有 PG）

```powershell
$env:TEST_DATABASE_URL='postgresql+asyncpg://kaas:kaas_dev_pw@127.0.0.1:5432/kaas_v2_test'
cd backend/worker
python -m pytest tests/integration -m integration -q
```

仍会跑 `alembic upgrade head`；若外部已经建好 schema，可设
`KAAS_TEST_SKIP_MIGRATE=1` 跳过迁移。**注意**：worker 的 `_acquire` 写死
`ssl=False`，`TEST_DATABASE_URL` 要指向**非 SSL** 库（localhost / 普通 PG）。

### 3) 日常快速门禁（不跑真库）

```powershell
cd backend/worker
python -m pytest tests -m "not integration" -q   # 5 deselected
```

`tests` 全量在无 PG 时同样安全：集成用例整体 skip，其余照常跑（2026-10-21 口径：worker 全量
**1233 passed + 12 skipped**；12 条 db/integration 档按约定 skip，有 docker PG 时这 12 条会真跑、总数 1245）。

## schema 从哪来（重要，附两处已确认的项目级问题）

底座执行 `backend/orchestrator/alembic` 的 `alembic upgrade head`，但实测发现两件事：

1. **空库快径**：`alembic/env.py` 对空库直接 `Base.metadata.create_all()` + stamp head，
   **跳过整条历史迁移链**（`app/db/migration_bootstrap.py`，2026-10-17 决策）。
2. **历史迁移链无法从 base 重放**：`f82ac951b473` 无条件 create 36 张表，与更早的
   `202605030002_flywheel_foundation` 等迁移重复 ⇒ 空库逐条 upgrade 会稳定炸在
   `relation "customer_capabilities" already exists`（本机实测）。所以快径是当前
   唯一能建出「完整 schema」的路径。

因此本底座的 schema = `alembic upgrade head`（空库快径）**+ 幂等补建兜底**：

> **✅ 2026-10-19 已修（原「env.py 漏 import」风险已关闭）**：`backend/orchestrator/alembic/env.py:54-64`
> 现在显式 import **全部模型模块**（`workstation_models` / `market_models` / `actual_cost` /
> `external_docs` / `workstation_links` / `legacy_models`）—— 空库快径建出的表集合与生产一致
> （修复前只建 61 张、生产 109 张；缺 `cust_contacts` 会让 `POST /api/v1/customers` 在全新库 500）。
>
> `conftest.py` 里「用 `workstation_models` metadata `create_all(checkfirst=True)` 只补缺失表」
> 的补偿**仍保留**：它现在是**幂等兜底**（兼容旧分支/旧解释器/建了一半的库），不是对未修 bug 的绕过；
> 其注释里「env.py 漏 import」的历史表述已于 2026-10-21 更正。
> 缺表仍会 fail 而不是静默跑过（断言 `users/teams/customers/cust_contacts/quotations/team_subscriptions` 都在）。

## CI

`.github/workflows/backend-test.yml` 的 `worker-db-tests` job：postgres:16 service +
`TEST_DATABASE_URL`，先在 `backend/orchestrator` `uv sync`（只为拿 alembic 解释器），
再跑 `pytest tests -m integration`。无 PG 的 `worker-tests` job 不受影响（集成用例 skip）。

## 本机实测数字（2026-10-19 快照，Python 3.14.7；当前全量口径见 `AGENTS.md` 门禁）

| 命令 | 结果 |
|---|---|
| `python -m pytest tests/integration -m integration -q` | **5 passed**（约 20s，含 initdb + alembic） |
| `python -m pytest backend/worker -q`（含集成） | **308 passed** |
| `python -m pytest backend/worker -m "not integration" -q` | **303 passed, 5 deselected** |
| 无任何 PG 环境 | 5 skipped（1s，门禁仍绿） |
| `TEST_DATABASE_URL` 指向现成 PG | **5 passed** |

## 已知限制

- 走 alembic 快径 + 补建，schema 与「生产历史迁移后的库」**近似**而非逐字节一致；
  `env.py` 已自 2026-10-19 补齐全模型 import（表集合对齐生产），但快径仍不等于「从 base 重放历史迁移链」。
- 不支持 SSL 测试库（`_acquire` 写死 `ssl=False`，worker 生产侧行为如此）。
- 每个用例前 `TRUNCATE ... RESTART IDENTITY CASCADE` 清业务表（保留 `alembic_version`），
  用例间互不影响；不支持并行跑同一测试库。
