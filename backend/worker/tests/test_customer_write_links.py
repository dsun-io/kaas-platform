"""P2 写入侧：报价 / 订单 / 单证的**归属与包含关系**（Worker = 生产端）。

依据 `docs/CUSTOMER_DOCUMENTS_VIEW.md`（§1.5 包含关系即业务约束、§1.6 直接挂客户）
与 `docs/PLAN_CUSTOMER_RECORDS.md` 的 P2，这里钉住六条写入规则：

1. 报价必填业务客户（存在 / 未软删 / **属本团队**），否则 404 `CUSTOMER_NOT_FOUND`；
   没传 → 422 `CUSTOMER_REQUIRED`
2. 生成报价 → **同一事务**自动产出报价单（`trade_docs.doc_type='quotation'`、
   `quote_id=报价`、`order_id=NULL`、`doc_no=报价号`）
3. 报价转订单 → 写 `orders.quote_id`，客户 / 币种 / 金额 / 贸易条款继承
4. 由订单生成单证 → 写 `trade_docs.order_id`，`quote_id` 为 NULL（约束二选一）
5. 手动新建订单 / 单证：必选客户，父对象可选（没有就只归客户 → 读侧 `direct` 分组）
6. 三条写入路径共用 main 的同一道客户闸门（跨团队一律 404，不泄露存在性）

做法与 `test_four_domains.py` 一致：假 db + 假连接 + 覆盖鉴权依赖，不碰 Hyperdrive。
"""
import json
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import quote_api  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}
# 团队成员：团队 1 —— 客户闸门的"属本团队"就是拿它比的
MEMBER = {"id": 9, "account_type": "customer", "role": "user", "team_id": 1}


# ── 假连接 / 假 db ──────────────────────────────────────────────────────────

class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """冒充 `_acquire()` 吐出的 asyncpg 连接（写入 + 客户闸门都走它）。"""

    def __init__(self, fetchrow=None, fetch=None, fetchval=None):
        self._fetchrow = list(fetchrow or [])
        self._fetch = list(fetch or [])
        self._fetchval = list(fetchval or [])
        self.calls: list[tuple[str, tuple]] = []
        self.executed: list[tuple[str, tuple]] = []

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
        self.executed.append((sql, args))
        return "INSERT 0 1"

    def transaction(self):
        return _FakeTxn()

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)

    def executed_sql(self) -> str:
        return "\n".join(s for s, _ in self.executed)

    def args_of(self, needle: str):
        """第一条含 needle 的语句的参数（断言落库值用）。"""
        for sql, args in self.calls:
            if needle in sql:
                return args
        raise AssertionError(f"没有执行含 {needle!r} 的语句：\n{self.sql()}")


