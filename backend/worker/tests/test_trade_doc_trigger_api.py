"""A12 `trigger_expr` 求值的 **API 层**测试（doc-set GET 标注 / PUT 校验 / lint warning）。

起手式与 `test_trade_doc_hardening_api.py` 同一套：`_bootstrap.load_main()` + 按 SQL
路由的假 db + `TestClient` 打真实 HTTP。这里复用那个文件的 `_FakeDb` / `_patched` /
`client`，不复制一份假数据库（两份必然漂移）。

钉住的行为（对应任务书 3）：
1. `GET doc-set` 每项追加 `applicable`；required 且条件为假 ⇒ `skipped_by_trigger`
   （**不删除**项）；无法求值 ⇒ `trigger_error`（未知键结构码）且按"适用"处理；
2. `PUT doc-set` 的坏表达式 ⇒ **422 `TRIGGER_EXPR_INVALID` 且不落库**；
   合法表达式（含暂时未知的事实键）可以保存（键随 payload 演进）；
3. `POST lint`：required 条件不满足 ⇒ `DOC_SET_TRIGGER_SKIPPED` warning；
   无法求值 ⇒ `DOC_SET_TRIGGER_ERROR` warning；两者都**不阻断**（不产生 blocking）。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_trade_doc_hardening_api import (  # noqa: E402
    _FakeDb,
    _patched,
    client,
)


def _payload() -> dict:
    """最小 payload：上游 order 快照给出 `incoterm/total_amount/currency` 三条事实。

    `extract_facts` **只抽白名单字段**（贸易条款/金额/明细/身份/付款结构），
    不会把任意 `custom` 键都变成事实；这里用 `total_amount` 这类真实事实键做条件，
    避免测试依赖"事实层里还不存在的键"。事实来自上游快照且订单未标未确认
    ⇒ trust=confirmed，`/lint` 不会冒出无关的 FACT_UNVERIFIED blocking。
    """
    return {
        "sources": {
            "order": {
                "status": "confirmed",
                "currency": "USD",
                "total_amount": 1200,
                "incoterm": "FOB",
            },
        },
        "custom": {},
    }


def _items_by_type(resp_json: dict) -> dict[str, dict]:
    return {item["doc_type"]: item for item in resp_json["items"]}


# ── 1) GET doc-set：适用性标注 ─────────────────────────────────────────────

def test_doc_set_get_marks_applicable_and_skipped_by_trigger():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=_payload())
    fake.add_doc_set_item(11, "non_wood_packing", role="required",
                          trigger_expr="total_amount > 5000")
    fake.add_doc_set_item(11, "ci", role="required")
    fake.add_doc_set_item(11, "co", role="optional",
                          trigger_expr="total_amount > 5000")

    with _patched(fake):
        resp = client.get("/api/v1/trade-docs/11/doc-set")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    items = _items_by_type(body)
    assert body["total"] == 3

    # required + 条件假 ⇒ 不适用、标注跳过（**项还在清单里**）
    assert items["non_wood_packing"]["applicable"] is False
    assert items["non_wood_packing"]["skipped_by_trigger"] is True
    assert "触发条件不满足" in items["non_wood_packing"]["trigger_reason"]
    # 无表达式 ⇒ 恒适用
    assert items["ci"]["applicable"] is True
    assert items["ci"]["skipped_by_trigger"] is False
    assert items["ci"]["trigger_reason"] is None
    # 非 required：只标适用性，不标"跳过"
    assert items["co"]["applicable"] is False
    assert items["co"]["skipped_by_trigger"] is False
    # 原有字段不丢（GET 契约是**追加**，不是替换）
    assert items["non_wood_packing"]["role"] == "required"
    assert items["non_wood_packing"]["trigger_expr"] == "total_amount > 5000"
    assert items["non_wood_packing"]["status"] == "pending"


def test_doc_set_get_unknown_fact_key_returns_structured_trigger_error():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=_payload())
    fake.add_doc_set_item(11, "non_wood_packing", role="required",
                          trigger_expr="renamed_fact == true")

    with _patched(fake):
        resp = client.get("/api/v1/trade-docs/11/doc-set")
    assert resp.status_code == 200, resp.text
    item = _items_by_type(resp.json())["non_wood_packing"]
    # 未知键**不隐藏**必出单证：按适用处理，但结构化错误必须可见
    assert item["applicable"] is True
    assert item["skipped_by_trigger"] is False
    assert item["trigger_error"]["code"] == "TRIGGER_UNKNOWN_KEY"
    assert "无法求值" in item["trigger_reason"]


def test_doc_set_get_no_expression_keeps_legacy_shape_only_added_fields():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=_payload())
    fake.add_doc_set_item(11, "ci", role="required")

    with _patched(fake):
        resp = client.get("/api/v1/trade-docs/11/doc-set")
    item = _items_by_type(resp.json())["ci"]
    assert item["applicable"] is True
    assert "trigger_error" not in item      # 可选字段：无错误时不出现（契约按需）
    assert set(item) >= {
        "doc_type", "role", "issuer", "trigger_expr", "evidence_required",
        "status", "waived_reason", "received_doc_id", "received_at",
        "applicable", "skipped_by_trigger", "trigger_reason",
    }


# ── 2) PUT doc-set：坏表达式 422 且不落库 ─────────────────────────────────

def test_doc_set_put_rejects_bad_trigger_expression_and_does_not_persist():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=_payload())
    fake.add_doc_set_item(11, "ci", role="required")
    before = {key: dict(value) for key, value in fake.doc_set.items()}

    with _patched(fake):
        resp = client.put("/api/v1/trade-docs/11/doc-set", json={"items": [
            {"doc_type": "ci", "role": "required", "issuer": "ours",
             "trigger_expr": "total_amount =="},
        ]})

    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "TRIGGER_EXPR_INVALID"
    assert detail["trigger_error"]["code"] == "TRIGGER_SYNTAX"
    # **不落库**：校验在事务之前，清单原样未动
    assert fake.doc_set == before


def test_doc_set_put_accepts_expression_with_future_fact_key():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=_payload())
    fake.add_doc_set_item(11, "ci", role="required")

    with _patched(fake):
        resp = client.put("/api/v1/trade-docs/11/doc-set", json={"items": [
            {"doc_type": "ci", "role": "required", "issuer": "ours",
             "trigger_expr": "future_fact == true"},
            {"doc_type": "non_wood_packing", "role": "required", "issuer": "ours",
             "trigger_expr": "total_amount > 5000"},
        ]})

    assert resp.status_code == 200, resp.text
    items = _items_by_type(resp.json())
    # 合法（语法过）⇒ 已保存；PUT 响应沿用原契约（只回清单字段，不带求值标注）
    assert items["ci"]["trigger_expr"] == "future_fact == true"

    # 求值标注在 GET：未知键以 trigger_error 暴露（写入允许、读取可见）
    with _patched(fake):
        got = _items_by_type(client.get("/api/v1/trade-docs/11/doc-set").json())
    assert got["ci"]["trigger_error"]["code"] == "TRIGGER_UNKNOWN_KEY"
    assert got["non_wood_packing"]["applicable"] is False
    assert got["non_wood_packing"]["skipped_by_trigger"] is True


# ── 3) POST lint：trigger 只 warning、不阻断 ──────────────────────────────

def test_lint_warns_trigger_skipped_and_trigger_error_without_blocking():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=_payload())
    fake.add_doc_set_item(11, "non_wood_packing", role="required",
                          trigger_expr="total_amount > 5000")
    fake.add_doc_set_item(11, "ci", role="required",
                          trigger_expr="renamed_fact == 1")
    fake.add_doc_set_item(11, "co", role="optional",
                          trigger_expr="total_amount > 5000")

    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/lint")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # 不阻断：trigger 的两个问题都只进 warnings
    assert body["ok"] is True
    assert body["blocking"] == []
    codes = [warning["code"] for warning in body["warnings"]]
    assert "DOC_SET_TRIGGER_SKIPPED" in codes
    assert "DOC_SET_TRIGGER_ERROR" in codes

    skipped = [w for w in body["warnings"]
               if w["code"] == "DOC_SET_TRIGGER_SKIPPED"][0]
    assert skipped["doc_type"] == "non_wood_packing"
    assert skipped["trigger_expr"] == "total_amount > 5000"
    assert "本次不出该单证" in skipped["detail"]

    error = [w for w in body["warnings"]
             if w["code"] == "DOC_SET_TRIGGER_ERROR"][0]
    assert error["doc_type"] == "ci"
    assert error["trigger_error"]["code"] == "TRIGGER_UNKNOWN_KEY"
    # optional 项不产生 warning（只有 required 才有"本次不出"的语义）
    assert all(w["doc_type"] != "co" for w in body["warnings"])

    # summary 与 warnings 计数一致（不要各算一遍对不上）
    assert body["summary"]["warnings"] == len(body["warnings"])


def test_lint_unchanged_when_no_trigger_expressions():
    fake = _FakeDb()
    fake.add_doc(11, raw_payload=_payload())
    fake.add_doc_set_item(11, "ci", role="required")
    fake.add_doc_set_item(11, "co", role="optional")

    with _patched(fake):
        resp = client.post("/api/v1/trade-docs/11/lint")
    body = resp.json()
    assert body["ok"] is True
    assert not [w for w in body["warnings"]
                if w["code"].startswith("DOC_SET_TRIGGER")]
