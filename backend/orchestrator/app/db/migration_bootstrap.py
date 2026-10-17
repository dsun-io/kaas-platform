"""空库快径（E1 · UNCERTAIN #20，2026-10-17 决策）—— `alembic upgrade head` 的空库分支。

为什么是快径而不是硬修历史链
----------------------------
历史迁移写于「`create_all` 先建表」时代，链序自相矛盾（`f82ac951b473` 无条件
create 36 张、30 张重复；`quotations` 还是链上后建的）。逐处修补是无底洞
（每修一处就要在真空库上重跑到下一处），业界标准做法是：

- **空库**（无表）⇒ `metadata.create_all()` + stamp `head`，跳过整条历史链；
- **存量库**（有 `alembic_version`）⇒ 老链照常跑，自此**冻结不再修**；
- **半初始化库**（有业务表但无版本记录）⇒ **不吞状态**、照走老链 —— 那是
  真实状态（历史 `create_all` 建过表），静默跳过会让人以为迁移跑过了。

「models 是 schema 唯一真源」由 CI 的 `alembic check`（空库 create_all+stamp 后
必须零漂移）钉住，本模块不兜。

本模块**不依赖 alembic 上下文**（env.py 是脚本、import 即执行迁移，
没法直接单测），判定与建表逻辑是纯分支，可用假 connection 单测。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import inspect as sa_inspect, text as sa_text


def bootstrap_if_empty(
    connection: Any,
    metadata: Any,
    head_revision: str,
) -> bool:
    """空库则 create_all + stamp head；返回 True = 已 bootstrap（跳过 run_migrations）。

    - `connection`：SQLAlchemy 连接（alembic 的 `run_migrations_online` 拿到的那个）；
    - `metadata`：`Base.metadata`（schema 唯一真源）；
    - `head_revision`：当前迁移链的 head revision id（ScriptDirectory.get_current_head）。
    """
    insp = sa_inspect(connection)
    tables = set(insp.get_table_names())
    if tables:
        return False

    metadata.create_all(bind=connection)

    # stamp head：alembic_version 是单列单行表，直接 SQL，不走私有 API
    connection.execute(
        sa_text(
            "CREATE TABLE alembic_version ("
            "version_num VARCHAR(32) NOT NULL, "
            "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
        )
    )
    connection.execute(
        sa_text("INSERT INTO alembic_version (version_num) VALUES (:h)"),
        {"h": head_revision},
    )
    return True
