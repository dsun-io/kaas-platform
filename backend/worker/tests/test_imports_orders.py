"""历史订单批量导入（C29）—— 预览 / 提交端点测试。

真源 = docs/IMPORT_ORDERS_PLAN_2026-10-23.md 第 2/3/5 节。桩连接风格与
test_admin_accounts.py / test_dashboard_receivables.py 一致：不触真库，
imports_api._acquire 换成桩，记录每条 SQL 与绑定参数 —— 用来断言
「预览零写入」「提交单事务」「撞库整批回滚」这三条硬口径。
"""
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

import imports_api  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

MEMBER = {"id": 3, "account_type": "internal", "role": "member", "team_id": 2}

CUSTOMER = {
    "id": 7,
    "name": "ACME Trading",
    "team_id": 2,
    "owner_id": 3,
    "owner_scope": "private",
    "is_deleted": False,
}

HEADER = "order_no,order_date,status,currency,total_amount,notes"

ORIGINAL_ACQUIRE = imports_api._acquire


# ── 桩连接 ───────────────────────────────────────────────────────────────────

class _StubTx:
    """冒充 conn.transaction()：记录是否真的开过事务、异常时是否回滚。"""

    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        self._conn.tx_started += 1
        return self._conn

    async def __aexit__(self, exc_type, exc, tb):
        if exc_type is not None:
            self._conn.rolled_back = True
        return False


class _StubAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _UniqueViolation(Exception):
    """asyncpg.exceptions.UniqueViolationError 的形状（sqlstate 23505）。"""

    sqlstate = "23505"


class _StubConn:
    def __init__(self, *, customer=CUSTOMER, existing=(), fail_insert_at=None):
        self.customer = customer
        self.existing = list(existing)
        self.fail_insert_at = fail_insert_at
        self.queries: list[tuple[str, tuple]] = []
        self.inserts: list[tuple] = []
        self.tx_started = 0
        self.rolled_back = False
        self._insert_no = 0
        self._next_id = 900

    def transaction(self):
        return _StubTx(self)

    async def fetchrow(self, sql, *args):
        self.queries.append((sql, args))
        if "FROM customers c" in sql:
            return self.customer
        if sql.lstrip().startswith("INSERT INTO orders"):
            self._insert_no += 1
            if self.fail_insert_at == self._insert_no:
                raise _UniqueViolation("duplicate key value violates unique constraint")
            self.inserts.append(args)
            self._next_id += 1
            return {"id": self._next_id}
        raise AssertionError("unexpected fetchrow: " + sql[:120])

    async def fetch(self, sql, *args):
        self.queries.append((sql, args))
        if "FROM orders WHERE tenant_id=$1 AND order_no = ANY" in sql:
            return [{"order_no": no} for no in self.existing]
        raise AssertionError("unexpected fetch: " + sql[:120])

    def sql_join(self) -> str:
        return "\n".join(sql for sql, _ in self.queries)

    def insert_args(self, index: int = 0) -> tuple:
        return self.inserts[index]


@contextmanager
def _patched(conn, user=MEMBER):
    imports_api._acquire = lambda _request: _StubAcquire(conn)
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        imports_api._acquire = ORIGINAL_ACQUIRE
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _csv(text: str, *, bom: bool = True) -> bytes:
    return text.encode("utf-8-sig" if bom else "utf-8")


def _post(path: str, body: str, *, customer_id: str = "7", bom: bool = True):
    return client.post(
        path,
        data={"customer_id": customer_id},
        files={"file": ("orders.csv", _csv(body, bom=bom), "text/csv")},
    )


PREVIEW = "/api/v1/imports/orders/preview"
COMMIT = "/api/v1/imports/orders"


# ── 预览（零写入）─────────────────────────────────────────────────────────────

def test_preview_valid_rows_shape_and_zero_writes():
    conn = _StubConn()
    body = HEADER + "\n" + (
        "SO-001,2026-05-01,completed,USD,1200.50,首单\n"
        "SO-002,2026-06-02,,,,\n"
    )
    with _patched(conn):
        resp = _post(PREVIEW, body, bom=False)  # 同时验无 BOM 的 UTF-8
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["customer"] == {"id": 7, "name": "ACME Trading"}
    assert payload["columns"] == [
        "order_no", "order_date", "status", "currency", "total_amount", "notes",
    ]
    assert payload["warnings"] == []

    first, second = payload["rows"]
    assert first["index"] == 1 and first["ok"] is True and first["errors"] == []
    assert first["data"] == {
        "order_no": "SO-001",
        "order_date": "2026-05-01",
        "status": "completed",
        "currency": "USD",
        "total_amount": 1200.5,
        "notes": "首单",
    }
    # 缺省口径：status=pending / currency=USD / 金额 NULL（不伪造 0）
    assert second["ok"] is True
    assert second["data"]["status"] == "pending"
    assert second["data"]["currency"] == "USD"
    assert second["data"]["total_amount"] is None
    assert second["data"]["notes"] is None

    assert payload["summary"] == {
        "total": 2, "ok": 2, "error": 0, "existing_order_nos": [],
    }
    # **零写入**：只有客户闸门查询 + 撞号预查两条 SELECT，没有 INSERT/UPDATE
    assert conn.inserts == []
    assert "INSERT" not in conn.sql_join()
    assert conn.tx_started == 0


