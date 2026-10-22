"""已确认订单明细变更审批 + 站内通知 + 指定审批人（设计 §6.1/§6.2，M1-e）。

背景：订单确认后行项不是不能改，而是**改了会冲击已开单证与已收金额**。
本文件锁住这套规则的可观察行为：
  · pending 订单直接 PATCH items（不必审批）；已确认订单走申请 → 审批 → 落库；
  · 同一订单同时只允许一条待审申请；
  · 审批人路由：指定审批人 → 团队管理员 → 租户系统管理员；
  · 自批默认禁止，只剩申请人时放行并标注；
  · 管理员兜底（指定审批人躺平时流程不能卡死）；
  · 批准后整批替换 + 重算总额 + 同步未收应收 + 列出受影响单证；
  · 通知只发给审批人（提交时）与申请人（决定时）。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_approvals  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin", "team_id": None}
# 申请人：订单属主（owner_id 与 id 相同 ⇒ 可读可写）
OWNER = {"id": 3, "account_type": "internal", "role": "member", "team_id": 2}
# 同团队但不在审批名单上的普通成员
STRANGER = {"id": 4, "account_type": "internal", "role": "member", "team_id": 2}
# 指定审批人
APPROVER = {"id": 7, "account_type": "internal", "role": "member", "team_id": 2}
# 团队管理员（无指定审批人时的兜底审批人）
TEAM_ADMIN = {"id": 5, "account_type": "internal", "role": "member", "team_id": 2,
              "is_tenant_admin": True}
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)

_ORIGINAL_ACQUIRE = worker_main._acquire
_ORIGINAL_APPROVALS_ACQUIRE = ws_approvals._acquire
_ORIGINAL_APPROVALS_DB = ws_approvals.db


class _StubDb:
    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, _request, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)


class _StubConn:
    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"

    def transaction(self):
        class _Tx:
            async def __aenter__(self):
                return None

            async def __aexit__(self, *exc):
                return False

        return _Tx()

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)


@contextmanager
def _patched(*, conn=None, db=None, user=ADMIN):
    conn = conn if conn is not None else _StubConn()

    @asynccontextmanager
    async def fake_acquire(_request):
        yield conn

    worker_main._acquire = fake_acquire
    ws_approvals._acquire = fake_acquire
    if db is not None:
        ws_approvals.db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        worker_main._acquire = _ORIGINAL_ACQUIRE
        ws_approvals._acquire = _ORIGINAL_APPROVALS_ACQUIRE
        ws_approvals.db = _ORIGINAL_APPROVALS_DB
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _order_row(**over):
    row = {
        "id": 21, "tenant_id": "default", "order_no": "ORD-US-ACM-1",
        "customer_id": 3, "customer_name": "ACME 贸易", "status": "confirmed",
        "currency": "USD", "total_amount": 3180.0, "amount_breakdown": None,
        "order_date": None, "delivery_date": None, "notes": None,
        "fx_rate": None, "fx_rate_date": None, "created_at": NOW,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "quote_id": 11, "source_type": "inquiry", "source_channel": "email",
        "inquiry_id": 9, "confirmed_at": NOW, "confirmed_by": "3",
        "confirmed_source": "manual", "incoterm": "FOB",
        "payment_terms": None, "port_of_loading": None,
        "port_of_destination": None, "shipping_marks": None,
        "country_of_origin": None,
    }
    row.update(over)
    return row


def _request_row(**over):
    row = {
        "id": 5, "tenant_id": "default", "order_id": 21,
        "requested_by": 3, "reason": "客户要求改包装规格",
        "items": ('[{"sku_id": 7, "product_name": "牛栏网", "qty": 100,'
                  ' "qty_unit": "m", "unit_price": 40.0, "currency": "USD",'
                  ' "line_amount": 4000.0},'
                  ' {"sku_id": 8, "product_name": "刺绳", "qty": 20,'
                  ' "qty_unit": "roll", "unit_price": 50.0, "currency": "USD"}]'),
        "snapshot": ('[{"sku_id": 6, "product_name": "旧牛栏网", "qty": 90,'
                     ' "qty_unit": "m", "unit_price": 35.0, "currency": "USD",'
                     ' "line_amount": 3150.0}]'),
        "status": "pending", "decided_by": None, "decided_at": None,
        "decision_reason": None, "team_id": 2,
        "created_at": NOW, "updated_at": NOW,
    }
    row.update(over)
    return row


def _item_rows():
    return [{"sku_id": 6, "product_name": "旧牛栏网", "spec_snapshot": None,
             "qty": 90, "qty_unit": "m", "unit_price": 35.0,
             "currency": "USD", "line_amount": 3150.0, "sort_order": 0}]


_ITEMS = [
    {"sku_id": 7, "product_name": "牛栏网", "qty": 100, "qty_unit": "m",
     "unit_price": 40.0, "currency": "USD", "line_amount": 4000.0,
     "spec_snapshot": {"height": 1.2}},
    # 不传 line_amount ⇒ 由 qty × unit_price 推出（与新建/替换同口径）
    {"sku_id": 8, "product_name": "刺绳", "qty": 20, "qty_unit": "roll",
     "unit_price": 50.0, "currency": "USD"},
]


# ── 提交变更申请 ───────────────────────────────────────────────────────────

def test_submit_on_confirmed_order_notifies_routed_approvers():
    conn = _StubConn(
        fetchrow=[_order_row(), None, _request_row()],
        fetch=[_item_rows(), [{"user_id": 7}]],
    )
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/21/item-change-requests",
                           json={"items": _ITEMS, "reason": "客户要求改包装规格"})

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    assert body["order_id"] == 21
    assert body["requested_by"] == 3
    # 前端用来提示"已通知谁"
    assert body["notified_approvers"] == [7]
    # 旧明细快照必须落库：审批页的新旧对比不能依赖订单当前值
    assert body["snapshot"][0]["product_name"] == "旧牛栏网"
    assert body["snapshot"][0]["line_amount"] == 3150.0
    # 新明细原样带回（不在这里应用）
    assert [i["product_name"] for i in body["items"]] == ["牛栏网", "刺绳"]

    sql = conn.sql()
    assert "INSERT INTO order_item_change_requests" in sql
    assert "INSERT INTO notifications" in sql
    assert "INSERT INTO business_events" in sql
    # 提交阶段绝不能不碰订单本身
    assert "UPDATE orders SET total_amount" not in sql
    assert "DELETE FROM order_items" not in sql


def test_submit_on_pending_order_is_rejected_edit_directly():
    """待确认订单本来就能直接 PATCH，走审批反而多一道无谓流程。"""
    conn = _StubConn(fetchrow=[_order_row(status="pending")])
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/21/item-change-requests",
                           json={"items": _ITEMS})
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "ORDER_ITEMS_EDITABLE"
    assert detail["order_status"] == "pending"


def test_submit_duplicate_pending_request_is_rejected():
    """同时两条待审都批准会互相覆盖，且"以哪份为准"说不清。"""
    conn = _StubConn(
        fetchrow=[_order_row(), {"id": 4, "status": "pending"}],
    )
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/21/item-change-requests",
                           json={"items": _ITEMS})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "CHANGE_REQUEST_PENDING"
    assert detail["request_id"] == 4


def test_submit_rejects_empty_items():
    conn = _StubConn(fetchrow=[_order_row()])
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/21/item-change-requests",
                           json={"items": []})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ITEMS"


def test_submit_validates_numbers_before_approval():
    """非法数字必须在提交时就 422，不能等到批准后才发现应用不了。"""
    conn = _StubConn(fetchrow=[_order_row()])
    bad = [{"sku_id": 7, "product_name": "牛栏网", "qty": 10,
            "unit_price": "四十块"}]
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/21/item-change-requests",
                           json={"items": bad})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ITEM_NUMBER"


def test_submit_requires_visible_order():
    conn = _StubConn(fetchrow=[None])
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/404/item-change-requests",
                           json={"items": _ITEMS})
    assert resp.status_code == 404


# ── 审批人路由（D-11 / D-14）───────────────────────────────────────────────

def test_approvers_fall_back_to_team_admins_when_none_designated():
    conn = _StubConn(
        fetchrow=[_order_row(), None, _request_row()],
        fetch=[_item_rows(), [], [{"id": 5}]],
    )
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/21/item-change-requests",
                           json={"items": _ITEMS})
    assert resp.status_code == 201, resp.text
    assert resp.json()["notified_approvers"] == [5]


def test_approvers_fall_back_to_tenant_admins_when_order_has_no_team():
    """历史订单没有 team_id：不能因此没人可批。"""
    conn = _StubConn(
        fetchrow=[_order_row(team_id=None), None, _request_row(team_id=None)],
        fetch=[_item_rows(), [{"id": 1}]],
    )
    with _patched(conn=conn, user=OWNER):
        resp = client.post("/api/v1/orders/21/item-change-requests",
                           json={"items": _ITEMS})
    assert resp.status_code == 201, resp.text
    assert resp.json()["notified_approvers"] == [1]
    # 没有团队 ⇒ 不查 team_approvers / 团队管理员，直接租户管理员
    assert conn.sql().count("FROM team_approvers") == 0


def test_list_change_requests_returns_history():
    conn = _StubConn(
        fetchrow=[_order_row()],
        fetch=[[_request_row(), _request_row(id=4, status="approved",
                                            decided_by=7, decision_reason="同意")]],
    )
    with _patched(conn=conn, user=OWNER):
        resp = client.get("/api/v1/orders/21/item-change-requests")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 2
    assert [r["id"] for r in body["items"]] == [5, 4]
    assert body["items"][1]["status"] == "approved"
    assert body["items"][1]["decision_reason"] == "同意"
    assert "ORDER BY created_at DESC, id DESC" in conn.sql()


# ── 批准 / 拒绝 ────────────────────────────────────────────────────────────

def _approve_conn(**over):
    """批准路径的调用序列（按序消费，多一条查询就要相应加一项）。"""
    kw = dict(
        fetchrow=[_order_row(), _request_row(), _order_row(),
                  {"id": 40, "received_amount": 0},
                  _request_row(status="approved", decided_by=7,
                               decision_reason="同意")],
        fetch=[[{"user_id": 7}],                      # team_approvers
               [{"id": 30, "doc_type": "contract", "doc_no": "C-1",
                 "status": "issued"}]],               # trade_docs
        fetchval=[5000.0],                            # 行项汇总
    )
    kw.update(over)
    return _StubConn(**kw)


def test_approve_applies_items_recomputes_total_and_lists_affected_docs():
    conn = _approve_conn()
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve",
            json={"reason": "客户已确认新规格"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["applied"] is True
    assert body["status"] == "approved"
    assert body["decided_by"] == 7
    # 批准后总额 = 4000 + 20×50（无 breakdown ⇒ 就是行项汇总）
    assert body["new_total_amount"] == 5000.0
    # 受影响单证必须报出来：已开合同的货描可能对不上，要重开
    assert body["affected_docs"] == [{"id": 30, "doc_type": "contract",
                                      "doc_no": "C-1", "status": "issued"}]

    sql = conn.sql()
    # 整批替换复用 main 的同一份实现
    assert "DELETE FROM order_items" in sql
    assert sql.count("INSERT INTO order_items") == 2
    assert "UPDATE orders SET total_amount=$1, amount_breakdown=$2::jsonb" in sql
    # 一分钱没收到 ⇒ 应收同步
    assert "UPDATE receivables SET total_amount=$1" in sql
    # 通知申请人（不是审批人）
    assert "INSERT INTO notifications" in sql
    # 审计留痕
    assert "INSERT INTO business_events" in sql


def test_approve_recomputes_total_from_amount_breakdown():
    """有四项构成时只换货物金额，运费/保险按谈定值保留。"""
    order = _order_row(amount_breakdown={"goods_amount": 3180.0,
                                         "freight_amount": 200.0,
                                         "insurance_amount": 20.0,
                                         "other_amount": 0.0})
    conn = _approve_conn(fetchrow=[_order_row(), _request_row(), order,
                                   {"id": 40, "received_amount": 0},
                                   _request_row(status="approved")],
                         fetchval=[5000.0])
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve", json={})
    assert resp.status_code == 200, resp.text
    # 5220 = 货物 5000 + 运费 200 + 保险 20
    assert resp.json()["new_total_amount"] == 5220.0


def test_approve_keeps_receivable_when_partially_paid():
    """已收过钱的订单改明细不能再动应收总额，否则已收 > 应收。"""
    conn = _approve_conn(
        fetchrow=[_order_row(), _request_row(), _order_row(),
                  {"id": 40, "received_amount": 100.0},
                  _request_row(status="approved")])
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve", json={})
    assert resp.status_code == 200, resp.text
    assert "UPDATE receivables SET total_amount" not in conn.sql()


def test_approve_notifies_requester_and_records_decision():
    conn = _approve_conn()
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve",
            json={"reason": "客户已确认新规格"})
    assert resp.status_code == 200, resp.text
    notif = next(a for s, a in conn.calls
                 if "INSERT INTO notifications" in s)
    # 收件人是申请人 3，不是审批人
    assert notif[2] == 3
    assert notif[3] == "approval_approved"
    event = next(a for s, a in conn.calls if "INSERT INTO business_events" in s)
    assert event[1] == "order.item_change_approved"


def test_non_approver_cannot_decide():
    conn = _StubConn(
        fetchrow=[_order_row(), _request_row()],
        fetch=[[{"user_id": 7}]],      # 指定审批人是 7，当前用户是 4
    )
    with _patched(conn=conn, user=STRANGER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve", json={})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_APPROVER"


def test_self_approval_is_denied_unless_solo():
    """申请人不能批自己的申请；只剩他一个人时放行并标注。"""
    conn = _StubConn(
        fetchrow=[_order_row(), _request_row()],
        fetch=[[{"user_id": 3}, {"user_id": 7}]],   # requested_by=3 也在名单里
    )
    with _patched(conn=conn, user=OWNER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve", json={})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "SELF_APPROVAL"

    # 可批集合只剩申请人（单人团队）⇒ 允许，但审计标注自批
    solo = _approve_conn(fetch=[[{"user_id": 3}], []])
    with _patched(conn=solo, user=OWNER):
        ok = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve", json={})
    assert ok.status_code == 200, ok.text
    event = next(a for s, a in solo.calls if "INSERT INTO business_events" in s)
    assert '"decision": "self_approve_solo"' in event[4]


def test_admin_fallback_can_decide_when_designated_approver_is_idle():
    """指定审批人躺平时流程不能卡死：管理员兜底，审计标注 admin_fallback。"""
    conn = _StubConn(
        fetchrow=[_order_row(), _request_row(), _order_row(),
                  {"id": 40, "received_amount": 0},
                  _request_row(status="approved", decided_by=1,
                               decision_reason="同意")],
        fetch=[[{"user_id": 7}], [],
               [{"id": 30, "doc_type": "contract", "doc_no": "C-1",
                 "status": "issued"}]],
        fetchval=[5000.0],
    )
    with _patched(conn=conn, user=ADMIN):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve", json={})
    assert resp.status_code == 200, resp.text
    event = next(a for s, a in conn.calls if "INSERT INTO business_events" in s)
    assert '"decision": "admin_fallback"' in event[4]


def test_reject_without_reason_is_rejected():
    """被拒方只看到"被拒了"不知道要改什么 ⇒ 理由必填。"""
    conn = _StubConn(
        fetchrow=[_order_row(), _request_row()],
        fetch=[[{"user_id": 7}]],
    )
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/reject", json={})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "DECISION_REASON_REQUIRED"
    assert detail["field"] == "reason"


def test_reject_leaves_order_untouched_and_notifies_requester():
    conn = _StubConn(
        fetchrow=[_order_row(), _request_row(),
                  _request_row(status="rejected", decided_by=7,
                               decision_reason="供应商交期来不及")],
        fetch=[[{"user_id": 7}]],
    )
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/reject",
            json={"reason": "供应商交期来不及"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["applied"] is False
    assert body["status"] == "rejected"
    assert body["decision_reason"] == "供应商交期来不及"
    assert body["new_total_amount"] is None
    assert body["affected_docs"] == []

    sql = conn.sql()
    assert "DELETE FROM order_items" not in sql
    assert "UPDATE orders SET total_amount" not in sql
    notif = next(a for s, a in conn.calls if "INSERT INTO notifications" in s)
    assert notif[3] == "approval_rejected"


def test_decide_already_decided_request_is_409():
    conn = _StubConn(
        fetchrow=[_order_row(), _request_row(status="approved")],
        fetch=[[{"user_id": 7}]],
    )
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/5/approve", json={})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "CHANGE_REQUEST_ALREADY_DECIDED"
    assert detail["status"] == "approved"


def test_decide_missing_request_is_404():
    conn = _StubConn(fetchrow=[_order_row(), None])
    with _patched(conn=conn, user=APPROVER):
        resp = client.post(
            "/api/v1/orders/21/item-change-requests/999/approve", json={})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "CHANGE_REQUEST_NOT_FOUND"


# ── 审批中心（D-12）────────────────────────────────────────────────────────

def _approval_row(**over):
    row = {
        "id": 5, "tenant_id": "default", "order_id": 21, "order_no": "ORD-US-ACM-1",
        "order_status": "confirmed", "total_amount": 3180.0, "currency": "USD",
        "requester_name": "属主",
        "requested_by": 3, "reason": "改包装", "status": "pending",
        "decided_by": None, "decided_at": None, "decision_reason": None,
        "team_id": 2, "created_at": NOW, "updated_at": NOW,
        "items": "[]", "snapshot": "[]",
    }
    row.update(over)
    return row


def test_approvals_pending_lists_only_requests_i_must_decide():
    db = _StubDb(fetchval=[1], fetch=[[_approval_row()]])
    with _patched(db=db, user=APPROVER):
        resp = client.get("/api/v1/approvals?view=pending")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    item = body["items"][0]
    # 审批卡片要能直接看出"哪张单、多少钱、谁提的"
    assert item["order_no"] == "ORD-US-ACM-1"
    assert item["order_status"] == "confirmed"
    assert item["order_total_amount"] == 3180.0
    assert item["requester_name"] == "属主"
    assert item["items"] == [] and item["snapshot"] == []

    sql = db.sql()
    assert "FROM team_approvers a" in sql
    assert "NOT EXISTS (SELECT 1 FROM team_approvers a2" in sql
    # 未指定审批人 ⇒ 团队管理员（ orders.team_id = 我 ）也算待我审批
    assert "AND o.team_id = $2" in sql


def test_approvals_admin_sees_all_pending():
    """管理员兜底视野：全部待批，避免指定审批人躺平时流程卡死。"""
    db = _StubDb(fetchval=[2], fetch=[[_approval_row(), _approval_row(id=6)]])
    with _patched(db=db, user=ADMIN):
        resp = client.get("/api/v1/approvals")
    assert resp.status_code == 200
    assert resp.json()["total"] == 2
    # 管理员不需要按人过滤
    assert "FROM team_approvers a" not in db.sql()


def test_approvals_mine_and_done_views():
    db = _StubDb(fetchval=[1], fetch=[[_approval_row()]])
    with _patched(db=db, user=OWNER):
        assert client.get("/api/v1/approvals?view=mine").status_code == 200
    assert "r.requested_by = $2" in db.sql()

    db = _StubDb(fetchval=[1], fetch=[[_approval_row(status="rejected")]])
    with _patched(db=db, user=APPROVER):
        assert client.get("/api/v1/approvals?view=done").status_code == 200
    assert "r.decided_by = $2" in db.sql()
    assert "r.status IN ('approved','rejected')" in db.sql()


def test_approvals_rejects_unknown_view():
    db = _StubDb()
    with _patched(db=db, user=APPROVER):
        resp = client.get("/api/v1/approvals?view=all")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_VIEW"
    assert resp.json()["detail"]["allowed"] == ["pending", "mine", "done"]


# ── 站内通知 ──────────────────────────────────────────────────────────────

def _notif_row(**over):
    row = {
        "id": 100, "tenant_id": "default", "team_id": 2, "user_id": 7,
        "type": "approval_requested", "title": "订单 ORD-US-ACM-1 的货物明细变更待审批",
        "body": "客户要求改包装规格", "link": "/approvals?focus=5",
        "ref_type": "order_item_change_request", "ref_id": 5,
        "read_at": None, "created_at": NOW,
    }
    row.update(over)
    return row


def test_notifications_list_unread_filter_and_pagination():
    db = _StubDb(fetchval=[1], fetch=[[_notif_row()]])
    with _patched(db=db, user=APPROVER):
        resp = client.get("/api/v1/notifications?unread=1&page=1&page_size=10")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["type"] == "approval_requested"
    assert item["link"] == "/approvals?focus=5"
    assert item["read_at"] is None
    assert set(item) == {"id", "type", "title", "body", "link", "ref_type",
                         "ref_id", "read_at", "created_at"}
    assert "read_at IS NULL" in db.sql()


def test_notifications_unread_count():
    db = _StubDb(fetchval=[3])
    with _patched(db=db, user=APPROVER):
        resp = client.get("/api/v1/notifications/unread-count")
    assert resp.status_code == 200
    assert resp.json() == {"unread": 3}


def test_mark_notification_read_only_own():
    db = _StubDb(fetchrow=[_notif_row(read_at=NOW)])
    with _patched(db=db, user=APPROVER):
        resp = client.post("/api/v1/notifications/100/read")
    assert resp.status_code == 200, resp.text
    assert resp.json()["read_at"] == NOW.isoformat()
    # 别人的通知 id 一律 404，不泄露存在性
    db = _StubDb(fetchrow=[None])
    with _patched(db=db, user=STRANGER):
        resp = client.post("/api/v1/notifications/100/read")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "NOTIFICATION_NOT_FOUND"


def test_mark_all_notifications_read_returns_count():
    db = _StubDb(fetchrow=[{"n": 4}])
    with _patched(db=db, user=APPROVER):
        resp = client.post("/api/v1/notifications/read-all")
    assert resp.status_code == 200
    assert resp.json() == {"marked": 4}
    assert "read_at IS NULL" in db.sql()


# ── 指定审批人（D-11 / D-14，仅团队管理员）─────────────────────────────────

def test_list_team_approvers_empty_means_team_admins():
    db = _StubDb(fetch=[[]])
    with _patched(db=db, user=TEAM_ADMIN):
        resp = client.get("/api/v1/team/approvers")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["team_id"] == 2
    assert body["items"] == []
    # 明确告诉前端"空名单时谁来批"
    assert body["fallback"] == "team_admins"


def test_list_team_approvers_without_team_says_tenant_admins():
    db = _StubDb(fetch=[[]])
    with _patched(db=db, user=ADMIN):
        resp = client.get("/api/v1/team/approvers")
    assert resp.status_code == 200
    assert resp.json() == {"team_id": None, "items": [],
                           "fallback": "tenant_admins"}


def test_replace_team_approvers_whole_table_replace():
    conn = _StubConn(
        fetchrow=[{"id": 5}],                       # _is_team_admin 通过
        fetch=[[{"id": 7}, {"id": 8}],              # 本团队成员
               [{"user_id": 7, "created_by": 5, "created_at": NOW,
                 "display_name": "审批人", "email": "a@q.test"}]],
    )
    with _patched(conn=conn, user=TEAM_ADMIN):
        resp = client.put("/api/v1/team/approvers",
                          json={"user_ids": [7, 8, 7]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # 去重后整表替换
    assert [i["user_id"] for i in body["items"]] == [7]
    assert body["items"][0]["display_name"] == "审批人"
    sql = conn.sql()
    assert "DELETE FROM team_approvers" in sql
    assert sql.count("INSERT INTO team_approvers") == 2


def test_replace_team_approvers_rejects_non_members():
    """把别的团队的人设成审批人，他会收到不属于自己团队的待批。"""
    conn = _StubConn(
        fetchrow=[{"id": 5}],
        fetch=[[{"id": 7}]],          # 只有 7 是本团队成员
    )
    with _patched(conn=conn, user=TEAM_ADMIN):
        resp = client.put("/api/v1/team/approvers", json={"user_ids": [7, 99]})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "APPROVER_NOT_IN_TEAM"
    assert detail["rejected"] == [99]
    assert "INSERT INTO team_approvers" not in conn.sql()


def test_replace_team_approvers_requires_team_admin():
    conn = _StubConn(fetchrow=[None])     # 不是团队创建者/管理员
    with _patched(conn=conn, user=STRANGER):
        resp = client.put("/api/v1/team/approvers", json={"user_ids": [7]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_TEAM_ADMIN"


def test_replace_team_approvers_rejects_non_numeric_ids():
    conn = _StubConn(fetchrow=[{"id": 5}], fetch=[[{"id": 7}]])
    with _patched(conn=conn, user=TEAM_ADMIN):
        resp = client.put("/api/v1/team/approvers", json={"user_ids": ["seven"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_USER_ID"


def test_replace_team_approvers_requires_a_team():
    conn = _StubConn()
    with _patched(conn=conn, user=ADMIN):
        resp = client.put("/api/v1/team/approvers", json={"user_ids": []})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "NO_TEAM"
