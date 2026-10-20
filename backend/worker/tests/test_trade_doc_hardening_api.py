"""A7-2 单证加固 HTTP 层测试（事实/一致性/lint/收款/单证清单/导出自检 + confirm 闸门）。

无数据库、无网络：与 `test_events_admin_gate.py` / `test_trade_doc_content_versions.py`
同一套起手式 —— `_bootstrap.load_main()` 拿一个干净、自洽的 app，把 `db` 换成
**按 SQL 路由**的假实现，再用 `TestClient` 打**真实 HTTP**（校验 pydantic 入参、
状态码、错误体与依赖链，而不是只调 handler）。

为什么假 db 用"按 SQL 路由"而不是队列：本文件覆盖 11 个端点 + confirm 闸门，
每个端点的查询条数与顺序不同（还要叠加渲染装配的既有查询），队列式假 db 会被
"多一条/少一条"搞得极难维护。按 SQL 特征路由到内存表，断言才是在看**行为**。

覆盖（对应任务书 10 个端点 + 计划 §8 的验收断言）：
1. 事实清单 / 确认 / 禁改 value（`FACT_VALUE_IMMUTABLE_STORAGE`）；
2. 一致性：Incoterms 版本被删 ⇒ `FACT_CONFLICT`；词表内改述 ⇒ 只有 warning；
3. lint：未确认事实 / 不可改写 / 引用悬空 / 越权出单 → blocking；金额不符 → warning；
4. 收款：容差内 `fx_rounding` 自动核销、超差 `short_paid`；
5. 单证清单：枚举校验、重复 409、全量替换保留回执、回执状态机（含非法转移 409）；
6. 导出自检：通过 / 默认阻断 422 / `allow_override` 放行且落审计 / 图片计数不符；
7. **confirm 闸门**：未确认事实 ⇒ 422 `FACT_UNVERIFIED`；确认后 ⇒ 200；
   无事实数据的单证（改造前行为）⇒ 零影响；`allow_lint_override` ⇒ 放行 + 审计。
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_docs_ext  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

ADMIN = {"id": 7, "account_type": "internal", "role": "system_admin", "team_id": None}


# ─── 假 db：按 SQL 特征路由到内存表 ─────────────────────────────────────────

class _FakeDb:
    """冒充 platform/db（`(request, sql, *args, table=None)`）+ 事务连接（`(sql, *args)`）。"""

    def __init__(self) -> None:
        self.docs: dict[int, dict] = {}
        self.links: list[dict] = []
        self.facts: dict[tuple[int, str], dict] = {}
        self.fact_receipts: list[dict] = []          # 收款
        self.doc_set: dict[tuple[int, str], dict] = {}
        self.items: dict[int, list[dict]] = {}
        self.events: list[dict] = []
        self.writes: list[tuple[str, tuple]] = []
        self._seq = 500

    # ── 装载 ──
    def add_doc(self, doc_id: int, **over) -> dict:
        row = {
            "id": doc_id, "tenant_id": "default", "doc_no": f"LJ-CI-20261012-{doc_id:02d}",
            "doc_type": "ci", "order_id": None, "quote_id": None, "customer_id": 3,
            "status": "draft", "currency": "USD", "total_amount": None,
            "issued_at": None, "issued_by": None,
            "raw_payload": {"sources": {}, "custom": {}},
            "created_at": datetime(2026, 10, 12, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 10, 12, tzinfo=timezone.utc),
            "owner_id": None, "owner_scope": "private", "team_id": None,
        }
        row.update(over)
        self.docs[doc_id] = row
        return row

    def add_link(self, src_id: int, dst_type: str, dst_id: int) -> None:
        self.links.append({"src_type": "trade_doc", "src_id": src_id,
                           "dst_type": dst_type, "dst_id": dst_id,
                           "rel_type": "generated_from", "deleted_at": None})

    def add_fact_row(self, doc_id: int, fact_key: str, **over) -> dict:
        row = {
            "fact_key": fact_key, "trust": "unverified", "immutable": None,
            "confirmed_by": None, "confirmed_at": None, "text_zh": None,
            "text_en": None, "source": None, "evidence_ref": None,
        }
        row.update(over)
        self.facts[(doc_id, fact_key)] = row
        return row

    def add_doc_set_item(self, doc_id: int, doc_type: str, **over) -> dict:
        row = {
            "doc_type": doc_type, "role": "required", "issuer": "ours",
            "trigger_expr": None, "evidence_required": False, "status": "pending",
            "waived_reason": None, "received_doc_id": None, "received_at": None,
        }
        row.update(over)
        self.doc_set[(doc_id, doc_type)] = row
        return row

    # ── 读 ──
    async def fetch(self, request, sql, *args, table=None):
        return self._read(sql, args)

    async def fetchrow(self, request, sql, *args, table=None):
        self.writes.append(("fetchrow", args))
        if "UPDATE trade_docs SET status='issued'" in sql:
            doc = self.docs[args[1]]
            doc.update({"status": "issued", "issued_at": args[2], "issued_by": args[3],
                        "raw_payload": self._loads(args[4])})
            return dict(doc)
        if "INSERT INTO trade_doc_receipts" in sql:
            return self._insert_receipt(args)
        if "UPDATE trade_doc_doc_set_items" in sql:
            return self._doc_set_receipt(args)
        if sql.startswith("SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2"):
            return self.docs.get(int(args[1]))
        # 渲染装配用到的其它表：单证照常、其余返回可用的最小行
        if "FROM customers" in sql:
            return {"id": 3, "name": "ACME", "address": "Hamburg"}
        if "FROM tenant_company_profile" in sql:
            return {"name_en": "KAAS TRADING CO., LTD", "address_en": "Hebei, China"}
        return None

    async def fetchval(self, request, sql, *args, table=None):
        return 1

    def _read(self, sql: str, args: tuple):
        if "doc_type = ANY" in sql:
            wanted = set(args[1] or [])
            order_id, customer_id = args[2], args[3]
            out = []
            for doc in self.docs.values():
                if doc["doc_type"] not in wanted or doc["status"] == "void":
                    continue
                if order_id is not None and doc.get("order_id") == order_id:
                    out.append(dict(doc))
                elif order_id is None and doc.get("customer_id") == customer_id:
                    out.append(dict(doc))
            return out
        if "FROM entity_links l" in sql:                      # 引用完整性（LEFT JOIN 单据）
            rows = []
            for link in self.links:
                if link["src_type"] != "trade_doc" or link["src_id"] != args[1]:
                    continue
                if link["dst_type"] != "trade_doc" or link["deleted_at"] is not None:
                    continue
                target = self.docs.get(link["dst_id"])
                rows.append({
                    "target_id": link["dst_id"],
                    "target_doc_id": target["id"] if target else None,
                    "doc_no": target["doc_no"] if target else None,
                    "doc_type": target["doc_type"] if target else None,
                    "status": target["status"] if target else None,
                })
            return rows
        if "FROM trade_doc_facts" in sql:
            return [dict(row) for (doc_id, _key), row in sorted(self.facts.items())
                    if doc_id == args[1]]
        if "FROM trade_doc_doc_set_items" in sql and "doc_type=$3" in sql:
            row = self.doc_set.get((args[1], args[2]))
            return [dict(row)] if row else []
        if "FROM trade_doc_doc_set_items" in sql:
            return [dict(row) for (doc_id, _type), row in sorted(self.doc_set.items())
                    if doc_id == args[1]]
        if "FROM trade_doc_items" in sql:
            return [dict(row) for row in self.items.get(args[1], [])]
        if "FROM trade_doc_receipts" in sql:
            return [dict(row) for row in self.fact_receipts
                    if row["trade_doc_id"] == args[1]]
        if "FROM trade_docs" in sql and "order_id=$2" in sql:
            return [dict(doc) for doc in self.docs.values()
                    if doc.get("order_id") == args[1] and doc["status"] != "void"]
        if "FROM trade_docs" in sql and "quote_id=$2" in sql:
            return [dict(doc) for doc in self.docs.values()
                    if doc.get("quote_id") == args[1] and doc["status"] != "void"]
        if "FROM entity_links" in sql and "dst_type='order'" in sql:
            for link in self.links:
                if link["src_id"] == args[1] and link["dst_type"] == "order":
                    return [{"dst_id": link["dst_id"]}]
            return []
        if "FROM entity_links" in sql and "dst_type='quote'" in sql:
            for link in self.links:
                if link["src_id"] == args[1] and link["dst_type"] == "quote":
                    return [{"dst_id": link["dst_id"]}]
            return []
        if "SELECT 1 FROM trade_docs" in sql:
            return [{"exists": 1}] if int(args[1]) in self.docs else []
        return []

    # ── 写 ──
    async def execute(self, *args):
        if args and isinstance(args[0], str):
            sql, params = args[0], args[1:]
        else:
            sql, params = args[1], args[2:]
        self.writes.append((sql, params))
        if "INSERT INTO trade_doc_facts" in sql:
            self.facts[(params[1], params[4])] = {
                "fact_key": params[4], "trust": params[11], "immutable": params[12],
                "confirmed_by": params[13], "confirmed_at": params[14],
                "text_zh": params[8], "text_en": params[9],
                "source": params[10], "evidence_ref": params[15],
            }
        elif "INSERT INTO trade_doc_doc_set_items" in sql:
            for doc_type, role, issuer, trigger, evidence in zip(
                    params[2], params[3], params[4], params[5], params[6]):
                row = self.doc_set.get((params[1], doc_type))
                if row is None:
                    row = self.add_doc_set_item(params[1], doc_type)
                row.update({"role": role, "issuer": issuer,
                            "trigger_expr": trigger, "evidence_required": evidence})
        elif "DELETE FROM trade_doc_doc_set_items" in sql:
            keep = set(params[2] or [])
            for key in list(self.doc_set):
                if key[0] == params[1] and key[1] not in keep:
                    self.doc_set.pop(key)
        elif "INSERT INTO business_events" in sql:
            self.events.append({"event_type": params[1],
                                "payload": self._loads(params[4]),
                                "actor_id": params[5]})
        elif "INSERT INTO trade_doc_content_versions" in sql:
            pass
        return "OK"

    # ── 事务连接 ──
    def transaction(self):
        @asynccontextmanager
        async def _txn():
            yield None
        return _txn()

    # ── 内部 ──
    @staticmethod
    def _loads(value):
        import json
        if isinstance(value, str):
            return json.loads(value)
        return value

    def _insert_receipt(self, params) -> dict:
        self._seq += 1
        row = {
            "id": self._seq, "tenant_id": params[0], "trade_doc_id": params[1],
            "schedule_type": params[2], "schedule_amount": params[3],
            "received_amount": params[4], "currency": params[5],
            "received_at": params[6], "bank_ref": params[7], "diff": params[8],
            "diff_reason": params[9], "fx_rate_used": params[10], "status": params[11],
            "notes": params[12], "created_by": params[13],
            "created_at": params[6],
        }
        self.fact_receipts.append(row)
        return dict(row)

    def _doc_set_receipt(self, params) -> dict | None:
        row = self.doc_set.get((params[1], params[2]))
        if row is None or row["status"] != "pending":
            return None
        row.update({"status": params[3], "waived_reason": params[4],
                    "received_doc_id": params[5],
                    "received_at": params[5] and datetime.now(timezone.utc)})
        return dict(row)


@contextmanager
def _patched(fake: _FakeDb, user: dict = ADMIN):
    """把 db / _acquire / 鉴权依赖全部换掉（与既有 worker API 测试同法）。"""
    @asynccontextmanager
    async def fake_acquire(request):
        yield fake

    old = {
        "main_db": worker_main.db,
        "ext_db": ws_docs_ext.db,
        "acquire": worker_main._acquire,
    }
    worker_main.db = fake
    ws_docs_ext.db = fake
    worker_main._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield fake
    finally:
        worker_main.db = old["main_db"]
        ws_docs_ext.db = old["ext_db"]
        worker_main._acquire = old["acquire"]
        worker_main.app.dependency_overrides.clear()


# ─── 夹具：真实形状的 payload（2026-10-12 Tim 单的几个关键数字）────────────

ORDER = {
    "order_no": "LJ-O-20260928-01",
    "customer_name": "Tim Lyons",
    "status": "confirmed",
    "currency": "USD",
    "total_amount": 2826.49,
    "fx_rate": 6.7029,
    "incoterm": "DAP Yangzhou, Jiangsu, China (Incoterms 2020)",
    "payment_terms": "30% deposit upon order confirmation, 70% balance before dispatch",
    "port_of_loading": "Shanghai",
    "port_of_destination": "Yangzhou",
    "country_of_origin": "China",
    "shipping_marks": "N/M",
    "items": [{"product_name": "立柱", "qty": 400, "unit_price": 3.7297,
               "line_amount": 1491.88}],
}


def payload_with(**override) -> dict:
    order = dict(ORDER)
    order.update(override)
    return {"sources": {"order": order}, "custom": {}}


def _doc_items(doc_id: int, fake: _FakeDb) -> None:
    fake.items[doc_id] = [{"product_name": "立柱", "qty": 400,
                           "unit_price": 3.7297, "line_amount": 1491.88}]


# ─── 1) 事实清单 / 确认 / 禁改值 ───────────────────────────────────────────

def test_facts_list_summarizes_trust_and_overlays_table():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    # 表内处置：把 incoterm 标记不可改写 + 改掉英文文本 + 已确认
    fake.add_fact_row(11, "incoterm", trust="confirmed", immutable=True,
                      confirmed_by="7",
                      confirmed_at=datetime(2026, 10, 20, tzinfo=timezone.utc),
                      text_en="DAP Yangzhou (Incoterms 2020)",
                      evidence_ref="custom.incoterm")
    with _patched(fake):
        resp = client.get("/api/v1/trade-docs/11/facts")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    items = {item["key"]: item for item in body["items"]}
    # 上游快照 → 已确认；付款结构解析 → 未确认（推断值不得进 issued）
    assert items["incoterm"]["trust"] == "confirmed"
    assert items["incoterm"]["immutable"] is True
    assert items["incoterm"]["text_en"] == "DAP Yangzhou (Incoterms 2020)"
    assert items["payment_deposit_ratio"]["trust"] == "unverified"
    assert items["payment_deposit_ratio"]["value"] == "0.3"
    # 汇总：来源覆盖与计数
    summary = body["summary"]
    assert summary["total"] == len(body["items"])
    assert summary["confirmed"] >= 2          # incoterm + 其它上游事实
    assert summary["unverified"] == 4         # 定金/尾款的比例与时点
    assert summary["confirmed"] + summary["unverified"] + summary["inferred"] == summary["total"]


def test_facts_confirm_all_unverified_then_summary():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/facts/confirm", json={})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert sorted(body["confirmed"]) == [
            "payment_balance_ratio", "payment_balance_timing",
            "payment_deposit_ratio", "payment_deposit_timing",
        ]
        assert body["summary"]["unverified"] == 0
        assert body["summary"]["confirmed"] == body["summary"]["total"]
        # 落库：trust=confirmed + confirmed_by=当前用户
        row = fake.facts[(11, "payment_deposit_ratio")]
        assert row["trust"] == "confirmed" and row["confirmed_by"] == "7"
        # 审计事件（谁确认了哪些事实）
        assert [event["event_type"] for event in fake.events] == [
            "trade_doc.facts_confirmed"]
        assert "payment_deposit_ratio" in fake.events[0]["payload"]["keys"]


def test_facts_confirm_specific_keys_and_unknown_key():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        ok = client.post("/api/v1/trade-docs/11/facts/confirm",
                         json={"keys": ["payment_deposit_ratio"]})
        assert ok.status_code == 200
        assert ok.json()["confirmed"] == ["payment_deposit_ratio"]
        assert ok.json()["summary"]["unverified"] == 3
        bad = client.post("/api/v1/trade-docs/11/facts/confirm",
                          json={"keys": ["no_such_fact"]})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "FACT_KEY_UNKNOWN"


def test_facts_patch_cannot_change_value():
    """值由 payload 决定：改值必须 422，而不是静默忽略（否则表与 payload 分叉）。"""
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.patch("/api/v1/trade-docs/11/facts/incoterm",
                            json={"value": "FOB Shanghai"})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "FACT_VALUE_IMMUTABLE_STORAGE"
    assert "payload" in detail["detail"]


def test_facts_patch_updates_trust_and_text():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.patch(
            "/api/v1/trade-docs/11/facts/payment_deposit_ratio",
            json={"trust": "confirmed", "text_zh": "定金 30%", "immutable": True})
    assert resp.status_code == 200, resp.text
    item = resp.json()["item"]
    assert item["trust"] == "confirmed"
    assert item["text_zh"] == "定金 30%"
    assert item["immutable"] is True
    assert fake.facts[(11, "payment_deposit_ratio")]["trust"] == "confirmed"


def test_facts_patch_unknown_key_and_bad_trust():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        missing = client.patch("/api/v1/trade-docs/11/facts/no_such_fact",
                               json={"trust": "confirmed"})
        invalid = client.patch("/api/v1/trade-docs/11/facts/incoterm",
                               json={"trust": "maybe"})
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "FACT_NOT_FOUND"
    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "INVALID_ENUM"


# ─── 2) 跨单证一致性 ──────────────────────────────────────────────────────

def test_consistency_reports_missing_incoterms_version():
    """§8-1：删掉 CI 的 Incoterms 版本 ⇒ `FACT_CONFLICT(incoterm)`。"""
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", order_id=1, status="issued",
                 raw_payload=payload_with())
    fake.add_doc(12, doc_type="ci", order_id=1,
                 raw_payload=payload_with(incoterm="DAP Yangzhou, Jiangsu, China"))
    with _patched(fake):
        resp = client.get("/api/v1/trade-docs/12/consistency")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["domain"]["root"] == "order:1"
    assert set(body["domain"]["doc_ids"]) == {"11", "12"}
    conflict = [item for item in body["items"]
                if item["key"] == "incoterm" and item["severity"] == "error"]
    assert conflict, body["items"]
    assert conflict[0]["code"] == "FACT_CONFLICT"
    assert conflict[0]["baseline_doc"] == "11"
    assert "Incoterms 2020" in conflict[0]["values"]["11"]


def test_consistency_equivalent_wording_is_warning_only():
    """改述在词表内 ⇒ 只有 warning，`ok` 仍为 True（绝不静默吞差异）。"""
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", order_id=1, status="issued",
                 raw_payload=payload_with())
    fake.add_doc(12, doc_type="contract", order_id=1, raw_payload=payload_with(
        payment_terms="30% deposit upon confirmation of the order, "
                      "70% balance upon dispatch (before delivery)"))
    with _patched(fake):
        resp = client.get("/api/v1/trade-docs/12/consistency")
    body = resp.json()
    assert body["ok"] is True
    warnings = [item for item in body["items"]
                if item["key"] == "payment_terms" and item["severity"] == "warning"]
    assert warnings and warnings[0]["code"] == "FACT_EQUIVALENT_WORDING"


def test_consistency_uses_quote_chain_when_no_order():
    fake = _FakeDb()
    fake.add_doc(21, doc_type="quotation", quote_id=9, status="issued",
                 raw_payload={"sources": {"quote": {"quote_no": "LJ-Q-1",
                                                    "currency": "USD"}}, "custom": {}})
    fake.add_doc(22, doc_type="pi", quote_id=9,
                 raw_payload={"sources": {"quote": {"quote_no": "LJ-Q-1",
                                                    "currency": "CNY"}}, "custom": {}})
    with _patched(fake):
        resp = client.get("/api/v1/trade-docs/22/consistency")
    body = resp.json()
    assert body["domain"]["root"] == "quote:9"
    assert body["ok"] is False
    assert [item["key"] for item in body["items"] if item["severity"] == "error"] == ["currency"]


# ─── 3) lint（blocking / warnings）────────────────────────────────────────

def test_lint_blocks_unverified_then_ok_after_confirm():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        first = client.post("/api/v1/trade-docs/11/lint")
        assert first.status_code == 200
        body = first.json()
        assert body["ok"] is False
        codes = [item["code"] for item in body["blocking"]]
        assert "FACT_UNVERIFIED" in codes
        unverified = [item for item in body["blocking"]
                      if item["code"] == "FACT_UNVERIFIED"][0]
        assert "payment_deposit_ratio" in unverified["keys"]

        client.post("/api/v1/trade-docs/11/facts/confirm", json={})
        second = client.post("/api/v1/trade-docs/11/lint").json()
    assert second["ok"] is True
    assert second["blocking"] == []


def test_lint_flags_rewritten_immutable_term():
    """§8-3：派生单把 PI 的定金比例从 30% 改成 50% ⇒ `FACT_IMMUTABLE`。"""
    fake = _FakeDb()
    payload = payload_with()
    payload["custom"]["payment_terms"] = "50% deposit upon order confirmation, 50% balance before dispatch"
    fake.add_doc(12, doc_type="contract", raw_payload=payload)
    with _patched(fake):
        body = client.post("/api/v1/trade-docs/12/lint").json()
    immutable = [item for item in body["blocking"] if item["code"] == "FACT_IMMUTABLE"]
    assert immutable, body["blocking"]
    ratio = [item for item in immutable if item["keys"] == ["payment_deposit_ratio"]][0]
    assert ratio["original"] == "0.3" and ratio["provided"] == "0.5"
    assert "原值引用" in ratio["detail"]


def test_lint_flags_broken_doc_reference():
    """§8-5：引用一张不存在/未签发的单证 ⇒ `DOC_REF_BROKEN`（blocking）。"""
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    fake.add_doc(12, doc_type="pi", status="draft", raw_payload={})
    fake.add_link(11, "trade_doc", 12)          # 11 引用 12（12 还是 draft）
    fake.add_link(11, "trade_doc", 999)         # 11 引用 999（不存在）
    with _patched(fake):
        body = client.post("/api/v1/trade-docs/11/lint").json()
    broken = [item for item in body["blocking"] if item["code"] == "DOC_REF_BROKEN"]
    assert len(broken) == 2
    assert {item.get("doc_no") for item in broken} == {"LJ-CI-20261012-12", None}
    assert body["ok"] is False


def test_lint_flags_not_by_us_doc_type():
    """§8-4：清单标了 not_by_us，却真的开出了这类单据 ⇒ `DOC_SET_NOT_ALLOWED`。"""
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", order_id=1, raw_payload=payload_with())
    fake.add_doc(13, doc_type="pl", order_id=1, raw_payload={})
    fake.add_doc_set_item(11, "pl", role="not_by_us", issuer="buyer")
    with _patched(fake):
        body = client.post("/api/v1/trade-docs/11/lint").json()
    violation = [item for item in body["blocking"]
                 if item["code"] == "DOC_SET_NOT_ALLOWED"]
    assert violation and violation[0]["doc_type"] == "pl"
    assert "越权出单" in violation[0]["detail"]


def test_lint_amount_mismatch_is_warning_not_blocking():
    fake = _FakeDb()
    fake.add_doc(11, total_amount=200, raw_payload=payload_with())
    _doc_items(11, fake)                      # 400 × 3.7297 = 1491.88 ≠ 200
    with _patched(fake):
        body = client.post("/api/v1/trade-docs/11/lint").json()
    warnings = [item for item in body["warnings"] if item["code"] == "FACT_CONFLICT"]
    assert warnings and warnings[0]["key"] == "total_amount"
    assert all(item["code"] != "FACT_CONFLICT" for item in body["blocking"])


# ─── 4) 收款登记（容差口径）──────────────────────────────────────────────

def test_receipt_within_tolerance_auto_reconciled():
    """§8-6：合同 847.95、实收 847.93 ⇒ 容差内自动核销（fx_rounding）。"""
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/receipts", json={
            "schedule_type": "deposit", "schedule_amount": 847.95,
            "received_amount": 847.93, "currency": "USD", "bank_ref": "MT103-1",
        })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["item"]["status"] == "reconciled"
    assert body["item"]["diff_reason"] == "fx_rounding"
    assert body["verdict"]["auto_cleared"] is True
    assert body["verdict"]["diff"] == "-0.02"


def test_receipt_beyond_tolerance_is_short_paid():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/receipts", json={
            "schedule_amount": 847.95, "received_amount": 800, "currency": "USD"})
    body = resp.json()
    assert body["item"]["status"] == "short_paid"
    assert body["item"]["diff_reason"] == "short_paid"
    assert body["verdict"]["auto_cleared"] is False


def test_receipt_rejects_unknown_currency_and_bad_amount():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        bad_currency = client.post("/api/v1/trade-docs/11/receipts", json={
            "received_amount": 10, "currency": "XYZ"})
        bad_amount = client.post("/api/v1/trade-docs/11/receipts", json={
            "received_amount": "not-a-number"})
    assert bad_currency.status_code == 422
    assert bad_currency.json()["detail"]["code"] == "INVALID_ENUM"
    assert bad_amount.status_code == 422
    assert bad_amount.json()["detail"]["code"] == "INVALID_RECEIPT"


def test_receipt_without_schedule_is_manual():
    """没账期金额（手工登记）⇒ 无从核销，如实记 manual，不冒充"已核销"。"""
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/receipts", json={
            "received_amount": 500, "currency": "USD"})
    body = resp.json()
    assert body["item"]["status"] == "manual"
    assert body["item"]["diff_reason"] == "manual"


def test_receipt_list_returns_registered_rows():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        client.post("/api/v1/trade-docs/11/receipts", json={
            "schedule_amount": 100, "received_amount": 100, "currency": "USD"})
        resp = client.get("/api/v1/trade-docs/11/receipts")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["received_amount"] == "100"
    assert body["items"][0]["diff_reason"] == "fx_rounding"


# ─── 5) 单证清单 + 回执状态机 ─────────────────────────────────────────────

def test_doc_set_put_validates_doc_type_role_issuer_duplicates():
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", raw_payload=payload_with())
    with _patched(fake):
        bad_type = client.put("/api/v1/trade-docs/11/doc-set", json={
            "items": [{"doc_type": "not_a_doc", "role": "required", "issuer": "ours"}]})
        bad_role = client.put("/api/v1/trade-docs/11/doc-set", json={
            "items": [{"doc_type": "pl", "role": "maybe", "issuer": "ours"}]})
        bad_issuer = client.put("/api/v1/trade-docs/11/doc-set", json={
            "items": [{"doc_type": "pl", "role": "required", "issuer": "nobody"}]})
        dup = client.put("/api/v1/trade-docs/11/doc-set", json={"items": [
            {"doc_type": "pl", "role": "required", "issuer": "ours"},
            {"doc_type": "pl", "role": "optional", "issuer": "ours"},
        ]})
    assert bad_type.status_code == 422 and bad_type.json()["detail"]["code"] == "DOC_SET_INVALID"
    assert bad_role.status_code == 422
    assert bad_issuer.status_code == 422
    assert dup.status_code == 409
    assert dup.json()["detail"]["code"] == "DOC_SET_DUPLICATE"


def test_doc_set_put_replaces_list_and_keeps_registered_receipt():
    """全量替换：新清单外的删掉；仍在清单里的**保留回执状态**（不能把回执抹掉）。"""
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", raw_payload=payload_with())
    fake.add_doc_set_item(11, "pl", role="not_by_us", issuer="buyer",
                          status="received", received_doc_id=13)
    fake.add_doc_set_item(11, "co", role="required", issuer="third_party:ccpit")
    with _patched(fake):
        resp = client.put("/api/v1/trade-docs/11/doc-set", json={"items": [
            {"doc_type": "pl", "role": "not_by_us", "issuer": "buyer",
             "evidence_required": True},
            {"doc_type": "ci", "role": "required", "issuer": "ours"},
        ]})
        assert resp.status_code == 200, resp.text
        items = {item["doc_type"]: item for item in resp.json()["items"]}
    assert set(items) == {"pl", "ci"}          # co 被移除
    assert items["pl"]["status"] == "received"  # 回执状态保留
    assert items["pl"]["received_doc_id"] == 13
    assert items["pl"]["evidence_required"] is True
    assert items["ci"]["status"] == "pending"


def test_doc_set_receipt_receive_then_illegal_transition():
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", raw_payload=payload_with())
    fake.add_doc(13, doc_type="pl")
    fake.add_doc_set_item(11, "pl", role="not_by_us", issuer="buyer")
    with _patched(fake):
        first = client.post("/api/v1/trade-docs/11/doc-set/pl/receipt",
                            json={"action": "receive", "received_doc_id": 13})
        assert first.status_code == 200, first.text
        assert first.json()["item"]["status"] == "received"
        again = client.post("/api/v1/trade-docs/11/doc-set/pl/receipt",
                            json={"action": "waive", "waived_reason": "对方不出"})
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "ILLEGAL_DOC_SET_TRANSITION"
    assert again.json()["detail"]["current"] == "received"


def test_doc_set_receipt_waive_requires_reason_and_unknown_item():
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", raw_payload=payload_with())
    fake.add_doc_set_item(11, "pl", role="not_by_us", issuer="buyer")
    with _patched(fake):
        no_reason = client.post("/api/v1/trade-docs/11/doc-set/pl/receipt",
                                json={"action": "waive"})
        ok = client.post("/api/v1/trade-docs/11/doc-set/pl/receipt",
                         json={"action": "waive", "waived_reason": "拼柜方自出"})
        unknown = client.post("/api/v1/trade-docs/11/doc-set/ci/receipt",
                              json={"action": "receive"})
    assert no_reason.status_code == 422
    assert ok.status_code == 200
    assert ok.json()["item"]["status"] == "waived"
    assert ok.json()["item"]["waived_reason"] == "拼柜方自出"
    assert unknown.status_code == 404
    assert unknown.json()["detail"]["code"] == "DOC_SET_ITEM_NOT_FOUND"


def test_doc_set_receipt_rejects_missing_received_doc():
    fake = _FakeDb()
    fake.add_doc(11, doc_type="pi", raw_payload=payload_with())
    fake.add_doc_set_item(11, "pl", role="not_by_us", issuer="buyer")
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/doc-set/pl/receipt",
                           json={"action": "receive", "received_doc_id": 999})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "DOC_NOT_FOUND"


# ─── 6) 导出后自检 ───────────────────────────────────────────────────────

def test_verify_export_passes_when_texts_and_images_match():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/verify-export", json={
            "texts": ["Total Amount", "USD 2,826.49"],
            # PDF 抽取出来的文本会断行/插空格：自检按去空白比对
            "pdf_text": "Total\nAmount   USD 2,8\n26.49",
            "image_counts": {"stamp": 1},
        })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True and body["overridden"] is False
    assert body["missing_texts"] == []


def test_verify_export_blocks_by_default_when_text_missing():
    """§8-7：单元格文本没出现在 PDF 里（被截断）⇒ 默认**阻断**导出。"""
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/verify-export", json={
            "texts": ["Total Amount", "No.1 Guangling Road"],
            "pdf_text": "Total Amount only",
            "image_counts": {"stamp": 1},
        })
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "EXPORT_SELF_CHECK_FAILED"
    assert detail["missing_texts"] == ["No.1 Guangling Road"]
    assert detail["image_mismatches"] == []


def test_verify_export_image_count_mismatch():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/verify-export", json={
            "texts": ["Total Amount"], "pdf_text": "Total Amount",
            "image_counts": {"stamp": 2},      # 公章劈页 ⇒ 抽出 2 张
        })
    assert resp.status_code == 422
    assert resp.json()["detail"]["image_mismatches"] == [
        {"key": "stamp", "expected": 1, "actual": 2}]


def test_verify_export_override_passes_and_writes_audit():
    """`allow_override=true` ⇒ 200 + overridden + **审计留痕**（越过必须有凭据）。"""
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=payload_with())
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/verify-export", json={
            "texts": ["Missing Text"], "pdf_text": "nothing here",
            "image_counts": {"stamp": 1}, "allow_override": True,
        })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["overridden"] is True and body["ok"] is True
    assert body["missing_texts"] == ["Missing Text"]
    assert [event["event_type"] for event in fake.events] == [
        "trade_doc.export_override"]
    assert fake.events[0]["payload"]["missing_texts"] == ["Missing Text"]


# ─── 7) confirm 闸门（ws_docs_ext 集成）───────────────────────────────────

def _confirm_fake() -> _FakeDb:
    fake = _FakeDb()
    fake.add_doc(11, doc_type="ci", total_amount=1491.88,
                 raw_payload=payload_with(incoterm="DAP Yangzhou"))
    _doc_items(11, fake)
    return fake


def test_confirm_blocked_by_unverified_facts_then_passes_after_confirm():
    """§8-2：未确认事实存在 ⇒ confirm 422 `FACT_UNVERIFIED`；确认后 ⇒ 200。"""
    fake = _confirm_fake()
    with _patched(fake):
        blocked = client.post("/api/v1/trade-docs/11/confirm", json={})
        assert blocked.status_code == 422, blocked.text
        detail = blocked.json()["detail"]
        assert detail["code"] == "FACT_UNVERIFIED"
        assert "payment_deposit_ratio" in detail["blocking"][0]["keys"]
        assert fake.docs[11]["status"] == "draft"      # 没被签发

        assert client.post("/api/v1/trade-docs/11/facts/confirm", json={}).status_code == 200
        passed = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert passed.status_code == 200, passed.text
    assert passed.json()["status"] == "issued"


def test_confirm_without_any_facts_is_unaffected():
    """改造前行为：没有任何事实数据的单证照常签发（零影响）。"""
    fake = _FakeDb()
    fake.add_doc(11, doc_type="ci", total_amount=100,
                 raw_payload={"sources": {}, "custom": {}})
    fake.items[11] = [{"product_name": "牛栏网", "qty": 1, "unit_price": 100,
                       "line_amount": 100}]
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "issued"


def test_confirm_override_passes_and_writes_audit():
    fake = _confirm_fake()
    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/confirm",
                           json={"allow_lint_override": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "issued"
    assert [event["event_type"] for event in fake.events] == [
        "trade_doc.confirm_override"]
    assert fake.events[0]["payload"]["blocking"]


def test_confirm_blocked_by_rewritten_immutable_term():
    """§8-3 的 HTTP 侧：派生单改了 PI 定金比例 ⇒ 签发被 422 `FACT_IMMUTABLE` 拦下。"""
    fake = _FakeDb()
    payload = payload_with()
    payload["custom"]["payment_terms"] = (
        "50% deposit upon order confirmation, 50% balance before dispatch")
    fake.add_doc(11, doc_type="ci", total_amount=1491.88, raw_payload=payload)
    _doc_items(11, fake)
    with _patched(fake):
        # 先确认掉全部未确认事实，排除 FACT_UNVERIFIED 的干扰，只看不可改写这一项
        client.post("/api/v1/trade-docs/11/facts/confirm", json={})
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "FACT_IMMUTABLE"
    ratio = [item for item in detail["blocking"]
             if item.get("keys") == ["payment_deposit_ratio"]][0]
    assert ratio["original"] == "0.3" and ratio["provided"] == "0.5"


# ─── 8) 通用：单证不存在 / 作废单证 ──────────────────────────────────────

def test_unknown_doc_returns_404():
    fake = _FakeDb()
    with _patched(fake):
        probes = (
            ("get", "/api/v1/trade-docs/999/facts", None),
            ("get", "/api/v1/trade-docs/999/consistency", None),
            ("post", "/api/v1/trade-docs/999/lint", {}),
            ("get", "/api/v1/trade-docs/999/doc-set", None),
            ("post", "/api/v1/trade-docs/999/verify-export", {}),
        )
        for method, path, payload in probes:
            resp = getattr(client, method)(path) if payload is None else getattr(client, method)(path, json=payload)
            assert resp.status_code == 404, (method, path, resp.text)


def test_void_doc_fact_writes_rejected():
    fake = _FakeDb()
    fake.add_doc(11, status="void", raw_payload=payload_with())
    with _patched(fake):
        confirm = client.post("/api/v1/trade-docs/11/facts/confirm", json={})
        put = client.put("/api/v1/trade-docs/11/doc-set",
                         json={"items": [{"doc_type": "pl"}]})
    assert confirm.status_code == 409
    assert confirm.json()["detail"]["code"] == "DOC_NOT_EDITABLE"
    assert put.status_code == 409



