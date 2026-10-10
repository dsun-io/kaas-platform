"""数据库查询模板 —— SQL 语句与参数化查询（纯函数，可被 SQLAlchemy 或 asyncpg 复用）。

orchestrator（SQLAlchemy）与 worker（asyncpg）绑定方式不同，但 **SQL 语句本身可以共享**。
本模块把常用查询抽成参数化 SQL 模板，两端各自用绑定方式执行，消除 SQL 双份维护。

用法：
    from kaas_common.db.queries import CUSTOMER_LIST, CUSTOMER_BY_ID
    # SQLAlchemy: await db.execute(text(CUSTOMER_BY_ID), {"tenant_id": t, "customer_id": c})
    # asyncpg:    await conn.fetchrow(CUSTOMER_BY_ID, t, c)
"""

__all__ = [
    "CUSTOMER_LIST", "CUSTOMER_BY_ID", "CUSTOMER_INSERT", "CUSTOMER_UPDATE",
    "QUOTE_LIST", "QUOTE_BY_ID", "QUOTE_INSERT", "QUOTE_ITEM_INSERT",
    "ORDER_LIST", "ORDER_BY_ID", "ORDER_INSERT",
    "INQUIRY_LIST", "INQUIRY_INSERT",
]

# ── 客户 ────────────────────────────────────────────────────────────────────

CUSTOMER_LIST = """
SELECT *, name AS company_name
FROM customers
WHERE tenant_id = :tenant_id
  AND is_deleted = false
  AND (:stage IS NULL OR stage = :stage)
  AND (:country IS NULL OR country ILIKE :country)
  AND (:q IS NULL OR name ILIKE :q)
ORDER BY created_at DESC
LIMIT :limit OFFSET :offset
"""

CUSTOMER_BY_ID = """
SELECT *, name AS company_name
FROM customers
WHERE id = :customer_id AND tenant_id = :tenant_id
"""

CUSTOMER_INSERT = """
INSERT INTO customers
  (tenant_id, name, country, address, default_port, credit_level, stage, notes, created_by)
VALUES (:tenant_id, :name, :country, :address, :default_port, :credit_level, :stage, :notes, :created_by)
RETURNING *
"""

CUSTOMER_UPDATE = """
UPDATE customers SET
  name = COALESCE(:name, name),
  country = COALESCE(:country, country),
  address = COALESCE(:address, address),
  default_port = COALESCE(:default_port, default_port),
  credit_level = COALESCE(:credit_level, credit_level),
  stage = COALESCE(:stage, stage),
  notes = COALESCE(:notes, notes)
WHERE id = :customer_id AND tenant_id = :tenant_id
RETURNING *
"""

# ── 报价单 ──────────────────────────────────────────────────────────────────

QUOTE_LIST = """
SELECT * FROM quote_orders
WHERE tenant_id = :tenant_id
  AND (:customer_id IS NULL OR customer_id = :customer_id)
  AND (:status IS NULL OR status = :status)
ORDER BY created_at DESC, id DESC
LIMIT :limit OFFSET :offset
"""

QUOTE_BY_ID = """
SELECT * FROM quote_orders
WHERE id = :quote_id AND tenant_id = :tenant_id
"""

QUOTE_INSERT = """
INSERT INTO quote_orders
  (tenant_id, quote_no, customer_id, customer_name, inquiry_id,
   status, currency, total_amount, valid_until, notes,
   fx_rate, fx_rate_date, created_by, owner_id, owner_scope,
   incoterm, payment_terms, port_of_loading, port_of_destination,
   shipping_marks, country_of_origin)
VALUES (:tenant_id, :quote_no, :customer_id, :customer_name, :inquiry_id,
        'draft', :currency, :total_amount, :valid_until, :notes,
        :fx_rate, :fx_rate_date, :created_by, :created_by, :owner_scope,
        :incoterm, :payment_terms, :port_of_loading, :port_of_destination,
        :shipping_marks, :country_of_origin)
RETURNING *
"""

QUOTE_ITEM_INSERT = """
INSERT INTO quote_order_items
  (tenant_id, quote_order_id, sku_id, product_name, spec_snapshot,
   qty, qty_unit, unit_price, currency, line_amount, sort_order,
   policy_override, price_source, cost_override, price_override,
   weight_override, volume_override, image_url)
VALUES (:tenant_id, :quote_order_id, :sku_id, :product_name, :spec_snapshot,
        :qty, :qty_unit, :unit_price, :currency, :line_amount, :sort_order,
        :policy_override, :price_source, :cost_override, :price_override,
        :weight_override, :volume_override, :image_url)
RETURNING *
"""

# ── 订单 ────────────────────────────────────────────────────────────────────

ORDER_LIST = """
SELECT * FROM orders
WHERE tenant_id = :tenant_id
  AND (:customer_id IS NULL OR customer_id = :customer_id)
  AND (:status IS NULL OR status = :status)
ORDER BY created_at DESC, id DESC
LIMIT :limit OFFSET :offset
"""

ORDER_BY_ID = """
SELECT * FROM orders
WHERE id = :order_id AND tenant_id = :tenant_id
"""

ORDER_INSERT = """
INSERT INTO orders
  (tenant_id, order_no, customer_id, customer_name, status, currency,
   total_amount, order_date, delivery_date, notes,
   created_by, owner_id, owner_scope)
VALUES (:tenant_id, :order_no, :customer_id, :customer_name, 'pending', :currency,
        :total_amount, :order_date, :delivery_date, :notes,
        :created_by, :created_by, :owner_scope)
RETURNING *
"""

# ── 询盘 ────────────────────────────────────────────────────────────────────

INQUIRY_LIST = """
SELECT * FROM cust_inquiries
WHERE tenant_id = :tenant_id
  AND (:customer_id IS NULL OR customer_id = :customer_id)
  AND (:status IS NULL OR status = :status)
ORDER BY created_at DESC
LIMIT :limit OFFSET :offset
"""

INQUIRY_INSERT = """
INSERT INTO cust_inquiries
  (tenant_id, customer_id, channel, category_id, product_name_raw,
   quantity, quantity_unit, application, status, notes, created_by,
   inquiry_seq, spec_snapshot)
VALUES (:tenant_id, :customer_id, :channel, :category_id, :product_name_raw,
        :quantity, :quantity_unit, :application, :status, :notes, :created_by,
        :inquiry_seq, :spec_snapshot)
RETURNING *
"""