class _FakeDb:
    """冒充 platform/db.py（上游快照 / 事务连接 / 事件写入）。"""

    def __init__(self, *, fetchval=None, fetchrow=None, fetch=None, conn=None):
        self._fetchval = list(fetchval or [])
        self._fetchrow = list(fetchrow or [])
        self._fetch = list(fetch or [])
        self.conn = conn
        self.calls: list[tuple[str, str, tuple]] = []
        self.executed: list[tuple[str, tuple]] = []

    @asynccontextmanager
    async def acquire(self, request):
        yield self.conn

    async def fetchval(self, request, sql, *args, table=None):
        self.calls.append(("fetchval", sql, args))
        return self._fetchval.pop(0) if self._fetchval else 0

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append(("fetchrow", sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append(("fetch", sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, request, sql, *args):
        self.calls.append(("execute", sql, args))
        self.executed.append((sql, args))
        return "INSERT 0 1"


async def _fake_next_doc_no(request, doc_type):
    """固定取号（真实实现要连库；这里只验"号从哪来、写到哪去"）。"""
    return {
        "quotation": "QUO-202610-0007",
        "order": "ORD-202610-0001",
        "pi": "PI-202610-0002",
        "ci": "CI-202610-0003",
    }.get(doc_type, f"{doc_type.upper()[:3]}-202610-0009")


async def _fake_lock_fx(request, currency):
    return None, None


@contextmanager
def _patched(db, conn, user=MEMBER):
    """把 main / quote_api 的 db 与取号换成假实现，并覆盖鉴权依赖。"""
    old = (worker_main.db, worker_main._acquire, worker_main._next_doc_no,
           quote_api._db, quote_api._next_doc_no, quote_api._lock_fx_rate)

    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    worker_main.db = db
    worker_main._acquire = fake_acquire
    worker_main._next_doc_no = _fake_next_doc_no
    quote_api._db = db
    quote_api._next_doc_no = _fake_next_doc_no
    quote_api._lock_fx_rate = _fake_lock_fx
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield
    finally:
        (worker_main.db, worker_main._acquire, worker_main._next_doc_no,
         quote_api._db, quote_api._next_doc_no, quote_api._lock_fx_rate) = old
        worker_main.app.dependency_overrides.clear()


# ── 行构造 ──────────────────────────────────────────────────────────────────

def _customer(id=3, team_id=1, owner_id="9", name="Tim Trading", deleted=False):
    return {"id": id, "tenant_id": "default", "name": name, "company_name": name,
            "country": "US", "team_id": team_id, "owner_id": owner_id,
            "owner_scope": "private", "is_deleted": deleted, "stage": "lead"}


def _quote_row(**over):
    row = {"id": 7, "tenant_id": "default", "quote_no": "QUO-202610-0007",
           "customer_id": 3, "customer_name": "Tim Trading", "inquiry_id": None,
           "status": "draft", "currency": "USD", "total_amount": Decimal("1200.00"),
           "valid_until": None, "notes": None, "fx_rate": Decimal("7.1"),
           "fx_rate_date": None, "incoterm": "FOB", "payment_terms": "30% T/T",
           "port_of_loading": "NINGBO", "port_of_destination": "HAMBURG",
           "shipping_marks": None, "country_of_origin": "CN",
           "owner_id": "9", "owner_scope": "private", "team_id": 1,
           "created_at": datetime(2026, 10, 11, tzinfo=timezone.utc)}
    row.update(over)
    return row


def _order_row(**over):
    row = {"id": 9, "tenant_id": "default", "order_no": "ORD-202610-0001",
           "customer_id": 3, "customer_name": "Tim Trading", "status": "pending",
           "currency": "USD", "total_amount": Decimal("1200.00"),
           "order_date": None, "delivery_date": None, "notes": None,
           "quote_id": None, "owner_id": "9", "owner_scope": "private", "team_id": 1,
           "incoterm": "FOB", "payment_terms": "30% T/T",
           "port_of_loading": "NINGBO", "port_of_destination": "HAMBURG",
           "shipping_marks": None, "country_of_origin": "CN",
           "created_at": datetime(2026, 10, 11, tzinfo=timezone.utc)}
    row.update(over)
    return row


def _doc_row(**over):
    row = {"id": 12, "tenant_id": "default", "doc_no": "PI-202610-0002",
           "doc_type": "pi", "order_id": None, "quote_id": None, "customer_id": 3,
           "status": "draft", "currency": "USD", "total_amount": None,
           "issued_at": None, "issued_by": None,
           "raw_payload": {"sources": {}, "custom": {}}, "team_id": 1,
           "created_at": datetime(2026, 10, 11, tzinfo=timezone.utc)}
    row.update(over)
    return row


def _order_snapshot(**over):
    row = {"id": 3, "order_no": "ORD-202610-0001", "customer_id": 3,
           "customer_name": "Tim Trading", "status": "confirmed", "currency": "USD",
           "total_amount": 1200.0, "fx_rate": None, "incoterm": "FOB",
           "payment_terms": "T/T", "port_of_loading": "NINGBO",
           "port_of_destination": "HAMBURG", "shipping_marks": None,
           "country_of_origin": "CN"}
    row.update(over)
    return row


def _quote_snapshot(**over):
    row = {"id": 7, "quote_no": "QUO-202610-0007", "customer_id": 3,
           "customer_name": "Tim Trading", "status": "sent", "currency": "USD",
           "total_amount": 1200.0, "incoterm": "FOB", "payment_terms": "T/T",
           "port_of_loading": "NINGBO", "port_of_destination": "HAMBURG",
           "shipping_marks": None, "country_of_origin": "CN"}
    row.update(over)
    return row


_QUOTE_ITEM = {"sku_id": None, "product_name": "牛栏网", "spec_snapshot": {"mesh_mm": 100},
               "qty": Decimal("10"), "qty_unit": "ROLLS",
               "unit_price": Decimal("120"), "currency": "USD",
               "line_amount": Decimal("1200"), "sort_order": 0}


# ── 1. 报价必填客户（闸门）──────────────────────────────────────────────────

def test_quote_create_without_customer_is_422():
    conn = _FakeConn()
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/quotes", json={"currency": "USD"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "CUSTOMER_REQUIRED"
    # 客户没定下来就不该落任何报价行
    assert "INSERT INTO quote_orders" not in conn.sql()


def test_quote_create_rejects_customer_of_other_team():
    """客户属于别家团队 → 404（与"不存在"同形，不泄露存在性）。

    这里刻意让 owner_id = 调用者（否则会先在可见性那一层就 404）——
    验证的是**团队一致**这条判定本身。
    """
    conn = _FakeConn(fetchrow=[_customer(team_id=2, owner_id="9")])
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/quotes", json={"customer_id": 3})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"
    assert "INSERT INTO quote_orders" not in conn.sql()


def test_quote_create_rejects_soft_deleted_customer():
    conn = _FakeConn(fetchrow=[None])       # SQL 里带 is_deleted=false → 查不到
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/quotes", json={"customer_id": 3})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"


def test_quote_create_rejects_non_numeric_customer_id():
    """BIGINT 外键收不下 "cust-1"（前端历史 mock 形态）→ 422，不静默转 0。

    报价用的是 Pydantic 模型（字段级 422，与 dev 一致）；
    订单/单证走 dict 入参，由共享的 `_as_bigint` 给明确错误码（见下一条）。
    """
    conn = _FakeConn()
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/quotes", json={"customer_id": "cust-1"})
    assert resp.status_code == 422
    assert "INSERT INTO quote_orders" not in conn.sql()


def test_order_create_rejects_non_numeric_customer_id():
    conn = _FakeConn()
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/orders", json={"customer_id": "cust-1"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_CUSTOMER_ID"
    assert "INSERT INTO orders" not in conn.sql()


# ── 2. 生成报价 → 同一事务产出报价单 ────────────────────────────────────────

def test_quote_create_writes_customer_snapshot_and_quotation_doc():
    conn = _FakeConn(fetchrow=[_customer(), {"id": 9},       # 客户 → 自动建询盘
                               _quote_row(),                  # INSERT 报价
                               None,                          # 尚无报价单
                               {"id": 12}])                   # INSERT 报价单
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/quotes", json={
            "customer_id": 3, "currency": "USD", "incoterm": "FOB",
            "items": [{"product_name": "牛栏网", "qty": 10, "qty_unit": "ROLLS",
                       "unit_price": 120, "line_amount": 1200}],
        })
    assert resp.status_code == 201

    quote_args = conn.args_of("INSERT INTO quote_orders")
    assert quote_args[2] == 3                       # customer_id（来自闸门）
    assert quote_args[3] == "Tim Trading"           # customer_name 快照（没传就从客户行取）
    assert quote_args[-1] == 1                      # team_id = 客户团队（不是"创建者团队"）

    doc_sql, doc_args = next((s, a) for s, a in conn.calls
                             if "INSERT INTO trade_docs" in s)
    assert "'quotation'" in doc_sql and "NULL" in doc_sql   # doc_type 固定、order_id 定为 NULL
    assert doc_args[1] == "QUO-202610-0007"        # doc_no = 报价号
    assert doc_args[2] == 7                        # quote_id = 报价
    assert doc_args[3] == 3                        # customer_id 同报价
    assert doc_args[7] == 1                        # team_id 同客户
    payload = json.loads(doc_args[6])
    assert payload["sources"]["quote"]["quote_no"] == "QUO-202610-0007"
    assert payload["custom"]["quote_no"] == "QUO-202610-0007"    # 确认必填项预填

    assert "INSERT INTO trade_doc_items" in conn.executed_sql()  # 行项（可确认/可渲染）
    # 报价单的溯源靠 `trade_docs.quote_id` 列（INSERT 时已落，见上面 doc_args[2]）；
    # 旧 `trade_doc_quote_refs` 已随迁移 202610110014 改名 `_legacy` 留档 —— 不再写，
    # 边表由触发器 `trg_trade_docs_links` 从列自动派生。
    assert "trade_doc_quote_refs" not in conn.executed_sql()


def test_quote_patch_items_refreshes_draft_quotation_doc():
    """报价行项整批替换 → draft 报价单的行项与合计跟着走（工作台是"先建空单再加行"）。"""
    conn = _FakeConn(fetchrow=[_quote_row(status="draft"),   # _quote_or_404
                               {"id": 12}],                  # SELECT draft 报价单
                     fetch=[[]])                             # _items_of（响应里的行项）
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.put("/api/v1/quotes/7/items", json={
            "items": [{"product_name": "牛栏网", "qty": 10, "unit_price": 120,
                       "line_amount": 1200}]})
    assert resp.status_code == 200
    executed = conn.executed_sql()
    assert "DELETE FROM trade_doc_items" in executed
    assert "INSERT INTO trade_doc_items" in executed
    assert "UPDATE trade_docs SET total_amount" in executed


def test_quote_sent_backfills_missing_quotation_doc():
    """历史报价（本功能上线前建的）没有报价单 → 签发时补齐，而不是永远缺一张。"""
    conn = _FakeConn(fetchrow=[_quote_row(status="draft"),        # _quote_or_404
                               _quote_row(status="sent"),         # UPDATE ... RETURNING
                               None,                              # 无报价单
                               {"id": 12}],                       # INSERT 报价单
                     fetch=[[]])                                  # _items_of
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.patch("/api/v1/quotes/7", json={"status": "sent"})
    assert resp.status_code == 200
    assert "INSERT INTO trade_docs" in conn.sql()


def test_quote_patch_customer_syncs_quotation_doc():
    """换客户 → 报价单一起改挂（否则报价在一个客户下、报价单在另一个客户下）。"""
    conn = _FakeConn(fetchrow=[_quote_row(),
                               _customer(id=5, name="New Buyer"),
                               _quote_row(customer_id=5, customer_name="New Buyer")])
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.patch("/api/v1/quotes/7", json={"customer_id": 5})
    assert resp.status_code == 200
    assert "UPDATE trade_docs SET customer_id" in conn.executed_sql()
    update_args = next(a for s, a in conn.executed if "UPDATE trade_docs SET customer_id" in s)
    assert update_args[2] == 5


# ── 3. 报价转订单 ───────────────────────────────────────────────────────────

def test_order_from_quote_writes_quote_id_and_inherits():
    conn = _FakeConn(fetchrow=[_quote_row(status="sent"),   # 取报价
                               _customer(),                 # 客户（从报价继承）
                               _order_row(quote_id=7)],     # INSERT 订单
                     fetch=[[_QUOTE_ITEM]])                 # 报价行项（复制到订单）
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/orders", json={"quote_order_id": 7})
    assert resp.status_code == 201
    args = conn.args_of("INSERT INTO orders")
    assert args[9] == 7                             # orders.quote_id = 来源报价
    assert args[2] == 3 and args[3] == "Tim Trading"  # 客户及其名字快照继承
    assert args[4] == "USD"                         # 币种继承
    assert args[13] == "FOB" and args[14] == "30% T/T"   # 贸易条款继承
    assert args[15] == "NINGBO" and args[16] == "HAMBURG"
    executed = conn.executed_sql()
    assert "INSERT INTO order_items" in executed    # 行项复制
    # 报价来源关系只落列（args[9] == 7）：旧 `order_quote_refs` 已改名 `_legacy` 留档，
    # 边表由触发器 `trg_orders_links` 从 `orders.quote_id` 自动派生
    assert "order_quote_refs" not in executed
    assert "UPDATE quote_orders SET status='accepted'" in executed


def test_order_from_quote_rejects_non_convertible_status():
    conn = _FakeConn(fetchrow=[_quote_row(status="expired")])
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/orders", json={"quote_order_id": 7})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "QUOTE_NOT_CONVERTIBLE"


def test_order_from_invisible_quote_is_404():
    conn = _FakeConn(fetchrow=[_quote_row(owner_id="777", owner_scope="private",
                                          team_id=2)])
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/orders", json={"quote_order_id": 7})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "QUOTE_NOT_FOUND"


# ── 5a. 手动新建订单 ────────────────────────────────────────────────────────

def test_manual_order_requires_customer():
    conn = _FakeConn()
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/orders", json={"customer_name": "历史订单"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "CUSTOMER_REQUIRED"
    assert "INSERT INTO orders" not in conn.sql()


def test_manual_order_without_quote_goes_to_customer_only():
    """手动新建（导入历史订单）：只归客户 —— quote_id 必须为 NULL 而不是乱猜一张报价。"""
    conn = _FakeConn(fetchrow=[_customer(), _order_row()])
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/orders", json={"customer_id": 3,
                                                   "customer_name": "历史订单"})
    assert resp.status_code == 201
    args = conn.args_of("INSERT INTO orders")
    assert args[9] is None                          # 没有报价 → direct 分组
    assert args[3] == "历史订单"                     # 显式客户名优先于档案名
    assert "order_quote_refs" not in conn.executed_sql()   # 旧表已退场（只落列）