def test_preview_unknown_column_is_warning_not_blocker():
    conn = _StubConn()
    body = "Order_No, ORDER_DATE ,status,currency,total_amount,notes,内部备注\n"
    body += "SO-001,2026-05-01,confirmed,CNY,10,\n"
    with _patched(conn):
        resp = _post(PREVIEW, body)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    # 表头归一：去空格 + 大小写不敏感
    assert payload["columns"][:2] == ["order_no", "order_date"]
    assert any("未知列已忽略" in w and "内部备注" in w for w in payload["warnings"])
    assert payload["rows"][0]["ok"] is True


def test_preview_missing_required_column_422():
    conn = _StubConn()
    with _patched(conn):
        resp = _post(PREVIEW, "order_no,status\nSO-001,completed\n")
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "validation"
    assert detail["code"] == "IMPORT_MISSING_COLUMNS"
    assert detail["columns"] == ["order_date"]
    assert conn.inserts == []


def test_preview_empty_file_422():
    conn = _StubConn()
    with _patched(conn):
        # 真·0 字节（bom=True 会给空串加上 BOM，那是「只有 BOM 没有表头」另一条用例）
        resp = _post(PREVIEW, "", bom=False)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "IMPORT_EMPTY_FILE"


def test_preview_no_header_422():
    conn = _StubConn()
    with _patched(conn):
        resp = _post(PREVIEW, "\n\n")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "IMPORT_NO_HEADER"


def test_preview_bad_date_is_row_error():
    conn = _StubConn()
    body = HEADER + "\nSO-001,2026-02-30,completed,USD,10,\n"
    with _patched(conn):
        resp = _post(PREVIEW, body)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    row = payload["rows"][0]
    assert row["ok"] is False and row["data"] is None
    assert any("order_date 不是合法日期" in e for e in row["errors"])
    assert payload["summary"] == {
        "total": 1, "ok": 0, "error": 1, "existing_order_nos": [],
    }
    assert conn.inserts == []


def test_preview_bad_enum_and_amount_are_row_errors():
    conn = _StubConn()
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,done,USD,10,\n"          # 坏状态
    body += "SO-002,2026-05-01,completed,RMB,10,\n"     # 坏币种
    body += "SO-003,2026-05-01,completed,USD,-1,\n"     # 负金额
    body += "SO-004,2026-05-01,completed,USD,abc,\n"    # 非数字
    with _patched(conn):
        resp = _post(PREVIEW, body)
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert any("status 非法" in e for e in rows[0]["errors"])
    assert any("currency 非法" in e for e in rows[1]["errors"])
    assert any("必须 ≥ 0" in e for e in rows[2]["errors"])
    assert any("必须是数字" in e for e in rows[3]["errors"])
    assert resp.json()["summary"]["error"] == 4


def test_preview_order_no_length_limit():
    conn = _StubConn()
    body = HEADER + "\n" + ("X" * 65) + ",2026-05-01,completed,USD,10,\n"
    with _patched(conn):
        resp = _post(PREVIEW, body)
    assert resp.status_code == 200, resp.text
    errors = resp.json()["rows"][0]["errors"]
    assert any("超过 64 字符" in e for e in errors)


def test_preview_duplicate_order_no_within_file():
    conn = _StubConn()
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,completed,USD,10,\n"
    body += "SO-001,2026-05-02,pending,USD,,\n"
    with _patched(conn):
        resp = _post(PREVIEW, body)
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert rows[0]["ok"] is True                # 第一次出现合法
    assert rows[1]["ok"] is False
    assert any("文件内重复（第 1 行）" in e for e in rows[1]["errors"])


def test_preview_duplicate_in_db_reported_as_row_error_and_summary():
    conn = _StubConn(existing=["SO-009"])
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,completed,USD,10,\n"
    body += "SO-009,2026-05-02,completed,USD,20,\n"
    with _patched(conn):
        resp = _post(PREVIEW, body)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    rows = payload["rows"]
    assert rows[0]["ok"] is True
    assert rows[1]["ok"] is False
    assert any("已存在于本租户" in e for e in rows[1]["errors"])
    assert payload["summary"] == {
        "total": 2, "ok": 1, "error": 1, "existing_order_nos": ["SO-009"],
    }
    assert conn.inserts == []


