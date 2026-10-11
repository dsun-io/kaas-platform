"""产品域团队隔离（R1）：`team_id` 落库 + 两处唯一键改按团队

Revision ID: 202610110019
Revises: 202610110018
Create Date: 2026-10-12

对应 `docs/PRODUCT_MODULE_IMPL_PLAN.md` 的 **P5**，口径以 **§8.1 裁决后的版本**为准：

- **Q1 = B 全私式**：产品**相关信息**（图片 / 基础信息）**一律团队私有**，系统级也不例外；
  历史 `team_id IS NULL` 的行 **保留**且**仅管理员可见**（D3/D4）。
- **Q7 = 允许团队自建 key 与系统级重名** ⇒ 唯一键要按团队收敛。

## ⚠️ "新写入强制、历史容忍 NULL" 为什么**不**做成 `NOT NULL`

裁决原文是"**新写入**强制带 team、**历史容忍 NULL**"。这两条要求**同时**成立，
就只能靠**写路径**强制（P7/P9 在 API 层用 `product_scope` 的判定 + 403 `NO_TEAM`），
而**不能**在库上写 `NOT NULL` —— 那会让历史行直接违反约束（迁移当场失败，
或被迫给历史行编一个 team，而裁决明确**不允许**编：见 D3/D4）。
所以本迁移里 `team_id` **一律可空**，并且**用 `COALESCE(team_id, 0)` 表达"至多一行无归属"**：
Postgres 认为 `NULL` 互不相等，若直接把可空列放进唯一键，**同一租户可以存在多行 NULL**
⇒ 历史数据会出现"一个产品多行基础信息"。折叠成 0 才让"历史最多一行"可被约束表达。

## 本迁移**做**了什么（都是不破坏现役读写的改动）

| 表 | 改动 |
|---|---|
| `product_profiles` | `+ team_id`（可空）+ FK→`teams`(SET NULL) + 索引 |
| `tenant_products` | `+ team_id`（可空）+ FK + 索引；`uq_tenant_products_key` 改成 `(tenant_id, COALESCE(team_id,0), product_key)` |
| `tenant_workstation_products` | `+ team_id`（可空）+ FK + 索引（**唯一键本轮不动**，见下） |
| `file_objects` | 已有 `team_id`；**重建** `uq_file_primary` 为 `(tenant_id, COALESCE(team_id,0), owner_type, owner_id, kind) WHERE is_primary AND is_current` |

## 本迁移**故意不做**的两处（附证据）—— 留给 P9，必须**与两端代码同批**上线

改唯一键会**同时**要求改调用方的 `ON CONFLICT` 目标；只改库不改代码，
那条 `INSERT ... ON CONFLICT` 会直接报
`there is no unique or exclusion constraint matching the ON CONFLICT specification`：

1. **`product_profiles` 主键 `(tenant_id, product_key)` 不动** ——
   两端都在用它做 `ON CONFLICT`：
   `app/api/files.py:283`（orchestrator）与 `backend/worker/src/ws_files.py:319`（worker）。
   本轮若把主键换成"按团队"的表达式唯一索引，两端**保存产品基础信息会全挂**。
   ⚠️ 后果如实记录：在 P9 改完之前，**两个团队仍不能各自持有同一个 `product_key` 的基础信息**
   （Q1=B 的"每团队一份"还差这一步）。
2. **`uq_tenant_ws_product` 不动** ——
   `backend/worker/src/ws_products.py:347` 用 `ON CONFLICT (tenant_id, workstation, product_key)`，
   且 `backend/worker/tests/test_ws_products_seals.py:149` 断言了这个 SQL 字面量。

另外记两条**给后续步骤的硬提醒**（不是本迁移的改动）：

- **P9**：上述两处唯一键 + 两端的 `ON CONFLICT` 必须**同一次提交**改完；
  改 `product_profiles` 主键时，`put_profile` 的冲突目标要同步改成含 `COALESCE(team_id,0)` 的形态。
- **P9/P13**：`TenantProductLoader._fetch_tenant_product` 目前按
  `(tenant_id, product_key, is_active)` 查且用 `scalar_one_or_none()`
  （`app/services/export_quote/tenant_products.py:87-98`）。本轮放宽唯一键之后，
  同租户同 key 的多团队行会让它抛 `MultipleResultsFound` —— 它现在**没有调用者**（已核实），
  但**接线时（P13）必须先补 team 过滤**，否则一接就炸。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110019"
down_revision: Union[str, None] = "202610110018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: 折叠表达式：把"无归属"等价成 0，从而让"至多一行无归属"可被唯一索引表达
#: （裸 NULL 在唯一索引里互不相等 ⇒ 挡不住重复）
_TEAM_KEY = sa.text("COALESCE(team_id, 0)")

# 加 team_id 的三张表（`file_objects` 早已有 team_id，见迁移 202610110016）
_TABLES_ADDING_TEAM = (
    "product_profiles",
    "tenant_products",
    "tenant_workstation_products",
)


def upgrade() -> None:
    # ── ① 三张表加 team_id + FK + 索引（纯增量，不动现役读写）──────────────
    for table in _TABLES_ADDING_TEAM:
        op.add_column(table, sa.Column("team_id", sa.BigInteger(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_team", table, "teams",
            ["team_id"], ["id"], ondelete="SET NULL",
        )
        op.create_index(f"idx_{table}_team", table, ["team_id"])

    # ── ② 租户产品唯一键改按团队（Q7 允许重名）─────────────────────────────
    # 现役没有 ON CONFLICT 依赖它：orchestrator 走 ORM 插入（靠约束抛错），
    # worker 用普通 INSERT 并捕获 "duplicate key"（ws_products.py:192-193，
    # 改名后仍命中 `duplicate key` 分支 ⇒ 409 语义不变）。
    op.drop_index("uq_tenant_products_key", table_name="tenant_products")
    op.create_index(
        "uq_tenant_products_key",
        "tenant_products",
        [sa.text("tenant_id"), _TEAM_KEY, sa.text("product_key")],
        unique=True,
    )

    # ── ③ 产品主图唯一性改按团队（Q1=B：两个团队各自能有主图）───────────────
    # 017 把它建在 (tenant_id, owner_type, owner_id, kind) 上，不含 team ⇒
    # 团队 A 设主图会把团队 B 的主图顶掉/或撞唯一键。
    op.drop_index("uq_file_primary", table_name="file_objects")
    op.create_index(
        "uq_file_primary",
        "file_objects",
        [sa.text("tenant_id"), _TEAM_KEY, sa.text("owner_type"),
         sa.text("owner_id"), sa.text("kind")],
        unique=True,
        postgresql_where=sa.text("is_primary AND is_current"),
    )


def downgrade() -> None:
    # ③ 还原产品主图唯一性（回到 017 的定义）
    op.drop_index("uq_file_primary", table_name="file_objects")
    op.create_index(
        "uq_file_primary",
        "file_objects",
        ["tenant_id", "owner_type", "owner_id", "kind"],
        unique=True,
        postgresql_where=sa.text("is_primary AND is_current"),
    )

    # ② 还原租户产品唯一键（回到 006 的 (tenant_id, product_key)）
    # ⚠️ 若此时库里已存在"同租户同 key、不同团队"的行，本步会因唯一冲突失败 ——
    #    这是**如实**的：回滚一个放宽了唯一性的迁移，本来就要先处置那些行。
    op.drop_index("uq_tenant_products_key", table_name="tenant_products")
    op.create_index(
        "uq_tenant_products_key",
        "tenant_products",
        ["tenant_id", "product_key"],
        unique=True,
    )

    # ① 撤三张表的 team_id
    for table in reversed(_TABLES_ADDING_TEAM):
        op.drop_index(f"idx_{table}_team", table_name=table)
        op.drop_constraint(f"fk_{table}_team", table, type_="foreignkey")
        op.drop_column(table, "team_id")
