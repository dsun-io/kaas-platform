"""合并 cust_customers 到 customers，删除旧客户表

[Cleanup 阶段2] David 确认客户档案只留一份：以 customers 为准。
upgrade：
  1. customers 补齐客户档案业务列（原 cust_customers 的列）+ legacy_cust_id 合并映射键
  2. cust_customers 数据全部迁入 customers（id 重新分配，旧 id 存入 legacy_cust_id）
  3. 三张子表（cust_contacts / cust_inquiries / cust_stage_log）的 customer_id 改指 customers.id
  4. 删除 cust_customers（含两个索引）
downgrade 可完整还原：旧表按原 DDL 重建、数据按 legacy_cust_id 还原原 id、
三张子表指针改回、customers 上的合并列移除（合并后新建的客户通过 tenant+name 回写映射）。
"""

from alembic import op
import sqlalchemy as sa


revision = "202609230004"
down_revision = "202609230002"
branch_labels = None
depends_on = None


_CHILD_TABLES = ["cust_contacts", "cust_inquiries", "cust_stage_log"]
# 无 naming_convention，PG 默认约束名：{table}_{column}_fkey
_FK_NAMES = {
    "cust_contacts": "cust_contacts_customer_id_fkey",
    "cust_inquiries": "cust_inquiries_customer_id_fkey",
    "cust_stage_log": "cust_stage_log_customer_id_fkey",
}


def upgrade() -> None:
    # 1. customers 补齐客户档案业务列
    op.add_column("customers", sa.Column("country", sa.Text(), nullable=True))
    op.add_column("customers", sa.Column("address", sa.Text(), nullable=True))
    op.add_column("customers", sa.Column("default_port", sa.Text(), nullable=True))
    op.add_column("customers", sa.Column("credit_level", sa.Text(), nullable=True))
    op.add_column("customers", sa.Column("stage", sa.Text(), nullable=False, server_default="lead"))
    op.add_column("customers", sa.Column("notes", sa.Text(), nullable=True))
    op.add_column("customers", sa.Column("created_by", sa.Text(), nullable=True))
    op.add_column("customers", sa.Column("owner_id", sa.Text(), nullable=True))
    op.add_column("customers", sa.Column("owner_scope", sa.Text(), nullable=False, server_default="private"))
    op.add_column("customers", sa.Column("legacy_cust_id", sa.BigInteger(), nullable=True))

    # 2. 数据迁移：旧 id 存入 legacy_cust_id（新 id 走 customers 序列，避免与既有行冲突）
    op.execute(
        """
        INSERT INTO customers
            (tenant_id, name, country, address, default_port, credit_level,
             stage, notes, created_by, owner_id, owner_scope,
             created_at, updated_at, legacy_cust_id)
        SELECT tenant_id, company_name, country, address, default_port, credit_level,
               stage, notes, created_by, owner_id, owner_scope,
               created_at, updated_at, id
        FROM cust_customers
        """
    )

    # 3. 三张子表指针改指 customers.id
    for table in _CHILD_TABLES:
        op.execute(
            f"""
            UPDATE {table} c
            SET customer_id = cu.id
            FROM customers cu
            WHERE cu.legacy_cust_id = c.customer_id
            """
        )
        op.drop_constraint(_FK_NAMES[table], table, type_="foreignkey")
        op.create_foreign_key(
            _FK_NAMES[table], table, "customers",
            ["customer_id"], ["id"], ondelete="CASCADE",
        )

    # 4. 删除旧表（两个索引随表删除）
    op.drop_table("cust_customers")


def downgrade() -> None:
    # 1. 按原 DDL 重建旧表（与 20260919_customers_market_subs + 20260921 补列一致）
    op.create_table(
        "cust_customers",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("company_name", sa.Text(), nullable=False),
        sa.Column("country", sa.Text(), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("default_port", sa.Text(), nullable=True),
        sa.Column("credit_level", sa.Text(), nullable=True),
        sa.Column("stage", sa.Text(), nullable=False, server_default="lead"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("owner_id", sa.Text(), nullable=True),
        sa.Column("owner_scope", sa.Text(), nullable=False, server_default="private"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_cust_customers_tenant_stage", "cust_customers", ["tenant_id", "stage"], unique=False)
    op.create_index("idx_cust_customers_tenant_country", "cust_customers", ["tenant_id", "country"], unique=False)

    # 2. 合并前的行按原 id 还原
    op.execute(
        """
        INSERT INTO cust_customers
            (id, tenant_id, company_name, country, address, default_port, credit_level,
             stage, notes, created_by, owner_id, owner_scope, created_at, updated_at)
        SELECT legacy_cust_id, tenant_id, name, country, address, default_port, credit_level,
               stage, notes, created_by, owner_id, owner_scope, created_at, updated_at
        FROM customers
        WHERE legacy_cust_id IS NOT NULL
        """
    )
    # 显式 id 插入不推进序列，先对齐再插入合并后新建的行
    op.execute(
        "SELECT setval('cust_customers_id_seq', "
        "COALESCE((SELECT MAX(id) FROM cust_customers), 1))"
    )
    op.execute(
        """
        INSERT INTO cust_customers
            (tenant_id, company_name, country, address, default_port, credit_level,
             stage, notes, created_by, owner_id, owner_scope, created_at, updated_at)
        SELECT tenant_id, name, country, address, default_port, credit_level,
               stage, notes, created_by, owner_id, owner_scope, created_at, updated_at
        FROM customers
        WHERE legacy_cust_id IS NULL
        """
    )
    # 合并后新建的行回写映射（tenant+公司名业务上唯一）
    op.execute(
        """
        UPDATE customers c
        SET legacy_cust_id = cc.id
        FROM cust_customers cc
        WHERE c.legacy_cust_id IS NULL
          AND cc.tenant_id = c.tenant_id
          AND cc.company_name = c.name
        """
    )

    # 3. 三张子表指针改回 cust_customers.id
    for table in _CHILD_TABLES:
        op.execute(
            f"""
            UPDATE {table} c
            SET customer_id = cu.legacy_cust_id
            FROM customers cu
            WHERE cu.id = c.customer_id
            """
        )
        op.drop_constraint(_FK_NAMES[table], table, type_="foreignkey")
        op.create_foreign_key(
            _FK_NAMES[table], table, "cust_customers",
            ["customer_id"], ["id"], ondelete="CASCADE",
        )

    # 4. 移除 customers 上的合并列
    op.drop_column("customers", "legacy_cust_id")
    op.drop_column("customers", "owner_scope")
    op.drop_column("customers", "owner_id")
    op.drop_column("customers", "created_by")
    op.drop_column("customers", "notes")
    op.drop_column("customers", "stage")
    op.drop_column("customers", "credit_level")
    op.drop_column("customers", "default_port")
    op.drop_column("customers", "address")
    op.drop_column("customers", "country")
