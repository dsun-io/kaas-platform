"""询盘阶段状态机（TODO F4）守卫：只前进 / 终态 / 幂等 / 事件链路 / 历史端点。

口径（2026-10-20 用户拍板"落库+事件驱动"）：
- 阶段 inquiry < quotation < order < shipment < completed；closed 终态可从任意非终态进入；
- 事件重复触发（重试/多张报价/多张订单）必须幂等：目标 rank ≤ 当前就 no-op，不写日志；
- 订单不挂 inquiry_id，事件要沿 orders.quote_id → quote_orders.inquiry_id 找到询盘。
"""
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import inquiry_stage  # noqa: E402
import ws_crm_ext  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}


class _FakeConn:
    def __init__(self, *, fetchrow=None):
        self._fetchrow = list(fetchrow or [])
        self.queries: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.queries.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.queries.append((sql, args))
        return None

    async def fetch(self, sql, *args):
        self.queries.append((sql, args))
        return []

    async def execute(self, sql, *args):
        self.queries.append((sql, args))
        return "UPDATE 1"

    def log_inserts(self):
        return [(s, a) for s, a in self.queries if "INSERT INTO inquiry_stage_log" in s]

    def updates(self):
        return [(s, a) for s, a in self.queries if "UPDATE cust_inquiries SET stage" in s]


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def test_advance_moves_forward_and_writes_log():
    conn = _FakeConn(fetchrow=[{"stage": "quotation", "status": "quoted"}])
    result = _run(inquiry_stage.advance(
        conn, tenant_id="default", inquiry_id=9,
        target_stage=inquiry_stage.STAGE_ORDER,
        source_event=inquiry_stage.SOURCE_ORDER_CREATED, actor_id="3",
    ))
    assert result["changed"] is True
    assert result["from_stage"] == "quotation" and result["to_stage"] == "order"
    assert len(conn.updates()) == 1
    _sql, args = conn.log_inserts()[0]
    assert args[2] == "quotation" and args[3] == "order"
    assert args[4] == "order_created" and args[5] == "3"


def test_advance_is_idempotent_for_equal_or_lower_stage():
    """事件重试/多张报价：目标不高于当前 ⇒ no-op（不改行、不写日志）。"""
    conn = _FakeConn(fetchrow=[{"stage": "order", "status": "quoted"}])
    result = _run(inquiry_stage.advance(
        conn, tenant_id="default", inquiry_id=9,
        target_stage=inquiry_stage.STAGE_QUOTATION,
        source_event=inquiry_stage.SOURCE_QUOTE_CREATED,
    ))
    assert result["changed"] is False and result["to_stage"] == "order"
    assert conn.updates() == [] and conn.log_inserts() == []


def test_advance_closed_is_terminal():
    """已关闭的询盘不再被任何事件推进（closed 终态）。"""
    conn = _FakeConn(fetchrow=[{"stage": "closed", "status": "closed"}])
    result = _run(inquiry_stage.advance(
        conn, tenant_id="default", inquiry_id=9,
        target_stage=inquiry_stage.STAGE_COMPLETED,
        source_event=inquiry_stage.SOURCE_ORDER_COMPLETED,
    ))
    assert result["changed"] is False and result["to_stage"] == "closed"
    assert conn.updates() == []


def test_advance_close_from_any_stage():
    conn = _FakeConn(fetchrow=[{"stage": "shipment", "status": "quoted"}])
    result = _run(inquiry_stage.advance(
        conn, tenant_id="default", inquiry_id=9,
        target_stage=inquiry_stage.STAGE_CLOSED,
        source_event=inquiry_stage.SOURCE_INQUIRY_CLOSED,
    ))
    assert result["changed"] is True and result["to_stage"] == "closed"
    assert len(conn.log_inserts()) == 1


def test_advance_unknown_inquiry_is_noop():
    conn = _FakeConn(fetchrow=[None])
    result = _run(inquiry_stage.advance(
        conn, tenant_id="default", inquiry_id=404,
        target_stage=inquiry_stage.STAGE_ORDER,
        source_event=inquiry_stage.SOURCE_ORDER_CREATED,
    ))
    assert result is None
    assert conn.updates() == [] and conn.log_inserts() == []


def test_advance_with_known_status_skips_select():
    """调用方已读行（current_status 传入）时不再 SELECT —— 省往返、也不打乱测试假连接。"""
    conn = _FakeConn()
    result = _run(inquiry_stage.advance(
        conn, tenant_id="default", inquiry_id=9,
        target_stage=inquiry_stage.STAGE_QUOTATION,
        source_event=inquiry_stage.SOURCE_QUOTE_CREATED,
        current_status="unquoted",
    ))
    assert result["changed"] is True and result["from_stage"] == "inquiry"


def test_advance_for_order_resolves_quote_chain():
    """订单 → 报价 → 询盘：先按 quote_id 查 inquiry_id，再推进（订单本身没有 inquiry_id）。"""
    conn = _FakeConn(fetchrow=[
        {"inquiry_id": 9},                                  # quote_orders 查询
        {"stage": "order", "status": "quoted"},             # cust_inquiries FOR UPDATE
    ])
    result = _run(inquiry_stage.advance_for_order(
        conn, tenant_id="default", order_id=21, quote_id=11,
        target_stage=inquiry_stage.STAGE_SHIPMENT,
        source_event=inquiry_stage.SOURCE_SHIPMENT_CREATED,
    ))
    assert result["changed"] is True and result["to_stage"] == "shipment"
    assert "FROM quote_orders" in conn.queries[0][0]


def test_stage_log_endpoint_shape(monkeypatch):
    """GET /inquiries/{id}/stage-log：按时间正序返回历史变更（审计/验收入口）。"""
    class _FakeDb:
        async def fetchrow(self, request, sql, *args, table=None):
            return {"id": 9}

        async def fetch(self, request, sql, *args, table=None):
            return [
                {"from_stage": "inquiry", "to_stage": "quotation",
                 "source_event": "quote_created", "actor_id": "3",
                 "note": None, "created_at": "2026-10-20T01:00:00+00:00"},
                {"from_stage": "quotation", "to_stage": "order",
                 "source_event": "order_created", "actor_id": "3",
                 "note": None, "created_at": "2026-10-20T02:00:00+00:00"},
            ]

    old = ws_crm_ext.db
    ws_crm_ext.db = _FakeDb()
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: ADMIN
    try:
        resp = client.get("/api/v1/inquiries/9/stage-log")
    finally:
        ws_crm_ext.db = old
        worker_main.app.dependency_overrides.clear()

    assert resp.status_code == 200
    items = resp.json()["items"]
    assert [i["to_stage"] for i in items] == ["quotation", "order"]
    assert set(items[0]) == {
        "from_stage", "to_stage", "source_event", "actor_id", "note", "created_at",
    }