# ── 4/5b. 单证：父对象与归属 ────────────────────────────────────────────────

def test_trade_doc_from_order_writes_order_id_and_null_quote():
    """PI/CI/PL/BL 由订单生成：写 order_id，quote_id 必须为 NULL（约束二选一）。"""
    db = _FakeDb(fetchrow=[_order_snapshot()], fetch=[[_QUOTE_ITEM]])
    conn = _FakeConn(fetchrow=[_customer(), _doc_row(doc_no="PI-202610-0002",
                                                     order_id=3)])
    with _patched(db, conn):
        resp = client.post("/api/v1/trade-docs", json={"doc_type": "pi", "order_id": 3})
    assert resp.status_code == 201
    args = conn.args_of("INSERT INTO trade_docs")
    assert args[3] == 3 and args[4] is None          # order_id 落列、quote_id 为 NULL
    assert args[5] == 3                              # 客户由订单快照继承
    # 订单来源关系只落列（args[3] == 3）：旧 `trade_doc_order_refs` 已改名 `_legacy`
    # 留档、不再写，边表由触发器 `trg_trade_docs_links` 从列自动派生
    assert "trade_doc_order_refs" not in conn.executed_sql()


def test_trade_doc_from_quote_attaches_to_quote():
    """报价工作台"生成单证"只给 quote_order_id（还没转订单）→ 挂 quote_id。

    否则这张单会掉进 `direct`，客户页里"报价 → 它的单证"就断了。
    """
    db = _FakeDb(fetchrow=[_quote_snapshot()], fetch=[[_QUOTE_ITEM]])
    conn = _FakeConn(fetchrow=[_customer(), _doc_row(doc_no="CI-202610-0003",
                                                     quote_id=7)])
    with _patched(db, conn):
        resp = client.post("/api/v1/trade-docs", json={"doc_type": "ci",
                                                       "quote_order_id": 7})
    assert resp.status_code == 201
    args = conn.args_of("INSERT INTO trade_docs")
    assert args[3] is None and args[4] == 7          # 只挂报价
    assert args[5] == 3                              # 客户由报价快照继承
    # 报价来源关系只落列（args[4] == 7）：旧 `trade_doc_quote_refs` 已改名 `_legacy` 留档
    assert "trade_doc_quote_refs" not in conn.executed_sql()


