"""Worker 侧「渲染指纹对账」端点的单测（C 方案的消费者）。

为什么需要这个文件
------------------
`raw_payload._render` 存了、界面显示了，但**没人消费** —— 没人能回答"这张单据现在的数据
跟签发时还一致吗"。新增的 `GET /api/v1/trade-docs/{doc_id}/render-fingerprint-check`
就是那个消费者（与 orchestrator 同路径同字段）。

它坏掉的方式全是**静默的**：
1. **假匹配**：装配失败（或冻结时就没摘要）却返回 `matches=true` ⇒ 有人据此认定"数据没被改"，
   而实际上根本没比过；
2. **把两件事混为一谈**：模板/渲染器版本变了（`render_version_drift`）与数据被改
   （`reason=data_changed`）是不同的结论，只凭 sha 不等就说"数据被改"会冤枉人；
3. **拿不到指纹就报错**：草稿/老单据没有 `_render`，探针不该 500（那是"没有基线"，不是错误）。

判定在共享内核 `render_fingerprint_check`（两端同一函数对象），这里验的是**worker 侧接线**：
从 `raw_payload` 取 `_render`、调同一套装配、把内核结论原样返回。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_docs_ext  # noqa: E402,F401  (import 即注册路由)
from kaas_common.trade_doc import (  # noqa: E402
    RENDER_KEY,
    RENDER_VERSION,
    render_fingerprint,
)

DOC_ID = 11
FROZEN_AT = "2026-10-12T00:00:00+00:00"

# 一份"装配好的渲染数据"的缩小版（字段名与 build_render_data 一致）
ASSEMBLED = {
    "seller": {"company": "KAAS TRADING CO., LTD", "address": "Hebei, China"},
    "buyer": {"name": "BABAN KORI", "address": "Iraq"},
    "items": [{"product_name": "Chain Link Fence", "qty": 100, "unit_price": 12.5,
               "line_amount": 1250.0}],
    "currency": "USD",
    "total_amount": 1250.0,
    "pi_no": "PI-202610-0001",
    "pi_date": "2026-10-11T00:00:00+00:00",
}


def _copy(**overrides):
    data = {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v)
            for k, v in ASSEMBLED.items()}
    data.update(overrides)
    return data


class _FakeDb:
    """只实现 `fetchrow`（`_get_doc_or_404` 需要），按调用顺序吐结果。"""

    def __init__(self, *rows):
        self._rows = list(rows)
        self.calls: list[tuple] = []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._rows.pop(0) if self._rows else None


def _doc(payload):
    return {"id": DOC_ID, "doc_type": "pi", "status": "issued", "raw_payload": payload,
            "team_id": 1, "owner_id": "1", "owner_scope": "private"}


# C27/F2：读端点先做可见性（团队/owner）；本文件只关心指纹接线 ⇒ 本团队 owner。
READER = {"id": 1, "account_type": "customer", "role": "owner", "team_id": 1}


def _run(coro):
    return asyncio.run(coro)


def _check(monkeypatch, *, payload, assembly):
    """跑一次 worker 端点：`assembly` 是 `main.get_trade_doc_render_data` 的替身。"""
    db = _FakeDb(_doc(payload))
    monkeypatch.setattr(ws_docs_ext, "db", db)
    monkeypatch.setattr(ws_docs_ext._main, "get_trade_doc_render_data", assembly)
    return _run(ws_docs_ext.check_trade_doc_render_fingerprint(DOC_ID, object(), READER))


def _frozen_payload(**meta_overrides):
    meta = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
    meta.update(meta_overrides)
    return {"sources": {}, "custom": {}, RENDER_KEY: meta}


class TestCheckEndpoint:
    def test_matched(self, monkeypatch):
        async def _assembly(doc_id, request, user):
            # 独立构造的同一份内容（键顺序不同、容器新建）
            return {"data": {k: ASSEMBLED[k] for k in sorted(ASSEMBLED, reverse=True)}}

        out = _check(monkeypatch, payload=_frozen_payload(), assembly=_assembly)

        assert out["has_fingerprint"] is True
        assert out["matches"] is True
        assert out["reason"] == "matched"
        assert out["render_version_drift"] is False
        assert out["current_note"] is None

    def test_data_changed(self, monkeypatch):
        """真的改一处**被纳入摘要**的数据（总金额），不是改 mock 的形状。"""
        async def _assembly(doc_id, request, user):
            return {"data": _copy(total_amount=7777.0)}

        out = _check(monkeypatch, payload=_frozen_payload(), assembly=_assembly)

        assert out["matches"] is False
        assert out["reason"] == "data_changed"
        assert out["current_sha256"] != out["frozen"]["input_sha256"]
        assert out["render_version_drift"] is False   # 这一例版本没变，别混为一谈

    def test_no_fingerprint_is_not_an_error(self, monkeypatch):
        async def _assembly(doc_id, request, user):
            return {"data": _copy()}

        out = _check(monkeypatch, payload={"sources": {}, "custom": {}}, assembly=_assembly)

        assert out["has_fingerprint"] is False
        assert out["frozen"] is None
        assert out["matches"] is False
        assert out["reason"] == "no_fingerprint"
        assert out["current_sha256"]            # 如实给当前值

    def test_assembly_failure_is_flagged_not_hidden(self, monkeypatch):
        async def _boom(doc_id, request, user):
            raise RuntimeError("assembly exploded")

        out = _check(monkeypatch, payload=_frozen_payload(), assembly=_boom)

        assert out["matches"] is False
        assert out["current_sha256"] is None
        assert out["reason"] == "current_unavailable"
        assert out["current_note"] == "RuntimeError"

    def test_version_drift_reported_separately(self, monkeypatch):
        async def _assembly(doc_id, request, user):
            return {"data": _copy()}          # 数据一模一样

        out = _check(
            monkeypatch,
            payload=_frozen_payload(render_version=RENDER_VERSION - 1),
            assembly=_assembly,
        )

        assert out["matches"] is True         # 内容确实一致
        assert out["reason"] == "version_drift"
        assert out["render_version_drift"] is True
        assert out["render_version_frozen"] == RENDER_VERSION - 1
        assert out["render_version_current"] == RENDER_VERSION

    def test_frozen_without_digest_never_matches(self, monkeypatch):
        """签发时就装配失败过（`input_sha256: null`）⇒ 没有基线，不能报匹配。"""
        async def _assembly(doc_id, request, user):
            return {"data": _copy()}

        out = _check(
            monkeypatch,
            payload=_frozen_payload(input_sha256=None, note="input_unavailable"),
            assembly=_assembly,
        )

        assert out["matches"] is False
        assert out["reason"] == "frozen_unavailable"
        assert out["frozen_note"] == "input_unavailable"

    def test_response_contract_matches_orchestrator_fields(self, monkeypatch):
        """字段即两端契约（route-parity 只查路由，查不了响应体）。"""
        async def _assembly(doc_id, request, user):
            return {"data": _copy()}

        out = _check(monkeypatch, payload=_frozen_payload(), assembly=_assembly)
        assert set(out) == {
            "has_fingerprint", "frozen", "current_sha256", "matches",
            "render_version_frozen", "render_version_current", "render_version_drift",
            "reason", "checked_at", "current_note", "frozen_note",
        }

    def test_missing_document_is_404(self, monkeypatch):
        from fastapi import HTTPException

        monkeypatch.setattr(ws_docs_ext, "db", _FakeDb(None))
        with pytest.raises(HTTPException) as ei:
            _run(ws_docs_ext.check_trade_doc_render_fingerprint(DOC_ID, object(), {"id": 1}))
        assert ei.value.status_code == 404
        assert ei.value.detail["code"] == "DOC_NOT_FOUND"


class TestRouteRegistered:
    def test_get_route_is_registered_on_worker_app(self):
        """Worker 侧路由必须真的注册上（否则生产 404，前端只能干看着）。"""
        paths = {
            getattr(r, "path", ""): getattr(r, "methods", set())
            for r in worker_main.app.routes
        }
        assert "/api/v1/trade-docs/{doc_id}/render-fingerprint-check" in paths
        assert "GET" in paths["/api/v1/trade-docs/{doc_id}/render-fingerprint-check"]
