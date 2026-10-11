"""文件域 + 产品媒体 + 单证文件引用

Revision ID: 202610110016
Revises: 202610110015
Create Date: 2026-10-11

用户要求（原话）：
  「产品图片可以在产品管理页面添加，可以添加各种类型的图片（生产/尺寸/重量/成品），
   上传后有一个输入框给图片命名，还可以添加产品的基础信息。单证直接调用产品管理页面的图片。
   这样就做到一次维护，重复使用，一劳永逸。」
  「数据持久化保存在它自己的位置，特别是业务数据。」

设计（见 `docs/PRODUCT_MEDIA_STORAGE_PLAN.md`）：
- **业务行**留在各业务表；**文件元数据**进 `file_objects`（全平台唯一文件域）；
  **文件本体**进对象存储（生产 Cloudflare R2 / 本地 MinIO，S3 兼容同一套代码），
  库里只存 `object_key`。`storage` 列保留 `inline` 兜底，但不作为默认路径。
- 产品图**引用而非复制**：产品图只存一份（`owner_type='product'`），
  单证通过 `trade_doc_files.file_id` 引用 ⇒ 产品图改一次，所有引用它的单证同步生效。
- 盖章回传**版本化**：新版本 `is_current=true`，旧版本 `supersedes_id` 串成版本链留档
  ⇒ 对外展示的是最新盖章件，历史版本不丢。

本迁移**只新增三张表**，不改动任何现有表与列（可安全前滚）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610110016"
down_revision: Union[str, None] = "202610110015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── ① 全平台文件域：文件**元数据**的唯一落点 ──────────────────────────
    op.create_table(
        "file_objects",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("team_id", sa.BigInteger(), nullable=True),
        # 归属：product（产品图）/ trade_doc（单证挂件）/ customer / company
        sa.Column("owner_type", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=True),
        # 用途：product_photo | stamp_scan（客户盖章回传） | render_pdf（系统出的 PDF） | other
        sa.Column("kind", sa.Text(), nullable=False),
        # 产品图细分：production / size / weight / finished（生产/尺寸/重量/成品）
        sa.Column("media_kind", sa.Text(), nullable=True),
        # **用户给图片起的名字**（要求里的"输入框命名"）
        sa.Column("name", sa.Text(), nullable=False),
        # s3（对象存储，默认）| inline（字节入库，仅兜底）
        sa.Column("storage", sa.Text(), nullable=False, server_default="s3"),
        sa.Column("object_key", sa.Text(), nullable=True),
        sa.Column("content", sa.LargeBinary(), nullable=True),
        sa.Column("file_name", sa.Text(), nullable=True),
        sa.Column("content_type", sa.Text(), nullable=True),
        sa.Column("file_size", sa.BigInteger(), nullable=True),
        # 去重与完整性校验
        sa.Column("sha256", sa.Text(), nullable=True),
        # 版本化：新版本上位，旧版本挪出 is_current 并留档
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("supersedes_id", sa.BigInteger(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("uploaded_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["supersedes_id"], ["file_objects.id"], name="fk_file_supersedes"),
    )
    op.create_index("idx_file_objects_owner", "file_objects", ["tenant_id", "owner_type", "owner_id"])
    op.create_index("idx_file_objects_kind", "file_objects", ["tenant_id", "kind", "is_current"])
    op.create_index("idx_file_objects_sha", "file_objects", ["tenant_id", "sha256"])
    # 同一归属 + 同一用途（含产品图细分）只允许一个"当前版本"
    op.create_index(
        "uq_file_current",
        "file_objects",
        ["tenant_id", "owner_type", "owner_id", "kind", "media_kind"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )

    # ── ② 产品基础信息（租户可编辑的补充信息）────────────────────────────
    # 产品本体仍是代码里的 ProductSpec（key: chain_link / field_fence / deer_net），
    # 这里只存**补充信息**，不复制规格定义 ⇒ 不产生"第二套真相"。
    op.create_table(
        "product_profiles",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("product_key", sa.Text(), nullable=False),
        sa.Column("info", postgresql.JSONB(astext_type=sa.Text()), nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("tenant_id", "product_key"),
    )

    # ── ③ 单证 → 文件引用（引用而非复制）──────────────────────────────────
    op.create_table(
        "trade_doc_files",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("trade_doc_id", sa.BigInteger(), nullable=False),
        sa.Column("file_id", sa.BigInteger(), nullable=False),
        # role: product_photo | stamp_scan | render_pdf
        sa.Column("role", sa.Text(), nullable=False),
        # 单证上的图注（可覆盖产品图默认名；留空则用 file_objects.name）
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["file_id"], ["file_objects.id"], name="fk_tdf_file"),
    )
    op.create_index("idx_tdf_doc", "trade_doc_files", ["tenant_id", "trade_doc_id", "role"])
    op.create_index("idx_tdf_file", "trade_doc_files", ["tenant_id", "file_id"])


def downgrade() -> None:
    op.drop_index("idx_tdf_file", table_name="trade_doc_files")
    op.drop_index("idx_tdf_doc", table_name="trade_doc_files")
    op.drop_table("trade_doc_files")
    op.drop_table("product_profiles")
    op.drop_index("uq_file_current", table_name="file_objects")
    op.drop_index("idx_file_objects_sha", table_name="file_objects")
    op.drop_index("idx_file_objects_kind", table_name="file_objects")
    op.drop_index("idx_file_objects_owner", table_name="file_objects")
    op.drop_table("file_objects")