def test_trade_doc_manual_customer_only_is_direct():
    """手动新建 / 导入历史单据：只选客户，两个父对象都为 NULL（约束允许）。"""
    conn = _FakeConn(fetchrow=[_customer(), _doc_row(doc_no="CI-202610-0003")])
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/trade-docs", json={"doc_type": "ci",
                                                       "customer_id": 3})
    assert resp.status_code == 201
    args = conn.args_of("INSERT INTO trade_docs")
    assert args[3] is None and args[4] is None
    assert args[5] == 3


def _inquiry_snapshot(**over):
    # 注意：DB 行里主键列名是 `id`（快照输出才叫 `inquiry_id`，见 doc_payload.inquiry_snapshot）
    row = {"id": 4, "customer_id": 3, "status": "open", "channel": "email",
           "product_name_raw": "牛栏网", "quantity": 10, "quantity_unit": "roll",
           "application": None}
    row.update(over)
    return row


def test_trade_doc_from_inquiry_writes_entity_link():
    """询盘来源：**没有列可挂**（`trade_docs` 只有 order_id / quote_id），

    所以关系只能落边表 `entity_links`（旧 `trade_doc_inquiry_refs` 已随 202610110014
    改名 `_legacy` 留档）。这条用例钉住"新写入点确实进了边表、且 rel_type 合法"——
    漏写不会有任何报错，只会让这张单永远查不到询盘来源。
    """
    db = _FakeDb(fetchrow=[_inquiry_snapshot()], fetch=[[]])
    conn = _FakeConn(fetchrow=[_customer(), _doc_row(doc_no="PI-202610-0009")])
    with _patched(db, conn):
        # 询盘**不继承** customer_id（worker 现有语义：只有 order/quote 继承），
        # 所以这里显式给客户 —— 与"手动新建必须选客户"同一条闸门
        resp = client.post("/api/v1/trade-docs", json={"doc_type": "pi",
                                                       "inquiry_id": 4, "customer_id": 3})
    assert resp.status_code == 201, resp.text
    executed = conn.executed_sql()
    assert "trade_doc_inquiry_refs" not in executed
    assert "INSERT INTO entity_links" in executed
    args = conn.args_of("INSERT INTO entity_links")
    assert args[1] == "trade_doc" and args[3] == "inquiry"   # 两端实体类型
    assert args[4] == 4                                      # dst_id = 询盘
    assert args[5] == "generated_from"                       # 内核 REL_TYPES 内的取值