def test_preview_customer_not_found_404():
    conn = _StubConn(customer=None)
    body = HEADER + "\nSO-001,2026-05-01,completed,USD,10,\n"
    with _patched(conn):
        resp = _post(PREVIEW, body, customer_id="999")
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"
    assert conn.inserts == []


# ── 提交（单事务 · 全有全无）──────────────────────────────────────────────────

def test_commit_success_keeps_csv_order_no_and_single_transaction():
    conn = _StubConn()
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,completed,USD,1200.50,首单\n"
    body += "SO-002,2026-06-02,pending,CNY,,\n"
    with _patched(conn):
        resp = _post(COMMIT, body)
    assert resp.status_code == 201, resp.text
    assert resp.json() == {
        "created": 2, "ids": [901, 902], "order_nos": ["SO-001", "SO-002"],
    }
    assert conn.tx_started == 1              # 单事务：两行一个 transaction
    assert conn.rolled_back is False
    assert len(conn.inserts) == 2

    first = conn.insert_args(0)
    # order_no 用 CSV 值（不是 _next_customer_doc_no 生成的）
    assert first[0] == "default"            # tenant_id
    assert first[1] == "SO-001"
    assert first[2] == 7                    # customer_id
    assert first[3] == "ACME Trading"       # 客户名快照
    assert first[4] == "completed"
    assert first[5] == "USD"
    assert first[6] == Decimal("1200.50")
    assert first[7] == datetime(2026, 5, 1, tzinfo=timezone.utc)
    assert first[8] == "首单"
    assert first[9] == "3"                  # created_by = user.id
    assert first[10] == "3"                 # owner_id = user.id
    assert first[11] == 2                   # team_id = customer.team_id

    # 列名单与 main.py:4308-4316 同源；历史补录口径：direct / 无询盘 / 无报价
    sql = conn.sql_join()
    assert "INSERT INTO orders" in sql
    assert "source_type" in sql and "inquiry_id" in sql and "quote_id" in sql
    assert "'direct'" in sql
    assert "'private'" in sql

    second = conn.insert_args(1)
    assert second[6] is None and second[8] is None   # 金额/备注缺省 NULL，不伪造 0


def test_commit_any_error_row_422_and_zero_write():
    conn = _StubConn()
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,completed,USD,10,\n"
    body += "SO-002,not-a-date,completed,USD,10,\n"
    with _patched(conn):
        resp = _post(COMMIT, body)
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "validation"
    assert detail["code"] == "IMPORT_HAS_ERRORS"
    assert [r["index"] for r in detail["rows"]] == [2]
    assert any("order_date" in e for e in detail["rows"][0]["errors"])
    assert conn.inserts == []
    assert conn.tx_started == 0              # 未开事务 = 零写入


def test_commit_duplicate_in_db_409_before_any_insert():
    conn = _StubConn(existing=["SO-002"])
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,completed,USD,10,\n"
    body += "SO-002,2026-05-02,completed,USD,20,\n"
    with _patched(conn):
        resp = _post(COMMIT, body)
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "conflict"
    assert detail["code"] == "IMPORT_DUPLICATE_ORDER_NO"
    assert detail["order_nos"] == ["SO-002"]
    assert conn.inserts == []
    assert conn.tx_started == 0


def test_commit_unique_race_409_rolls_back_whole_batch():
    # 预查时库里还没有，插入第二行时才撞唯一键 ⇒ 整批回滚 + 409
    conn = _StubConn(existing=[], fail_insert_at=2)
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,completed,USD,10,\n"
    body += "SO-002,2026-05-02,completed,USD,20,\n"
    with _patched(conn):
        resp = _post(COMMIT, body)
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "IMPORT_DUPLICATE_ORDER_NO"
    assert conn.rolled_back is True          # 事务回滚
    assert len(conn.inserts) == 1            # 第一行虽写过，但已随事务回滚
    # 回查仍空 ⇒ 冲突集合按整批单号上报（竞态兜底口径）
    assert detail["order_nos"] == ["SO-001", "SO-002"]


def test_commit_duplicate_within_file_is_422_not_409():
    conn = _StubConn(existing=[])
    body = HEADER + "\n"
    body += "SO-001,2026-05-01,completed,USD,10,\n"
    body += "SO-001,2026-05-02,completed,USD,20,\n"
    with _patched(conn):
        resp = _post(COMMIT, body)
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "IMPORT_HAS_ERRORS"
    assert [r["index"] for r in detail["rows"]] == [2]
    assert conn.inserts == []
