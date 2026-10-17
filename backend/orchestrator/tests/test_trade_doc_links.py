"""单证关系写入（边表 `entity_links`）的单测 —— 不依赖数据库。

为什么单独钉这一层：2026-10-11 旧 refs 表退场后，**列表达不了的两类关系**
（单证 ← 询盘、单证 ← 单证派生）只能显式写边表。这类写入点**漏写不会报错**，
只会让"这张单证从哪来"永久消失 —— 所以必须有单测钉住 SQL 与参数，
而不是只靠 db 类用例（本机没起测试库时它们直接 skip）。
"""
import pytest

from app.api import trade_docs as td

# 本文件只用假 session，不碰真库 —— 必须登记 `unit`，否则 `pytest -m unit`
# 会把它整文件静默 deselect（"测试没跑"比"测试失败"更危险）
pytestmark = pytest.mark.unit


class _FakeResult:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def mappings(self):
        return self

    def all(self):
        return self._rows


class _FakeSession:
    """冒充 AsyncSession：只记 (sql, params)，不碰数据库。"""

    def __init__(self, rows=None):
        self.calls: list[tuple[str, dict]] = []
        self._rows = rows or []

    async def execute(self, statement, params=None):
        self.calls.append((str(statement), params or {}))
        return _FakeResult(self._rows)


# ── 写：列表达不了的关系进边表 ───────────────────────────────────────────────

async def test_insert_links_writes_entity_links_with_kernel_sql():
    db = _FakeSession()
    await td._insert_links(db, "default", 12, [
        ("inquiry", 4, "generated_from", None),
        ("trade_doc", 9, "revision_of", {"origin_ref_type": "derived_from"}),
    ])

    assert len(db.calls) == 2
    for sql, _ in db.calls:
        assert "INSERT INTO entity_links" in sql
        assert "ON CONFLICT" in sql          # 幂等：重复建立同一关系不算错

    _, first = db.calls[0]
    assert first == {"tenant_id": "default", "src_type": "trade_doc", "src_id": 12,
                     "dst_type": "inquiry", "dst_id": 4,
                     "rel_type": "generated_from", "meta": None, "created_by": None}
    _, second = db.calls[1]
    assert second["dst_type"] == "trade_doc" and second["rel_type"] == "revision_of"
    # 原字面量必须留下：否则详情里的 refs["docs"][].ref_type 就从 derived_from 变了。
    # 注意 meta 是 **JSON 文本**：这里走 `text()` 裸 SQL，asyncpg 不会把 dict 编码进
    # jsonb 参数（报 'dict' object has no attribute 'encode'），写入前必须 json.dumps。
    import json
    assert json.loads(second["meta"]) == {"origin_ref_type": "derived_from"}


async def test_insert_links_skips_empty_targets_and_rejects_unknown_rel():
    db = _FakeSession()
    await td._insert_links(db, "default", 12, [("inquiry", None, "generated_from", None)])
    assert db.calls == []                    # 空父对象不写边（与旧 refs 表一致）

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        await td._insert_links(db, "default", 12, [("inquiry", 4, "derived_from", None)])
    # `derived_from` 不在内核 REL_TYPES 里 —— 错误体与仓库其它 422 同形
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "UNKNOWN_REL_TYPE"


# ── 读：列优先 + 边表兜底 + ref_type 还原 ────────────────────────────────────

async def test_active_links_sql_filters_soft_deleted_and_scopes_tenant():
    db = _FakeSession()
    rows = await td._active_links(db, "default", 12, "quote")
    assert rows == []
    sql, params = db.calls[0]
    # 软删的边属于"关系变更史"，不能出现在详情里
    assert "deleted_at IS NULL" in sql
    assert params == {"tenant_id": "default", "src_id": 12, "dst_type": "quote"}


async def test_active_links_returns_meta_for_ref_type_restore():
    db = _FakeSession(rows=[{"dst_id": 9, "rel_type": "revision_of",
                             "meta": {"origin_ref_type": "derived_from"}}])
    rows = await td._active_links(db, "default", 12, "trade_doc")
    assert rows == [{"dst_id": 9, "rel_type": "revision_of",
                     "meta": {"origin_ref_type": "derived_from"}}]
    # 旧 refs 表的 ref_type 字面量被还原（字段级等价，不是"改了个更现代的词"）
    assert td._link_ref_type(rows[0]) == "derived_from"
    # 没有 meta 的边（触发器派生 / 历史数据）直接用 rel_type
    assert td._link_ref_type({"dst_id": 2, "rel_type": "generated_from", "meta": None}) \
        == "generated_from"


async def test_doc_upstream_links_shape_matches_legacy_refs(monkeypatch):
    """四类 refs 的字段名与旧 `trade_doc_*_refs` 读取逐字相同。"""
    db = _FakeSession()
    quotes = [{"dst_id": 7, "rel_type": "generated_from", "meta": None}]
    docs = [{"dst_id": 3, "rel_type": "revision_of",
             "meta": {"origin_ref_type": "derived_from"}}]

    class _Doc:
        id = 12
        quote_id = 7          # 列有值 → 以列为准
        order_id = None

    async def _fake_active_links(_db, _tenant, _src_id, dst_type):
        return {"quote": quotes, "trade_doc": docs}.get(dst_type, [])

    monkeypatch.setattr(td, "_active_links", _fake_active_links)
    refs = await td._doc_upstream_links(db, "default", _Doc())

    assert refs["quotes"] == [{"quote_order_id": 7, "ref_type": "generated_from"}]
    assert refs["docs"] == [{"source_trade_doc_id": 3, "ref_type": "derived_from"}]
    assert refs["orders"] == [] and refs["inquiries"] == []


async def test_resolve_doc_quote_id_falls_back_to_edge_when_column_null():
    """历史行（`customer_id IS NULL`，迁移 012 刻意没回填列）靠边表兜底。"""
    db = _FakeSession()

    class _Doc:
        id = 12
        quote_id = None

    assert await td._resolve_doc_quote_id(db, "default", _Doc()) is None   # 无有效边 → None