def test_trade_doc_requires_customer():
    conn = _FakeConn()
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/trade-docs", json={"doc_type": "ci"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "CUSTOMER_REQUIRED"
    assert "INSERT INTO trade_docs" not in conn.sql()


def test_trade_doc_rejects_two_parents():
    """两个父对象同时给 → 422（约束要求二选一，静默丢一个会丢用户意图）。"""
    conn = _FakeConn()
    with _patched(_FakeDb(conn=conn), conn):
        resp = client.post("/api/v1/trade-docs",
                           json={"doc_type": "ci", "order_id": 3, "quote_id": 7})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PARENT_CONFLICT"
    assert conn.calls == []


def test_trade_doc_rejects_customer_mismatch_with_parent():
    """显式客户与上游单据的客户不一致 → 422（否则树里会"挂在 A、指向 B"）。"""
    db = _FakeDb(fetchrow=[_order_snapshot(customer_id=3)])
    conn = _FakeConn(fetchrow=[_customer(id=5)])
    with _patched(db, conn):
        resp = client.post("/api/v1/trade-docs",
                           json={"doc_type": "ci", "order_id": 3, "customer_id": 5})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "CUSTOMER_MISMATCH"


def test_trade_doc_quotation_is_idempotent():
    """报价单与报价 1:1：重复"生成"拿到同一张，不再开第二张。"""
    db = _FakeDb(fetchrow=[_quote_snapshot()], fetch=[[_QUOTE_ITEM]])
    existing = _doc_row(id=12, doc_no="QUO-202610-0007", doc_type="quotation",
                        quote_id=7)
    conn = _FakeConn(fetchrow=[_customer(), existing])
    with _patched(db, conn):
        resp = client.post("/api/v1/trade-docs",
                           json={"doc_type": "quotation", "quote_id": 7,
                                 "customer_id": 3})
    assert resp.status_code == 201
    assert resp.json()["id"] == 12
    assert "INSERT INTO trade_docs" not in conn.sql()
