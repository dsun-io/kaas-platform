"""关系自动维护：触发器把归属列同步成边表（P4）

Revision ID: 202610110013
Revises: 202610110012
Create Date: 2026-10-11

依据：`docs/ENTITY_LINKS_OPTIMIZATION.md` §5「自动维护」

为什么用触发器而不是在应用层每个写入点调 helper
------------------------------------------------
应用层 helper 需要在**两端 4 个写入点**各加一次调用（dev `orders.py`/`trade_docs.py`、
worker `main.py`/`quote_api.py`）—— 漏一个就静默丢关系，而且以后新增写入路径还会再漏。
触发器只在**归属列发生变化时**触发，**任何写入路径都无法绕过**，这才是"系统自动维护"。

职责边界（不变）
----------------
- 归属 = 列（`orders.quote_id`、`trade_docs.quote_id`/`order_id`）→ 客户页树的层级
- 关系 = 边表 `entity_links` → 由本触发器从列**自动派生**（变了失效旧的、写新的）

关系失效用**软删**（`deleted_at`）：保留"原本由报价 A 生成、后改为 B"的变更史。

已知边界
--------
- 只覆盖**列能表达的**关系（主归属）。"多张合并成一张"这类**列表达不了**的关系，
  仍由应用层通过 `kaas_common/workstation/entity_links.py` 的语义显式写入。
- 触发器不改 `orders`/`trade_docs` 自身，因此**不会**触碰 `NOT VALID` 约束
  （那条约束只在被更新的行上重新校验）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110013"
down_revision: Union[str, None] = "202610110012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ORDER_FN = """
CREATE OR REPLACE FUNCTION sync_order_links() RETURNS trigger AS $$
BEGIN
  -- 主报价变了 → 旧的边软删（保留变更史）
  IF TG_OP = 'UPDATE' AND OLD.quote_id IS DISTINCT FROM NEW.quote_id
     AND OLD.quote_id IS NOT NULL THEN
    UPDATE entity_links SET deleted_at = now()
     WHERE src_type = 'order' AND src_id = NEW.id AND dst_type = 'quote'
       AND dst_id = OLD.quote_id AND deleted_at IS NULL;
  END IF;
  IF NEW.quote_id IS NOT NULL THEN
    INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)
    VALUES (NEW.tenant_id, 'order', NEW.id, 'quote', NEW.quote_id, 'converted_from')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
"""

_DOC_FN = """
CREATE OR REPLACE FUNCTION sync_trade_doc_links() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.quote_id IS DISTINCT FROM NEW.quote_id AND OLD.quote_id IS NOT NULL THEN
      UPDATE entity_links SET deleted_at = now()
       WHERE src_type = 'trade_doc' AND src_id = NEW.id AND dst_type = 'quote'
         AND dst_id = OLD.quote_id AND deleted_at IS NULL;
    END IF;
    IF OLD.order_id IS DISTINCT FROM NEW.order_id AND OLD.order_id IS NOT NULL THEN
      UPDATE entity_links SET deleted_at = now()
       WHERE src_type = 'trade_doc' AND src_id = NEW.id AND dst_type = 'order'
         AND dst_id = OLD.order_id AND deleted_at IS NULL;
    END IF;
  END IF;
  IF NEW.quote_id IS NOT NULL THEN
    INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)
    VALUES (NEW.tenant_id, 'trade_doc', NEW.id, 'quote', NEW.quote_id, 'generated_from')
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.order_id IS NOT NULL THEN
    INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)
    VALUES (NEW.tenant_id, 'trade_doc', NEW.id, 'order', NEW.order_id, 'generated_from')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    op.execute(sa.text(_ORDER_FN))
    op.execute(sa.text(_DOC_FN))
    op.execute(sa.text(
        "CREATE TRIGGER trg_orders_links AFTER INSERT OR UPDATE OF quote_id ON orders"
        " FOR EACH ROW EXECUTE FUNCTION sync_order_links()"))
    op.execute(sa.text(
        "CREATE TRIGGER trg_trade_docs_links"
        " AFTER INSERT OR UPDATE OF quote_id, order_id ON trade_docs"
        " FOR EACH ROW EXECUTE FUNCTION sync_trade_doc_links()"))

    # 回填：把**列里已有**的归属补成边（触发器只管变更，历史要一次性补）
    op.execute(sa.text(
        "INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
        " SELECT tenant_id, 'order', id, 'quote', quote_id, 'converted_from'"
        " FROM orders WHERE quote_id IS NOT NULL ON CONFLICT DO NOTHING"))
    op.execute(sa.text(
        "INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
        " SELECT tenant_id, 'trade_doc', id, 'quote', quote_id, 'generated_from'"
        " FROM trade_docs WHERE quote_id IS NOT NULL ON CONFLICT DO NOTHING"))
    op.execute(sa.text(
        "INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
        " SELECT tenant_id, 'trade_doc', id, 'order', order_id, 'generated_from'"
        " FROM trade_docs WHERE order_id IS NOT NULL ON CONFLICT DO NOTHING"))


def downgrade() -> None:
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_trade_docs_links ON trade_docs"))
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_orders_links ON orders"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS sync_trade_doc_links()"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS sync_order_links()"))
