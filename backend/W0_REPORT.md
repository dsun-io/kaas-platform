# Backend W0 · 基础设施脚手架 · 验收报告 (修正版)

> **阶段**: Backend W0 (Infrastructure Scaffold)
> **分支**: `feature/v2-refactor`
> **修复事项**: 解决第一次提交被 David 打回的 P0 与 P1 阻塞项

---

## 🔴 P0 阻塞项修复情况

### 1. alembic 迁移生成与执行 (Flywheel Foundation)
✅ **已修复**。创建了纯手动 DDL 迁移文件 `202605020001_flywheel_foundation.py`，**未使用** ORM `autogenerate`。
- `events` 表包含了 `id (UUID)`, `created_at`, `trace_id`, `route_version`, `tenant_id`, `event_type`, `schema_version`, `payload`, `sampled`, `source` 字段。
- 实现了 `PARTITION BY RANGE (created_at)`。
- 生成了 `events_2026_05` 和 `events_2026_06` 两个月的分区表。
- 创建了 `events_archive_log` 表及相应字段。

**Terminal 实测输出** (在干净 PG 16 上跑通 `alembic upgrade head` -> `downgrade -1` -> `upgrade head`):
```text
$ uv run alembic upgrade head
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> 202605020001, flywheel_foundation

$ uv run alembic downgrade -1
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running downgrade 202605020001 -> , flywheel_foundation

$ uv run alembic upgrade head
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> 202605020001, flywheel_foundation
```

### 2. events 表按月分区
✅ **已修复**。同上，在迁移脚本中严格执行了 `PARTITION BY RANGE (created_at)`。同时修正了 `models.py` 中 `events` 和 `events_archive_log` 的声明，严格使用 `UUID`，移除了对该表的 ORM 隐式自动建表依赖。

### 3. schema_registry 领域模型
✅ **已修复**。在 `backend/orchestrator/domain/schema_registry.py` 中增加了 W0 要求的 6 个 Pydantic event 模型：
- `UserLoginPayload` (`user.login`)
- `UserLogoutPayload` (`user.logout`)
- `AppCreatePayload` (`app.create`)
- `AppDeletePayload` (`app.delete`)
- `KbSyncJobPayload` (`kb.sync_job`)
- `KbEditPayload` (`kb.edit`)
并在 `PAYLOAD_SCHEMAS` 字典中完成注册。

---

## 🟡 P1 偏离项修复情况

### 1. 目录结构偏差
✅ **已修复**。已将所有代码结构移动至 `backend/orchestrator/`，严格遵循 v2 设计文档的路径要求。`docker-compose.yml` 已同步更新了 build context 和卷挂载路径。

### 2. 依赖管理
✅ **已修复**。删除了不符合铁律的 `requirements.txt`。创建了 `backend/orchestrator/pyproject.toml` 并使用 `uv lock` 锁定了带有 hash 校验的 `uv.lock`，完全杜绝了依赖漂移风险。

### 3. 多租户加载器 TTL
✅ **已修复** (在前序提交中已经将 `lru_cache` 替换为了 `cachetools.TTLCache`)。

---

## 验收请求

David，W0 基础设施脚手架的所有 P0 阻塞项与 P1 偏离项均已修复完毕：
1. Alembic 手动 DDL（分区表）已完成并测试了升降级幂等性。
2. 领域层 `domain/schema_registry.py` 补充了运行时所需的 6 个 Pydantic 模型。
3. 代码结构已归档到 `backend/orchestrator/`。
4. `pyproject.toml` 和 `uv` 锁定了环境依赖。

请审核 W0 的修正结果。如果验收通过，我将启动 W1 阶段（业务路由 + Repository + FastGPT HTTP client 桥接）。
