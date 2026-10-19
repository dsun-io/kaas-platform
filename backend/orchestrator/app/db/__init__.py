"""Kaas v2 · db package（S4 删壳后仅保留 ORM 模型 + 迁移工具）。

方案 B：**运行时唯一实现 = `backend/worker/src`**（asyncpg）。
orchestrator 目录现在只负责两件事：

1. `app/db/*`：SQLAlchemy 模型（空库快径 `metadata.create_all` 与 `alembic check` 的唯一真源）；
2. `alembic/`：Schema 变更（生产/预览/本地都只走这一条迁移链）。

业务实现（api / services / repositories / domain / schemas / jobs / middleware / core / main）
已于 2026-10-19 S4 全部删除；回退用 `git revert` 该提交。
"""
from app.db.base import Base

__all__ = ["Base"]
