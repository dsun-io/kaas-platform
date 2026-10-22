"""订单来源（询盘转化 / 直接下单）与确认痕迹

Revision ID: 202610220004
Revises: 202610220003
Create Date: 2026-10-22

业务背景（docs/OPTIMIZATION_PLAN_2026-10-22_INQUIRY_ORDER_MODEL.md）
-------------------------------------------------------------------
P1「订单是二等公民」的根因：`orders` 只有 `quote_id` 一条上游，没有「来源」概念。
于是「直接创建、没有询盘」的订单在客户档案里被归到「其他」桶、询盘数量不增加、
渠道统计无从谈起。本迁移给订单补上**来源三元组**与**确认痕迹**，让订单成为
一等公民，与询盘独立并存。

字段
----
| 列 | 类型 | 语义 |
|----|------|------|
| `source_type`      | text NOT NULL default 'direct' | `inquiry` 询盘转化（含经报价转化） / `direct` 直接下单 |
| `source_channel`   | text NULL                      | 渠道，复用询盘渠道清单 |
| `inquiry_id`       | bigint NULL FK→cust_inquiries  | 询盘溯源；`inquiry` 时必填 |
| `confirmed_at`     | timestamptz NULL               | 订单确认时间 |
| `confirmed_by`     | text NULL                      | 确认人 |
| `confirmed_source` | text NULL                      | `manual` 人工确认 / `deposit_receipt` 定金到账联动 |

约束
----
- `ck_orders_source_inquiry`：`source_type <> 'inquiry' OR inquiry_id IS NOT NULL`
  —— 设计 §3.3 R1「强制关联」的 DB 兜底。业务层必须给出可操作的 422 而不是让
  约束报错，但约束保证任何绕过路径（脚本、后台改库）也写不进脏数据。
- `ck_orders_source_type` / `ck_orders_confirm_source`：值域兜底，与
  `kaas_common/domain/enums.py` 的 `ORDER_SOURCE_TYPE` / `ORDER_CONFIRM_SOURCE` 一致。
- `idx_orders_inquiry`：询盘详情页反查订单、按来源筛选都要走。
- 触发器 `trg_orders_links` 扩展：列清单加 `inquiry_id`、函数补 inquiry 边，
  保证「列有值 ⇒ 关系图上有边」。

`confirmed_source` 为什么**不设 DB 默认值**（设计文档写「默认 manual」）
--------------------------------------------------------------------
设计文档的「默认 manual」指的是**确认动作未指明来源时按 manual 记**，由写入层
补值；DB 列若设 `server_default='manual'`，那么一笔 pending 订单也会带出
`confirmed_source='manual'` 而 `confirmed_at` 为 NULL —— 语义自相矛盾，且报表
按 `confirmed_source` 统计「人工确认单量」会虚高。故列可空，写入层在确认时补
`manual`（见 M1-c）。

存量回填
--------
1. `orders.quote_id → quote_orders.inquiry_id` 存在的订单：`source_type='inquiry'`
   且 `inquiry_id` 落值 —— 这批单确实是询盘转化来的，关系是既成事实。
2. 其余订单（含 `quote_id` 为空、或报价单本身没有询盘来源的）：
   `source_type='direct'`、`source_channel=NULL`。
   渠道**不伪造**：历史单的真实渠道无从得知，前端展示「未知」，由业务按需补录。
3. `cust_inquiries.channel='quote'` → `'other'`：`quote` 是「来源类型」不是
   「渠道」，与新增的 `source_type` 重复表达；渠道枚举已去掉该值（设计 §4 / D-7）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610220004"
down_revision: Union[str, None] = "202610220003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 触发器函数：在 202610110013 的 `sync_order_links()` 基础上补 inquiry 边。
# 为什么必须扩展函数本体而不是只加列到触发器的列清单：只改列清单的话
# `OLD.inquiry_id IS DISTINCT FROM NEW.inquiry_id` 这类引用会直接报错（函数体没变），
# 而函数没这条分支的话 inquiry_id 改了也不会派生边 —— 「列有值、图上没边」。
_ORDER_FN_WITH_INQUIRY = """
CREATE OR REPLACE FUNCTION sync_order_links() RETURNS trigger AS $$
BEGIN
  -- 主报价变了 → 旧的边软删（保留变更史）
  IF TG_OP = 'UPDATE' AND OLD.quote_id IS DISTINCT FROM NEW.quote_id
     AND OLD.quote_id IS NOT NULL THEN
    UPDATE entity_links SET deleted_at = now()
     WHERE src_type = 'order' AND src_id = NEW.id AND dst_type = 'quote'
       AND dst_id = OLD.quote_id AND deleted_at IS NULL;
  END IF;
  -- 询盘来源变了 → 旧边同样软删（转询盘/改挂询盘都要留下痕迹）
  IF TG_OP = 'UPDATE' AND OLD.inquiry_id IS DISTINCT FROM NEW.inquiry_id
     AND OLD.inquiry_id IS NOT NULL THEN
    UPDATE entity_links SET deleted_at = now()
     WHERE src_type = 'order' AND src_id = NEW.id AND dst_type = 'inquiry'
       AND dst_id = OLD.inquiry_id AND deleted_at IS NULL;
  END IF;
  IF NEW.quote_id IS NOT NULL THEN
    INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)
    VALUES (NEW.tenant_id, 'order', NEW.id, 'quote', NEW.quote_id, 'converted_from')
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.inquiry_id IS NOT NULL THEN
    INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)
    VALUES (NEW.tenant_id, 'order', NEW.id, 'inquiry', NEW.inquiry_id, 'converted_from')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    # ── 1. 加列（先可空，回填后再收紧 NOT NULL）──────────────────────────────
    op.add_column(
        "orders",
        sa.Column("source_type", sa.Text(), nullable=False, server_default="direct"),
    )
    op.add_column("orders", sa.Column("source_channel", sa.Text(), nullable=True))
    op.add_column("orders", sa.Column("inquiry_id", sa.BigInteger(), nullable=True))
    op.add_column("orders", sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("orders", sa.Column("confirmed_by", sa.Text(), nullable=True))
    op.add_column("orders", sa.Column("confirmed_source", sa.Text(), nullable=True))

    op.create_foreign_key(
        "fk_orders_inquiry_id", "orders", "cust_inquiries",
        ["inquiry_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index("idx_orders_inquiry", "orders", ["tenant_id", "inquiry_id"])

    # ── 1.5 触发器扩展：inquiry_id 一落就派生 order→inquiry 边 ─────────────────
    # 触发器列清单必须包含 inquiry_id，否则「UPDATE orders SET inquiry_id=…」
    # 根本不触发 —— 客户关系树会漏掉这条边。
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_orders_links ON orders"))
    op.execute(sa.text(_ORDER_FN_WITH_INQUIRY))
    op.execute(sa.text(
        "CREATE TRIGGER trg_orders_links AFTER INSERT OR UPDATE OF quote_id, inquiry_id"
        " ON orders FOR EACH ROW EXECUTE FUNCTION sync_order_links()"))

    # ── 2. 存量回填：经报价单上溯到询盘的订单 = 询盘转化单 ────────────────────
    # 用 UPDATE ... FROM 一条语句完成，避免逐行 UPDATE 在大表上放大成 N 次扫描。
    op.execute(
        sa.text(
            """
            UPDATE orders o
               SET source_type = 'inquiry',
                   inquiry_id  = q.inquiry_id
              FROM quote_orders q
             WHERE o.quote_id = q.id
               AND q.inquiry_id IS NOT NULL
            """
        )
    )
    # 其余保持 server_default 的 'direct'，source_channel 留 NULL（不伪造渠道）。

    # ── 3. 询盘渠道：'quote' 不是渠道，归并为 other ───────────────────────────
    op.execute(sa.text("UPDATE cust_inquiries SET channel = 'other' WHERE channel = 'quote'"))

    # ── 4. 值域与关联约束 ─────────────────────────────────────────────────────
    op.create_check_constraint(
        "ck_orders_source_type", "orders",
        "source_type IN ('inquiry','direct')",
    )
    op.create_check_constraint(
        "ck_orders_source_inquiry", "orders",
        "source_type <> 'inquiry' OR inquiry_id IS NOT NULL",
    )
    op.create_check_constraint(
        "ck_orders_confirm_source", "orders",
        "confirmed_source IS NULL OR confirmed_source IN ('manual','deposit_receipt')",
    )

    # ── 5. 回填边：回填出来的 inquiry_id 也要在关系图上可见 ────────────────────
    # 触发器只管"之后的变更"，第 2 步 UPDATE 发生在触发器建好之后所以已覆盖；
    # 这条 INSERT 兜的是**非本迁移写入**的历史行（脚本直改库等）。
    op.execute(sa.text(
        "INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
        " SELECT tenant_id, 'order', id, 'inquiry', inquiry_id, 'converted_from'"
        " FROM orders WHERE inquiry_id IS NOT NULL ON CONFLICT DO NOTHING"))


def downgrade() -> None:
    # 先删边（否则 inquiry_id 列删了，边还指向已不存在的维度）
    op.execute(sa.text(
        "UPDATE entity_links SET deleted_at = now()"
        " WHERE src_type = 'order' AND dst_type = 'inquiry' AND deleted_at IS NULL"))
    # 触发器回退到 202610110013 的原版（只认 quote_id）
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_orders_links ON orders"))
    op.execute(sa.text(
        "CREATE TRIGGER trg_orders_links AFTER INSERT OR UPDATE OF quote_id ON orders"
        " FOR EACH ROW EXECUTE FUNCTION sync_order_links()"))

    op.drop_constraint("ck_orders_confirm_source", "orders", type_="check")
    op.drop_constraint("ck_orders_source_inquiry", "orders", type_="check")
    op.drop_constraint("ck_orders_source_type", "orders", type_="check")

    # 渠道回填是单向的（'quote' 的原值已不可区分 other），downgrade 不尝试还原。

    op.drop_index("idx_orders_inquiry", table_name="orders")
    op.drop_constraint("fk_orders_inquiry_id", "orders", type_="foreignkey")
    op.drop_column("orders", "confirmed_source")
    op.drop_column("orders", "confirmed_by")
    op.drop_column("orders", "confirmed_at")
    op.drop_column("orders", "inquiry_id")
    op.drop_column("orders", "source_channel")
    op.drop_column("orders", "source_type")
