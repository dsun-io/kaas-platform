"""trade_docs API 测试（S2/S3/S4）：手动开单 + items + confirm 锁定 + 派生链 + 翻译。

覆盖用户裁决：
- manual 开单免上游（单证工位独立可用）
- items 金额勾稽（qty×price=line_amount）
- confirm 明确确认环节 → issued 锁死（PATCH 拒绝）
- 派生仅接受 issued 源（未确认 → 409 SOURCE_NOT_CONFIRMED）
- apply_scheme：QUO 多方案一键应用到 PI 行项目
- 翻译：draft 可写回；确认后不写回
"""
import pytest

from app.middleware.auth import AuthContextMiddleware
from app.core.auth import AuthContext
from app.main import app
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db


def _install_internal_mock(tenant_id="qa_smoke", user_id=2):
    async def _dispatch(self, request, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
            return await call_next(request)
        request.state.auth = AuthContext(
            user_id=user_id, account_type="internal", role="user",
            tenant_id=tenant_id,
        )
        return await call_next(request)

    old = AuthContextMiddleware.dispatch
    AuthContextMiddleware.dispatch = _dispatch
    app.middleware_stack = None
    return old


def _restore(old):
    AuthContextMiddleware.dispatch = old
    app.middleware_stack = None


ITEM = {
    "product_name": "Field Fence 1.5m",
    "spec_snapshot": {"height_m": 1.5},
    "qty": 100, "qty_unit": "roll",
    "unit_price": 52.5, "line_amount": 5250.0,
    "group_no": 0, "source": "manual",
}


class TestManualCreate:
    async def test_manual_create_with_items(self, client):
        """manual 开单免上游：items 直接落库。"""
        resp = await client.post("/api/v1/trade-docs", json={
            "doc_type": "quotation",
            "customer_id": "c-test",
            "currency": "USD",
            "items": [ITEM],
            "raw_payload": {"quote_no": "Q-1", "quote_date": "2026-09-30"},
        })
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["doc_no"].startswith("QUO-2026")
        assert data["status"] == "draft"

        detail = await client.get(f"/api/v1/trade-docs/{data['id']}")
        items = detail.json()["items"]
        assert len(items) == 1
        assert items[0]["product_name"] == ITEM["product_name"]
        assert items[0]["line_amount"] == 5250.0

    async def test_items_amount_mismatch_rejected(self, client):
        """行金额勾稽不符 → 422。"""
        bad = dict(ITEM, line_amount=99.0)
        resp = await client.post("/api/v1/trade-docs", json={
            "doc_type": "ci", "customer_id": "c1", "items": [bad],
        })
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "ITEMS_INVALID"

    async def test_no_source_and_no_items_rejected(self, client):
        """三无（无上游/无派生/无 items）→ 422 SOURCE_REQUIRED。"""
        resp = await client.post("/api/v1/trade-docs", json={"doc_type": "ci"})
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "SOURCE_REQUIRED"


class TestConfirmLock:
    async def _create(self, client, doc_type="ci", **kw):
        resp = await client.post("/api/v1/trade-docs", json={
            "doc_type": doc_type, "customer_id": "c-lock", "items": [dict(ITEM)],
            **kw,
        })
        assert resp.status_code == 201, resp.text
        return resp.json()

    async def test_confirm_issues_and_locks(self, client):
        """确认 → issued；随后 PATCH 拒绝（确认即锁死）。"""
        doc = await self._create(client)
        r = await client.post(f"/api/v1/trade-docs/{doc['id']}/confirm", json={})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "issued"
        assert r.json()["issued_at"] is not None

        p = await client.patch(f"/api/v1/trade-docs/{doc['id']}", json={
            "raw_payload": {"custom": {"x": 1}}})
        assert p.status_code == 409
        assert p.json()["detail"]["code"] == "NOT_DRAFT"

    async def test_confirm_requires_buyer(self, client):
        """缺买方 → 422 CONFIRM_INVALID。"""
        resp = await client.post("/api/v1/trade-docs", json={
            "doc_type": "ci", "items": [dict(ITEM)],
        })
        assert resp.status_code == 201   # 建单允许，确认时校验
        r = await client.post(f"/api/v1/trade-docs/{resp.json()['id']}/confirm", json={})
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "CONFIRM_INVALID"

    async def test_confirm_not_draft_rejected(self, client):
        """已 issued 再确认 → 409 ILLEGAL_TRANSITION。"""
        doc = await self._create(client)
        await client.post(f"/api/v1/trade-docs/{doc['id']}/confirm", json={})
        r = await client.post(f"/api/v1/trade-docs/{doc['id']}/confirm", json={})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "ILLEGAL_TRANSITION"


class TestDeriveChain:
    async def _issued_quo(self, client, items):
        r = await client.post("/api/v1/trade-docs", json={
            "doc_type": "quotation", "customer_id": "c-derive",
            "items": items,
            "raw_payload": {"quote_no": "Q-D", "quote_date": "2026-09-30"},
        })
        doc = r.json()
        c = await client.post(f"/api/v1/trade-docs/{doc['id']}/confirm", json={})
        assert c.status_code == 200, c.text
        return doc

    async def test_derive_from_draft_rejected(self, client):
        """未确认源 → 409 SOURCE_NOT_CONFIRMED（用户裁决硬闸门）。"""
        r = await client.post("/api/v1/trade-docs", json={
            "doc_type": "quotation", "customer_id": "c1",
            "items": [dict(ITEM)],
            "raw_payload": {"quote_no": "Q-1", "quote_date": "2026-09-30"},
        })
        src = r.json()
        d = await client.post("/api/v1/trade-docs", json={
            "doc_type": "pi", "derive_from_doc_id": src["id"],
        })
        assert d.status_code == 409
        assert d.json()["detail"]["code"] == "SOURCE_NOT_CONFIRMED"

    async def test_derive_inherits_items(self, client):
        """issued 源派生：行项目自动继承不重录。"""
        src = await self._issued_quo(client, [dict(ITEM)])
        d = await client.post("/api/v1/trade-docs", json={
            "doc_type": "pi", "derive_from_doc_id": src["id"],
        })
        assert d.status_code == 201, d.text
        pi = d.json()
        detail = await client.get(f"/api/v1/trade-docs/{pi['id']}")
        body = detail.json()
        assert body["items"][0]["product_name"] == ITEM["product_name"]
        assert body["refs"]["docs"][0]["source_trade_doc_id"] == src["id"]

    async def test_apply_scheme_materializes(self, client):
        """QUO 多方案 → PI 直接应用选定方案的 qty/单价（报价准确场景）。"""
        scheme_item = dict(
            ITEM, qty=30000, unit_price=1.0, line_amount=30000.0,
            scheme_prices={
                "o30000": {"qty": 30000, "unit_price": 1.0},
                "o50000": {"qty": 50000, "unit_price": 0.9},
            },
        )
        src = await self._issued_quo(client, [scheme_item])
        d = await client.post("/api/v1/trade-docs", json={
            "doc_type": "pi", "derive_from_doc_id": src["id"],
            "apply_scheme": "o50000",
        })
        assert d.status_code == 201, d.text
        detail = await client.get(f"/api/v1/trade-docs/{d.json()['id']}")
        row = detail.json()["items"][0]
        assert row["qty"] == 50000
        assert row["unit_price"] == 0.9
        assert row["line_amount"] == 45000.0
        assert row["source"] == "generated"


class TestTranslate:
    async def test_translate_draft_writes_back(self, client):
        """draft 态翻译写回 custom；无 AI 降级为原文（path=template）。"""
        r = await client.post("/api/v1/trade-docs", json={
            "doc_type": "pi", "customer_id": "c-t",
            "items": [dict(ITEM)],
        })
        doc = r.json()
        t = await client.post(f"/api/v1/trade-docs/{doc['id']}/translate", json={
            "fields": {"buyer": "联佳丝网", "terms": "T/T 30%"},
        })
        assert t.status_code == 200, t.text
        assert t.json()["fields"]["terms"] == "T/T 30%"   # 数字单位保持

        detail = await client.get(f"/api/v1/trade-docs/{doc['id']}")
        custom = detail.json()["raw_payload"]["custom"]
        assert custom.get("buyer") == t.json()["fields"]["buyer"]

    async def test_translate_issued_not_written(self, client):
        """issued 态翻译仍返回结果但不写回（锁死语义）。"""
        r = await client.post("/api/v1/trade-docs", json={
            "doc_type": "ci", "customer_id": "c-t2", "items": [dict(ITEM)],
        })
        doc = r.json()
        await client.post(f"/api/v1/trade-docs/{doc['id']}/confirm", json={})
        t = await client.post(f"/api/v1/trade-docs/{doc['id']}/translate", json={
            "fields": {"remark": "装船后三日内电放"},
        })
        assert t.status_code == 200
        detail = await client.get(f"/api/v1/trade-docs/{doc['id']}")
        custom = detail.json()["raw_payload"]["custom"]
        assert "remark" not in custom   # 不写回
