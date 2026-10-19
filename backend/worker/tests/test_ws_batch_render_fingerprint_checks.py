"""Worker 侧「批量对账」端点的单测（task-17 单张端点的批量版）。

为什么需要这个文件
------------------
单张对账只能一张一张问；用户要的是"一次知道**哪些**单据被改了"。
批量端点的坏法全是**静默**的（与 orchestrator 侧同源）：

1. **假匹配**：某张装配失败却被算进 `matched` ⇒ 用户据此认定"这批没问题"，实际没比过；
2. **桶漏一张**：六个桶加起来不等于 `total` ⇒ 少掉的那张被读成"没问题"；
3. **一张炸了拖垮整批**：第 3 张抛异常 ⇒ 前 2 张的结论也拿不到；
4. **路径被动态路由吃掉**：worker 的路由顺序是 main.py 先、本模块（末尾 import）后，
   `/api/v1/trade-docs/{doc_id}` 的路径正则是不带 int 转换器的 `[^/]+`
   ⇒ 请求先被它匹配、再在参数校验处 422。所以批量端点用 3 段静态路径，
   本文件钉住"首个 FULL 匹配就是它"。

判定、入参校验、卡片/汇总口径都在共享内核
`kaas_common.trade_doc.render_fingerprint`（与 orchestrator 同一镜像），
这里验的是 **worker 侧接线**（取数、逐张调用、组装）。
"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_docs_ext  # noqa: E402,F401  (import 即注册路由)
from kaas_common.trade_doc import (  # noqa: E402
    RENDER_CHECK_CARD_FIELDS,
    RENDER_CHECK_CARD_UNAVAILABLE,
    RENDER_CHECK_DOC_IDS_INVALID,
    RENDER_CHECK_DOC_IDS_LIMIT,
    RENDER_CHECK_DOC_IDS_REQUIRED,
    RENDER_CHECK_MAX_DOCS,
    RENDER_CHECK_SUMMARY_FIELDS,
    RENDER_KEY,
    RENDER_VERSION,
    render_check_card,
    render_fingerprint,
    summarize_render_checks,
)

BATCH_PATH = "/api/v1/trade-docs/render-fingerprint-checks/batch"
FROZEN_AT = "2026-10-12T09:00:00+00:00"
USER = {"id": 1}

ASSEMBLED = {
    "seller": {"company": "KAAS TRADING CO., LTD"},
    "buyer": {"name": "BABAN KORI"},
    "items": [{"product_name": "Chain Link Fence", "qty": 100, "unit_price": 12.5,
               "line_amount": 1250.0}],
    "currency": "USD",
    "total_amount": 1250.0,
    "pi_no": "PI-202610-0001",
}


def _copy(**overrides):
    data = {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v)
            for k, v in ASSEMBLED.items()}
    data.update(overrides)
    return data


def _payload(**meta_overrides):
    meta = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
    meta.update(meta_overrides)
    return {"sources": {}, "custom": {}, RENDER_KEY: meta}


def _doc(doc_id, payload, doc_no=None):
    return {"id": doc_id, "doc_type": "pi", "status": "issued",
            "doc_no": doc_no or f"PI-202610-{doc_id:04d}", "raw_payload": payload}


class _FakeDb:
    """只实现 `fetch`（批量端点一次 IN 查询；想造"单据不存在"就少给一行）。"""

    def __init__(self, *rows):
        self._rows = list(rows)
        self.calls: list[tuple] = []

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append((sql, args, table))
        return list(self._rows)


def _run(coro):
    return asyncio.run(coro)


def _assembly_by_id(mapping, calls=None):
    async def _fake(doc_id, request, user):
        if calls is not None:
            calls.append(doc_id)
        value = mapping[doc_id]
        if isinstance(value, Exception):
            raise value
        return {"data": value}

    return _fake


def _call(doc_ids, rows=(), assembly=None, monkeypatch=None):
    db = _FakeDb(*rows)
    monkeypatch.setattr(ws_docs_ext, "db", db)
    if assembly is not None:
        monkeypatch.setattr(ws_docs_ext._main, "get_trade_doc_render_data", assembly)
    out = _run(ws_docs_ext.batch_check_trade_doc_render_fingerprints(
        object(), doc_ids=doc_ids, user=USER))
    return out, db


# ── 正常批量：混合 reason ───────────────────────────────────────────────────

class TestBatchHappyPath:
    def test_mixed_reasons_and_summary(self, monkeypatch):
        rows = [
            _doc(1, _payload(), "PI-1"),
            _doc(2, _payload(), "PI-2"),
            _doc(3, _payload(render_version=RENDER_VERSION - 1), "PI-3"),
            _doc(4, {"sources": {}, "custom": {}}, "PI-4"),
        ]
        assembly = _assembly_by_id({1: _copy(), 2: _copy(total_amount=7777.0),
                                    3: _copy(), 4: _copy()})
        out, db = _call("1,2,3,4", rows, assembly, monkeypatch)

        assert tuple(out) == ("total", "matched", "data_changed", "version_drift",
                              "no_fingerprint", "unavailable", "items")
        assert [c["doc_id"] for c in out["items"]] == [1, 2, 3, 4]
        assert [c["doc_no"] for c in out["items"]] == ["PI-1", "PI-2", "PI-3", "PI-4"]
        assert [c["reason"] for c in out["items"]] == [
            "matched", "data_changed", "version_drift", "no_fingerprint"]
        assert all(tuple(c) == RENDER_CHECK_CARD_FIELDS for c in out["items"])
        assert out["total"] == 4 and out["matched"] == 1 and out["data_changed"] == 1
        assert out["version_drift"] == 1 and out["no_fingerprint"] == 1
        assert out["unavailable"] == 0
        assert (out["matched"] + out["data_changed"] + out["version_drift"]
                + out["no_fingerprint"] + out["unavailable"]) == out["total"]
        assert len(db.calls) == 1

    def test_query_is_tenant_scoped(self, monkeypatch):
        assembly = _assembly_by_id({1: _copy()})
        out, db = _call("1", [_doc(1, _payload(), "PI-1")], assembly, monkeypatch)
        (sql, args, table), = db.calls
        assert "trade_docs" in sql and "tenant_id" in sql
        assert table == "trade_docs"                    # jsonb raw_payload 要解码
        assert args == ("default", [1])
        assert out["matched"] == 1

    def test_duplicate_ids_assemble_once(self, monkeypatch):
        calls: list[int] = []
        out, _db = _call("1,1,1", [_doc(1, _payload(), "PI-1")],
                         _assembly_by_id({1: _copy()}, calls), monkeypatch)
        assert calls == [1]
        assert out["total"] == 1 and out["matched"] == 1


# ── 一张炸了，其余照交付 ────────────────────────────────────────────────────

class TestBatchResilience:
    def test_one_card_explodes_others_still_delivered(self, monkeypatch):
        rows = [_doc(i, _payload(), f"PI-{i}") for i in (1, 2, 3)]
        real = ws_docs_ext._check_one_doc_render_fingerprint

        async def _flaky(d, doc_id, request, user):
            if doc_id == 2:
                raise RuntimeError("card exploded")
            return await real(d, doc_id, request, user)

        monkeypatch.setattr(ws_docs_ext, "_check_one_doc_render_fingerprint", _flaky)
        assembly = _assembly_by_id({1: _copy(), 2: _copy(), 3: _copy()})
        out, _db = _call("1,2,3", rows, assembly, monkeypatch)

        by_id = {c["doc_id"]: c for c in out["items"]}
        assert by_id[2]["reason"] == RENDER_CHECK_CARD_UNAVAILABLE
        assert by_id[2]["error"] == "RuntimeError"
        assert by_id[2]["matches"] is False
        assert by_id[2]["doc_no"] == "PI-2"
        assert by_id[1]["reason"] == "matched" and by_id[3]["reason"] == "matched"
        assert out["matched"] == 2 and out["unavailable"] == 1

    def test_missing_document_is_a_card_not_a_batch_404(self, monkeypatch):
        out, _db = _call("1,2", [_doc(1, _payload(), "PI-1")],
                         _assembly_by_id({1: _copy()}), monkeypatch)
        by_id = {c["doc_id"]: c for c in out["items"]}
        assert by_id[1]["reason"] == "matched"
        assert by_id[2]["reason"] == RENDER_CHECK_CARD_UNAVAILABLE
        assert by_id[2]["error"] == "DOC_NOT_FOUND"
        assert by_id[2]["doc_no"] is None and by_id[2]["matches"] is False
        assert out["matched"] == 1 and out["unavailable"] == 1

    def test_assembly_failure_never_counts_as_matched(self, monkeypatch):
        out, _db = _call("1", [_doc(1, _payload(), "PI-1")],
                         _assembly_by_id({1: RuntimeError("boom")}), monkeypatch)
        card = out["items"][0]
        assert card["reason"] == "current_unavailable"
        assert card["matches"] is False
        assert out["matched"] == 0 and out["unavailable"] == 1


# ── 入参 400（且不碰库）─────────────────────────────────────────────────────

class TestBatchValidation:
    @pytest.mark.parametrize("raw", [None, "", ",,"])
    def test_empty_doc_ids_is_400(self, raw, monkeypatch):
        from fastapi import HTTPException

        db = _FakeDb()
        monkeypatch.setattr(ws_docs_ext, "db", db)
        with pytest.raises(HTTPException) as ei:
            _run(ws_docs_ext.batch_check_trade_doc_render_fingerprints(
                object(), doc_ids=raw, user=USER))
        assert ei.value.status_code == 400
        assert ei.value.detail["code"] == RENDER_CHECK_DOC_IDS_REQUIRED
        assert db.calls == []

    def test_invalid_token_is_400(self, monkeypatch):
        from fastapi import HTTPException

        db = _FakeDb()
        monkeypatch.setattr(ws_docs_ext, "db", db)
        with pytest.raises(HTTPException) as ei:
            _run(ws_docs_ext.batch_check_trade_doc_render_fingerprints(
                object(), doc_ids="1,abc", user=USER))
        assert ei.value.status_code == 400
        assert ei.value.detail["code"] == RENDER_CHECK_DOC_IDS_INVALID
        assert db.calls == []

    def test_over_limit_is_400(self, monkeypatch):
        from fastapi import HTTPException

        db = _FakeDb()
        monkeypatch.setattr(ws_docs_ext, "db", db)
        with pytest.raises(HTTPException) as ei:
            _run(ws_docs_ext.batch_check_trade_doc_render_fingerprints(
                object(), doc_ids=list(range(1, RENDER_CHECK_MAX_DOCS + 2)), user=USER))
        assert ei.value.status_code == 400
        assert ei.value.detail["code"] == RENDER_CHECK_DOC_IDS_LIMIT
        assert str(RENDER_CHECK_MAX_DOCS) in ei.value.detail["detail"]
        assert db.calls == []


# ── 路由与两端契约 ──────────────────────────────────────────────────────────

class TestRouteAndContract:
    def test_route_registered_and_not_shadowed(self):
        """注册了还不够 —— 必须**首个 FULL 匹配就是它**（否则被 {doc_id} 吃掉后 422）。"""
        from starlette.routing import Match

        scope = {"type": "http", "path": BATCH_PATH, "method": "GET", "headers": []}
        first = None
        for route in worker_main.app.routes:
            try:
                match, _ = route.matches(scope)
            except Exception:                        # pragma: no cover
                continue
            if match == Match.FULL:
                first = getattr(route, "path", None)
                break
        assert first == BATCH_PATH, f"批量路由被其它路由吃掉了：{first!r}"

    def test_batch_path_literal_is_stable(self):
        """S4（2026-10-19）后无第二后端：路径字面量冻结在此。

        删壳前这里逐字比对 `backend/orchestrator/app/api/trade_docs.py`（route-parity
        也会查双端一致）；单应用后双端一致性不再成立，改为钉死字面量本身 ——
        路径被改写会让前端 404，仍要在测试里兜住。
        """
        assert BATCH_PATH == "/api/v1/trade-docs/render-fingerprint-checks/batch"

    def test_card_and_summary_contract_come_from_kernel(self):
        """卡片/汇总字段集取自内核常量（两端同一份，不各写一套键）。"""
        card = render_check_card(1, "PI-1", {"reason": "matched", "matches": True})
        assert tuple(card) == RENDER_CHECK_CARD_FIELDS
        assert tuple(summarize_render_checks([card])) == RENDER_CHECK_SUMMARY_FIELDS

    def test_unavailable_is_not_a_kernel_verdict(self):
        from kaas_common.trade_doc import RENDER_CHECK_VERDICTS

        assert RENDER_CHECK_CARD_UNAVAILABLE not in RENDER_CHECK_VERDICTS
