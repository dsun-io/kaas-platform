"""C22：`file_objects` 当前版本唯一索引补 `NULLS NOT DISTINCT`

Revision ID: 202610200005
Revises: 202610200004
Create Date: 2026-10-21

问题（task-15 真 PG 用例发现）
------------------------------
`uq_file_current` 是**部分唯一索引**：
`(tenant_id, owner_type, owner_id, kind, media_kind) WHERE is_current AND
kind IN ('stamp_scan','render_pdf')`，本意是"同一归属 + 同一用途只允许一个当前版本"。

但列里含可空的 `media_kind`，而真实盖章回传走 `media_kind=None`
（worker `ws_files.py` 的 `upload_doc_file` → `_create_file(..., media_kind=None)`）。
PostgreSQL 唯一索引默认 **NULLS DISTINCT**（NULL 与 NULL 视为不同）⇒ 两条同归属的
"当前 stamp_scan"可以并存 —— 这条约束在真实数据形状下**没有兜底**，目前只靠
应用层 `UPDATE ... is_current=false` 先让位；并发上传仍可能留下两个 current。

本迁移
------
drop + 重建同一个索引，加 `NULLS NOT DISTINCT`（PG15+；本机 PG16、生产 Neon 18 均支持）：
`... UNIQUE ... NULLS NOT DISTINCT WHERE is_current AND kind IN (...)`。
这样 `media_kind IS NULL` 的行之间也会互相冲突，库级兜底才真正生效。

发布前检查（唯一索引要求存量无重复，否则 create 会失败）
------------------------------------------------------
::

    SELECT tenant_id, owner_type, owner_id, kind, media_kind, count(*)
      FROM file_objects
     WHERE is_current AND kind IN ('stamp_scan', 'render_pdf')
     GROUP BY 1,2,3,4,5 HAVING count(*) > 1;

本机 kaas_dev 实测 `file_objects` 为 0 行（无重复）；生产若查出重复行，需先人工
处置（保留最新一条、其余置 is_current=false）再跑本迁移 —— **迁移不做静默删改**。

回滚 = drop + 恢复旧口径（NULLS DISTINCT）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610200005"
down_revision: Union[str, None] = "202610200004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX = "uq_file_current"
_COLUMNS = ["tenant_id", "owner_type", "owner_id", "kind", "media_kind"]
# 与 ORM（app/db/legacy_models.py FileObject.__table_args__）逐字一致
_WHERE = sa.text("is_current AND kind IN ('stamp_scan', 'render_pdf')")


def upgrade() -> None:
    op.drop_index(_INDEX, table_name="file_objects")
    op.create_index(
        _INDEX,
        "file_objects",
        _COLUMNS,
        unique=True,
        postgresql_where=_WHERE,
        postgresql_nulls_not_distinct=True,
    )


def downgrade() -> None:
    op.drop_index(_INDEX, table_name="file_objects")
    op.create_index(
        _INDEX,
        "file_objects",
        _COLUMNS,
        unique=True,
        postgresql_where=_WHERE,
    )
