"""旧 refs 表退场：先补齐边表，再改名 `*_legacy` 留档（不删表、不删行）

Revision ID: 202610110014
Revises: 202610110013
Create Date: 2026-10-11

依据：`docs/ENTITY_LINKS_OPTIMIZATION.md` §7 P4「删除旧表引用 → 旧表重命名 `*_legacy`」

为什么改名而不是 DROP
---------------------
这 5 张 refs 表是**关系的历史账本**（哪张单证由哪张报价生成、哪张单证从哪张派生）。
改名 `_legacy` = 保留全部行、仍可人工查阅/对账，但**代码里不再有读写**；
DROP 会把这段历史一次性抹掉 —— 与"不丢数据"的硬要求冲突。

本迁移三步
----------
**一、补齐边表**：把 5 张旧表里**还没进 `entity_links`** 的关系补进去。
为什么必须补：`trg_trade_docs_links` / `trg_orders_links` 只能从**列**派生关系，
而 `trade_doc_inquiry_refs`（单证 ← 询盘）与 `trade_doc_doc_refs`（单证 ← 单证派生）
**没有对应的列**（`trade_docs` 只有 `order_id`/`quote_id`）—— 不补就等于改名即丢关系。
补法是幂等的（`ON CONFLICT DO NOTHING` + 与触发器相同的 `rel_type` 取值），
所以对已经由触发器派生过的行不会重复插入。

**字段级不变量**：唯一需要"翻译"的是 `trade_doc_doc_refs.ref_type='derived_from'`
（内核 `REL_TYPES` 里没有这个取值）。写入用语义等价的 `revision_of`，
同时把原字面量存进 `meta.origin_ref_type`；读取时由 `_link_ref_type` 还原 ——
于是 `GET /trade-docs/{id}` 的 `refs["docs"][].ref_type` **仍是 `derived_from`**。

**二、改名留档**：`<表>` → `<表>_legacy`（`ALTER TABLE ... RENAME TO`，只动名字）。
对已经改过名的库幂等（先 `to_regclass` 探存在）。

**三、加注释**：给每张 `_legacy` 表写 `COMMENT ON TABLE`，说明已由 `entity_links`
取代、仅留档、勿再读写 —— 下一个人打开 psql 就能看到，不必翻代码猜。

行数核对（执行前，本库 dev）
---------------------------
    order_quote_refs         0
    trade_doc_quote_refs     3        ← 三张历史演示单证（doc 2/3/4 → quote 2/3/4）
    trade_doc_order_refs     0
    trade_doc_inquiry_refs   0
    trade_doc_doc_refs       0
改名只动名字，行数在迁移前后**逐表一致**（见回复里的 before/after 对比）。

不动的表（有意）
----------------
`order_shipment_refs` / `quote_order_shipment_refs`（订单/报价 ↔ 商情雷达货运记录）：
关系两端有一端是**外部平台数据**（shipment 不在本库事务里），且列表达不了"一订单多次出运"，
本批次任务书未把它列入退场范围 —— 保留原样，留待单独批次评估。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110014"
down_revision: Union[str, None] = "202610110013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 旧表 → 留档名（顺序无关，逐一探存在后再改名）
LEGACY_TABLES = (
    "order_quote_refs",
    "trade_doc_quote_refs",
    "trade_doc_order_refs",
    "trade_doc_inquiry_refs",
    "trade_doc_doc_refs",
)

LEGACY_COMMENT = (
    "已由 entity_links 取代（迁移 202610110012/202610110013 建立），"
    "仅留档、勿再读写；新关系一律写 entity_links，归属写主归属列"
)


def _table_exists(table: str) -> bool:
    """按 search_path 判断表是否存在（`to_regclass` 不存在时返回 NULL，不报错）。"""
    return bool(op.get_bind().execute(
        sa.text("SELECT to_regclass(:t) IS NOT NULL"), {"t": table}
    ).scalar())


def upgrade() -> None:
    # ── 一、补齐边表（改名之前，旧表还在，能读）──────────────────────────
    #
    # 每一条都与迁移 012/013 的派生口径对齐：
    #   - 订单 ← 报价：rel_type 沿用旧表自己的 ref_type（历史是 'converted_from'）
    #   - 单证 ← 报价/订单：同上（历史是 'generated_from'）
    #   - 单证 ← 询盘：'generated_from'（没有列，只能靠边表承载）
    #   - 单证 ← 单证派生：旧表 ref_type 是 'derived_from'，而内核 REL_TYPES 里
    #     没有这个取值（合法性由 `normalize_edge` 校验，见 kaas_common）——
    #     映射到语义等价的 'revision_of'（改版/派生自），并把原字面量存进
    #     `meta.origin_ref_type`，读侧 `_link_ref_type` 还原旧字段值（见文件头）。
    backfills = (
        # 订单 ← 报价
        ("order_quote_refs",
         "INSERT INTO entity_links"
         " (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
         " SELECT tenant_id, 'order', order_id, 'quote', quote_order_id,"
         "        COALESCE(ref_type, 'converted_from')"
         "   FROM order_quote_refs"
         "  WHERE order_id IS NOT NULL AND quote_order_id IS NOT NULL"
         " ON CONFLICT DO NOTHING"),
        # 单证 ← 报价
        ("trade_doc_quote_refs",
         "INSERT INTO entity_links"
         " (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
         " SELECT tenant_id, 'trade_doc', trade_doc_id, 'quote', quote_order_id,"
         "        COALESCE(ref_type, 'generated_from')"
         "   FROM trade_doc_quote_refs"
         "  WHERE trade_doc_id IS NOT NULL AND quote_order_id IS NOT NULL"
         " ON CONFLICT DO NOTHING"),
        # 单证 ← 订单
        ("trade_doc_order_refs",
         "INSERT INTO entity_links"
         " (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
         " SELECT tenant_id, 'trade_doc', trade_doc_id, 'order', order_id,"
         "        COALESCE(ref_type, 'generated_from')"
         "   FROM trade_doc_order_refs"
         "  WHERE trade_doc_id IS NOT NULL AND order_id IS NOT NULL"
         " ON CONFLICT DO NOTHING"),
        # 单证 ← 询盘（**没有列**，边表是唯一载体）
        ("trade_doc_inquiry_refs",
         "INSERT INTO entity_links"
         " (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
         " SELECT tenant_id, 'trade_doc', trade_doc_id, 'inquiry', inquiry_id,"
         "        COALESCE(ref_type, 'generated_from')"
         "   FROM trade_doc_inquiry_refs"
         "  WHERE trade_doc_id IS NOT NULL AND inquiry_id IS NOT NULL"
         " ON CONFLICT DO NOTHING"),
        # 单证 ← 单证派生（**没有列**；'derived_from' → 'revision_of'，见上）
        # 原字面量存进 `meta.origin_ref_type`：读取时由 `_link_ref_type` 还原，
        # 于是详情接口的 `refs["docs"][].ref_type` 仍是 `derived_from` —— 字段级不变。
        ("trade_doc_doc_refs",
         "INSERT INTO entity_links"
         " (tenant_id, src_type, src_id, dst_type, dst_id, rel_type, meta)"
         " SELECT tenant_id, 'trade_doc', trade_doc_id, 'trade_doc', source_trade_doc_id,"
         "        CASE COALESCE(ref_type, 'derived_from')"
         "             WHEN 'derived_from' THEN 'revision_of'"
         "             ELSE COALESCE(ref_type, 'revision_of') END,"
         "        jsonb_build_object('origin_ref_type', COALESCE(ref_type, 'derived_from'))"
         "   FROM trade_doc_doc_refs"
         "  WHERE trade_doc_id IS NOT NULL AND source_trade_doc_id IS NOT NULL"
         # 自环（自己派生自己）是脏数据：写成边会撞内核的 SELF_LINK 语义，跳过而不是写歪
         "    AND trade_doc_id <> source_trade_doc_id"
         " ON CONFLICT DO NOTHING"),
    )
    for table, sql in backfills:
        if _table_exists(table):
            op.execute(sa.text(sql))

    # ── 二、改名留档 + 三、注释 ────────────────────────────────────────
    for table in LEGACY_TABLES:
        if not _table_exists(table):
            # 全新库可能从未建过其中某张表（历史迁移的分支差异）——跳过，不制造半成品
            continue
        legacy = f"{table}_legacy"
        op.execute(sa.text(f"ALTER TABLE {table} RENAME TO {legacy}"))
        # 注释写"为什么"：表名里的 _legacy 只说明状态，不说明替代者与纪律
        op.execute(sa.text(f"COMMENT ON TABLE {legacy} IS '{LEGACY_COMMENT}'"))


def downgrade() -> None:
    """退回旧表名（并移除注释）。**不删边表数据** —— 边表是新的权威关系来源。"""
    for table in LEGACY_TABLES:
        legacy = f"{table}_legacy"
        if not _table_exists(legacy):
            continue
        op.execute(sa.text(f"COMMENT ON TABLE {legacy} IS NULL"))
        op.execute(sa.text(f"ALTER TABLE {legacy} RENAME TO {table}"))
