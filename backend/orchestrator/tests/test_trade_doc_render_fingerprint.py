"""C 方案：签发时冻结「渲染输入快照指纹」的单测（内核 + 签发侧壳）。

为什么需要这个文件
------------------
用户拍板做 C 方案：归档的 PDF 只记了**内容** sha256，没有记"用**哪一版渲染器/模板**、
**哪一份数据**出的"。新增的 `raw_payload["_render"]` 就是为了回答那两个审计问题。
它坏掉的方式**全是静默的**：

1. **摘要不确定**（依赖 dict 顺序、依赖当次时间、依赖驱动给的是 Decimal 还是 float）
   ⇒ 同一份内容两次算出不同指纹 ⇒ 指纹没有用，且没人会发现；
2. **摘要漏字段**（例如只摘要 `raw_payload` 而漏了企业主体抬头、买方、产品图 data URI、
   默认公章）⇒ 事后"照指纹复核"会得出错误结论：数据明明变了却显示"一致"；
3. **摘要包了签发动作自己写的时间字段** ⇒ 冻结的摘要"出生即失效"
   （签发前装配得到 `created_at`、签发后得到 `issued_at`，永不相等）；
4. **装配失败时伪造一个假摘要** ⇒ 看起来"已冻结"，实际无从追溯。

本文件把这些逐条钉住，并给出"两端一份"的证据（Worker 侧用的是同一份内核镜像）。
"""
from __future__ import annotations

import hashlib
import types
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException

from kaas_common.trade_doc import (
    RENDER_CHECK_VERDICTS,
    RENDER_DIGEST_IGNORED_FIELDS,
    RENDER_KEY,
    RENDER_VERSION,
    canonical_render_input,
    read_render_fingerprint,
    render_fingerprint,
    render_fingerprint_check,
    render_input_digest,
)
from kaas_common.trade_doc.payload_shared import DOC_NO_FIELDS

from app.api import trade_docs as trade_docs_api

pytestmark = pytest.mark.unit

FROZEN_AT = "2026-10-12T00:00:00+00:00"

# 一份"装配好的渲染数据"的缩小版：字段名与 `build_render_data` 的产出一致。
ASSEMBLED = {
    "seller": {"company": "KAAS TRADING CO., LTD", "address": "Hebei, China"},
    "buyer": {"name": "BABAN KORI", "address": "Iraq"},
    "consignee": {"name": "BABAN KORI", "address": "Iraq"},
    "items": [{"product_name": "Chain Link Fence", "qty": 100, "unit_price": 12.5,
               "line_amount": 1250.0}],
    "currency": "USD",
    "total_amount": 1250.0,
    "incoterm": "FOB",
    "payment_terms": "30% T/T",
    "pi_no": "PI-202610-0001",
    "pi_date": "2026-10-11T00:00:00+00:00",
    "product_photos": [{"image": "data:image/png;base64,iVBORw0KGgo=", "caption": "photo 1"}],
    "company_stamp": "data:image/png;base64,iVBORw0KGgo=",
}


def _copy(**overrides):
    data = {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v)
            for k, v in ASSEMBLED.items()}
    data.update(overrides)
    return data


class TestDeterminism:
    def test_same_input_same_digest(self):
        assert render_input_digest(ASSEMBLED) == render_input_digest(_copy())

    def test_key_order_irrelevant(self):
        ordered = {"a": 1, "b": {"x": 1, "y": 2}, "c": [{"m": 1, "n": 2}]}
        shuffled = {"c": [{"n": 2, "m": 1}], "b": {"y": 2, "x": 1}, "a": 1}
        assert render_input_digest(ordered) == render_input_digest(shuffled)
        # 逐层反过来也要一致（顶层排序不够：嵌套映射同样要规范化）
        assert render_input_digest({"b": {"y": 2, "x": 1}}) == render_input_digest({"b": {"x": 1, "y": 2}})

    def test_list_order_matters(self):
        """行项顺序**有意义**（就是单据上的行序），不能被无序化。"""
        first = {"items": [{"qty": 1}, {"qty": 2}]}
        second = {"items": [{"qty": 2}, {"qty": 1}]}
        assert render_input_digest(first) != render_input_digest(second)

    def test_digest_is_sha256_hex(self):
        digest = render_input_digest(ASSEMBLED)
        assert isinstance(digest, str) and len(digest) == 64
        int(digest, 16)  # 十六进制

    def test_decimal_and_float_agree(self):
        """两端驱动不同（SQLAlchemy/float vs asyncpg/Decimal）⇒ 必须归一。"""
        assert render_input_digest({"total_amount": Decimal("1250.00")}) == \
            render_input_digest({"total_amount": 1250.0})
        assert render_input_digest({"qty": Decimal("3")}) == render_input_digest({"qty": 3})

    def test_datetime_and_iso_string_agree(self):
        stamp = datetime(2026, 10, 12, 8, 30, tzinfo=timezone.utc)
        # 注意：datetime 类字段若**不在**忽略名单里，应能稳定序列化（这里用业务字段名）
        assert render_input_digest({"delivery_date": stamp}) == \
            render_input_digest({"delivery_date": stamp.isoformat()})

    def test_non_mapping_is_not_fingerprinted(self):
        for value in (None, [], "html", 123):
            assert render_input_digest(value) is None


class TestIncludedFields:
    """改了任何一处'客户看得到'的数据 ⇒ 摘要必须变。"""

    @pytest.mark.parametrize("override", [
        {"total_amount": 1251.0},
        {"currency": "EUR"},
        {"incoterm": "CIF"},
        {"seller": {"company": "ANOTHER CO", "address": "Hebei, China"}},
        {"buyer": {"name": "OTHER BUYER", "address": "Iraq"}},
        {"items": [{"product_name": "Chain Link Fence", "qty": 101, "unit_price": 12.5,
                    "line_amount": 1262.5}]},
        {"product_photos": [{"image": "data:image/png;base64,AAAA", "caption": "photo 1"}]},
        {"company_stamp": "data:image/png;base64,BBBB"},
        {"pi_no": "PI-202610-0002"},
        {"remarks": "new remark"},
    ])
    def test_included_field_change_changes_digest(self, override):
        assert render_input_digest(_copy(**override)) != render_input_digest(ASSEMBLED)

    def test_added_field_changes_digest(self):
        assert render_input_digest(_copy(extra="x")) != render_input_digest(ASSEMBLED)


class TestIgnoredFields:
    """被排除的字段（理由见内核注释）：签发动自己写的时间、系统记录键、请求级易变值。"""

    @pytest.mark.parametrize("field,value", [
        ("pi_date", "2026-10-12T09:00:00+00:00"),
        ("created_at", "2026-01-01T00:00:00+00:00"),
        ("issued_at", "2026-10-12T09:00:00+00:00"),
        ("issued_by", "17"),
        ("updated_at", "2026-10-12T09:00:00+00:00"),
        ("frozen_at", FROZEN_AT),
        ("request_id", "req-42"),
        ("trace_id", "trace-42"),
        ("now", "2026-10-12T09:00:00+00:00"),
        ("_audit", [{"at": FROZEN_AT, "by": "1", "changed": {"x": {"from": 1, "to": 2}}}]),
    ])
    def test_volatile_field_does_not_change_digest(self, field, value):
        assert render_input_digest(_copy(**{field: value})) == render_input_digest(ASSEMBLED)

    def test_all_doc_type_date_fields_are_ignored(self):
        """回归：新增单据类型带日期字段时，若忘了进忽略名单，摘要会"出生即失效"。

        装配层对每种类型写 `data[date_field] = issued_at or created_at`
        （`build_render_data`），所以**所有** DOC_NO_FIELDS 的日期字段都必须在名单里。
        """
        date_fields = {d for _no, d in DOC_NO_FIELDS.values() if d}
        assert date_fields, "DOC_NO_FIELDS 没解析出日期字段，说明结构变了"
        missing = date_fields - RENDER_DIGEST_IGNORED_FIELDS
        assert not missing, f"这些单据日期字段没被排除，会让指纹随签发时刻变化：{sorted(missing)}"

    def test_client_injected_render_key_cannot_influence_digest(self):
        """`custom._render` 会落进渲染数据；它不能反过来影响指纹（自指）。"""
        injected = _copy(**{"_render": {"input_sha256": "deadbeef", "render_version": 99}})
        assert render_input_digest(injected) == render_input_digest(ASSEMBLED)

    def test_reproducible_across_issue_transition(self):
        """**这条是 C 方案的命门**：签发前装配（日期取 created_at）与签发后装配
        （日期取 issued_at）必须算出**同一个**摘要 —— 否则冻结的指纹当场就与
        "拿同一行重新装配"的结果不一致，可复现性归零。"""
        before_issue = _copy(pi_date="2026-10-10T10:00:00+00:00")   # = created_at
        after_issue = _copy(pi_date="2026-10-12T09:30:00+00:00")    # = issued_at
        assert render_input_digest(before_issue) == render_input_digest(after_issue)


class TestFingerprintShape:
    def test_shape_and_values(self):
        meta = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
        assert meta == {
            "render_version": RENDER_VERSION,
            "input_sha256": render_input_digest(ASSEMBLED),
            "frozen_at": FROZEN_AT,
        }
        assert RENDER_KEY == "_render"
        # 🔒 **钉住当前版本值**：改 `render.ts` / `assets.json` / `manifest.json`（或渲染器行为）
        # 就必须 bump `RENDER_VERSION`，并**同步改这一行**。这一步是故意的：
        # `input_sha256` 只能证明"输入没变"，证明不了"输出没变"，而渲染器在前端 TS 里 ——
        # 没有 CI 能自动看出"模板改了却没 bump"。把值钉住，让"忘了 bump"在评审里
        # 以一次**显式**改动暴露出来（而不是静默失真）。
        assert RENDER_VERSION == 1

    def test_unavailable_input_is_marked_not_faked(self):
        meta = render_fingerprint(None, frozen_at=FROZEN_AT)
        assert meta["render_version"] == RENDER_VERSION
        assert meta["input_sha256"] is None
        assert meta["note"] == "input_unavailable"
        assert meta["frozen_at"] == FROZEN_AT

    def test_default_frozen_at_is_utc_iso(self):
        meta = render_fingerprint(ASSEMBLED)
        parsed = datetime.fromisoformat(meta["frozen_at"])
        assert parsed.tzinfo is not None
        assert parsed.utcoffset() == timedelta(0)


class TestReadFingerprint:
    def test_reads_from_dict_payload(self):
        payload = {"sources": {}, "custom": {}, RENDER_KEY: render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)}
        assert read_render_fingerprint(payload)["input_sha256"] == render_input_digest(ASSEMBLED)

    def test_reads_from_json_string_payload(self):
        import json
        payload = json.dumps({RENDER_KEY: render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)})
        assert read_render_fingerprint(payload)["frozen_at"] == FROZEN_AT

    @pytest.mark.parametrize("payload", [None, {}, {"sources": {}}, {"_render": "x"},
                                         {"_render": []}, "{not json"])
    def test_missing_or_malformed_is_none(self, payload):
        assert read_render_fingerprint(payload) is None


class TestCanonicalInput:
    def test_snapshot_is_inspectable(self):
        canonical = canonical_render_input({"b": 1, "a": Decimal("2.5"), "_audit": [1]})
        assert canonical == {"b": 1, "a": 2.5}   # 排除键在规范化阶段就被丢掉

    def test_unknown_types_become_readable_strings(self):
        class Weird:
            def __str__(self):
                return "weird"

        assert render_input_digest({"x": Weird()}) == render_input_digest({"x": "weird"})


class TestSharedKernelMirror:
    """两端一份的证据：Worker 用的是**同一份内核文件的镜像**（sync-shared 复制）。"""

    def test_worker_mirror_is_byte_identical(self):
        root = Path(__file__).resolve().parents[3]
        source = root / "backend" / "kaas_common" / "trade_doc" / "render_fingerprint.py"
        mirror = root / "backend" / "worker" / "src" / "kaas_common" / "trade_doc" / "render_fingerprint.py"
        assert source.exists(), "内核源文件不见了"
        assert mirror.exists(), "Worker 镜像缺失：请跑 scripts/sync-shared.ps1"
        assert (hashlib.sha256(source.read_bytes()).hexdigest()
                == hashlib.sha256(mirror.read_bytes()).hexdigest()), \
            "Worker 镜像与内核不一致：请跑 scripts/sync-shared.ps1"


# ── 签发侧壳：装配 → 指纹（不碰 DB，直接替掉装配函数）────────────────────────

class TestFreezeHelper:
    async def test_uses_assembled_data_not_payload(self, monkeypatch):
        async def _fake(doc_id, auth, db):
            return {"data": {"currency": "USD", "total_amount": 100.0}}

        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data", _fake)
        now = datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc)
        meta = await trade_docs_api._freeze_render_fingerprint(doc_id=5, auth=None, db=None, now=now)

        assert meta["render_version"] == RENDER_VERSION
        assert meta["input_sha256"] == render_input_digest(
            {"currency": "USD", "total_amount": 100.0})
        assert meta["frozen_at"] == now.isoformat()
        assert "note" not in meta

    async def test_assembly_failure_degrades_but_never_fakes(self, monkeypatch):
        async def _boom(doc_id, auth, db):
            raise RuntimeError("assembly exploded")

        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data", _boom)
        meta = await trade_docs_api._freeze_render_fingerprint(
            doc_id=5, auth=None, db=None, now=datetime(2026, 10, 12, tzinfo=timezone.utc))
        assert meta["input_sha256"] is None
        assert meta["note"] == "input_unavailable"

    async def test_empty_assembly_is_also_marked(self, monkeypatch):
        async def _fake(doc_id, auth, db):
            return {"data": {}}      # 空数据也算"可用输入"（摘要非空），不该标 note

        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data", _fake)
        meta = await trade_docs_api._freeze_render_fingerprint(
            doc_id=5, auth=None, db=None, now=datetime(2026, 10, 12, tzinfo=timezone.utc))
        assert meta["input_sha256"] == render_input_digest({})
        assert "note" not in meta


# ── 对账（消费者）：五种情形 ─────────────────────────────────────────────────
#
# 为什么"匹配"与"不匹配"要分别构造成**真的两件事**：如果两例都用同一个表达式
# 生成期望值，测试就只是在自证"函数等于它自己"。所以这里：
#   · 匹配例：冻结一份数据 A，再用**另一种键顺序**独立构造的同一份内容去比对
#     （证明摘要与顺序无关、且确实相等）；
#   · 不匹配例：真的改一处**被纳入摘要的业务数据**（总金额 / 卖方抬头），
#     断言它被检出，并断言差异**不是**来自版本漂移（两件事分开）。

class TestFingerprintCheck:
    def test_matched(self):
        frozen = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
        # 独立构造：键顺序打乱、容器新建（不是同一个对象引用）
        current = {k: ASSEMBLED[k] for k in sorted(ASSEMBLED, reverse=True)}
        current["items"] = [dict(ASSEMBLED["items"][0])]

        out = render_fingerprint_check(frozen, current, checked_at=FROZEN_AT)

        assert out["has_fingerprint"] is True
        assert out["matches"] is True
        assert out["reason"] == "matched"
        assert out["current_sha256"] == frozen["input_sha256"]
        assert out["render_version_frozen"] == out["render_version_current"] == RENDER_VERSION
        assert out["render_version_drift"] is False
        assert out["current_note"] is None and out["frozen_note"] is None
        assert out["checked_at"] == FROZEN_AT

    @pytest.mark.parametrize("changed", [
        {"total_amount": 9999.0},                       # 金额
        {"currency": "EUR"},                            # 币种
        {"seller": {"company": "IMPOSTOR CO", "address": "Hebei, China"}},  # 卖方抬头
        {"items": [{"product_name": "Chain Link Fence", "qty": 999,
                    "unit_price": 12.5, "line_amount": 12487.5}]},          # 行项
    ])
    def test_data_changed_is_detected(self, changed):
        frozen = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)

        out = render_fingerprint_check(frozen, _copy(**changed), checked_at=FROZEN_AT)

        assert out["has_fingerprint"] is True
        assert out["matches"] is False
        assert out["reason"] == "data_changed"
        assert out["current_sha256"] != frozen["input_sha256"]
        # 数据变了 ≠ 模板变了：这一例里版本没漂移，不能被混为一谈
        assert out["render_version_drift"] is False
        assert out["render_version_frozen"] == out["render_version_current"]

    def test_no_fingerprint_is_not_an_error(self):
        out = render_fingerprint_check(None, ASSEMBLED, checked_at=FROZEN_AT)

        assert out["has_fingerprint"] is False
        assert out["frozen"] is None
        assert out["matches"] is False          # 没有基线，谈不上"一致"
        assert out["reason"] == "no_fingerprint"
        # 其它字段如实给当前值（不是 null / 不是报错）
        assert out["current_sha256"] == render_input_digest(ASSEMBLED)
        assert out["render_version_frozen"] is None
        assert out["render_version_current"] == RENDER_VERSION
        assert out["current_note"] is None

    @pytest.mark.parametrize("frozen_payload", [
        {"_render": {"render_version": RENDER_VERSION, "input_sha256": None,
                     "frozen_at": FROZEN_AT, "note": "input_unavailable"}},
        {"sources": {}, "custom": {}},          # 根本没有 `_render`
        {"_render": "not-a-dict"},
    ])
    def test_unusable_frozen_never_reports_match(self, frozen_payload):
        frozen = read_render_fingerprint(frozen_payload)
        out = render_fingerprint_check(frozen, ASSEMBLED, checked_at=FROZEN_AT)

        assert out["matches"] is False
        assert out["reason"] in ("no_fingerprint", "frozen_unavailable")
        if out["reason"] == "frozen_unavailable":
            assert out["frozen_note"] == "input_unavailable"

    def test_current_assembly_failure_never_reports_match(self):
        frozen = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)

        out = render_fingerprint_check(
            frozen, None, checked_at=FROZEN_AT, current_error="RuntimeError")

        assert out["has_fingerprint"] is True          # 有基线
        assert out["current_sha256"] is None           # 但这次算不出来
        assert out["matches"] is False                 # **绝不**假匹配
        assert out["reason"] == "current_unavailable"
        assert out["current_note"] == "RuntimeError"   # 明确标出为什么比不了
        assert out["frozen"] == frozen

    def test_version_drift_is_reported_separately_from_data_change(self):
        frozen = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)

        # 数据一模一样，只是渲染器/模板版本不同 ⇒ 内容一致，但重出会不一样
        out = render_fingerprint_check(
            frozen, _copy(), current_version=RENDER_VERSION + 2, checked_at=FROZEN_AT)

        assert out["matches"] is True                  # 数据确实一致
        assert out["reason"] == "version_drift"
        assert out["render_version_drift"] is True
        assert out["render_version_frozen"] == RENDER_VERSION
        assert out["render_version_current"] == RENDER_VERSION + 2

        # 两者同时发生时，"数据被改"优先报（版本漂移不掩盖内容变化）
        both = render_fingerprint_check(
            frozen, _copy(total_amount=1.0), current_version=RENDER_VERSION + 2,
            checked_at=FROZEN_AT)
        assert both["reason"] == "data_changed"
        assert both["render_version_drift"] is True

    def test_response_contract_is_stable(self):
        """字段即两端契约：多一个少一个都会让前端解析错（route-parity 只查路由，查不了体）。"""
        out = render_fingerprint_check(None, ASSEMBLED, checked_at=FROZEN_AT)
        assert set(out) == {
            "has_fingerprint", "frozen", "current_sha256", "matches",
            "render_version_frozen", "render_version_current", "render_version_drift",
            "reason", "checked_at", "current_note", "frozen_note",
        }
        assert out["reason"] in RENDER_CHECK_VERDICTS

    def test_accepts_raw_payload_string(self):
        """`raw_payload` 可能是未解码的 JSON 文本（老数据/异常路径）—— 对账不能因此挂掉。"""
        import json
        payload = json.dumps({RENDER_KEY: render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)})
        frozen = read_render_fingerprint(payload)
        assert render_fingerprint_check(frozen, ASSEMBLED)["matches"] is True


# ── 端点壳（只读，不碰 DB：session 与装配都替换）─────────────────────────────

class _FakeResult:
    def __init__(self, doc):
        self._doc = doc

    def scalar_one_or_none(self):
        return self._doc


class _FakeSession:
    def __init__(self, doc):
        self._doc = doc

    async def execute(self, *args, **kwargs):
        return _FakeResult(self._doc)


def _auth():
    return types.SimpleNamespace(tenant_id="default", team_id=None, user_id=1)


def _doc_with(frozen_payload):
    return types.SimpleNamespace(raw_payload=frozen_payload)


class TestCheckEndpoint:
    async def test_reports_match_for_unchanged_document(self, monkeypatch):
        frozen = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
        doc = _doc_with({"sources": {}, "custom": {}, RENDER_KEY: frozen})

        async def _fake(doc_id, auth, db):
            return {"data": _copy()}

        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data", _fake)
        out = await trade_docs_api.check_trade_doc_render_fingerprint(
            doc_id=11, auth=_auth(), db=_FakeSession(doc))

        assert out["has_fingerprint"] is True
        assert out["matches"] is True
        assert out["reason"] == "matched"

    async def test_reports_change_when_data_moved(self, monkeypatch):
        """真的改一处被纳入摘要的数据（不是改 mock 的返回值形状）。"""
        frozen = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
        doc = _doc_with({RENDER_KEY: frozen})

        async def _fake(doc_id, auth, db):
            return {"data": _copy(total_amount=7777.0)}

        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data", _fake)
        out = await trade_docs_api.check_trade_doc_render_fingerprint(
            doc_id=11, auth=_auth(), db=_FakeSession(doc))

        assert out["matches"] is False
        assert out["reason"] == "data_changed"

    async def test_assembly_failure_is_flagged_not_hidden(self, monkeypatch):
        frozen = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
        doc = _doc_with({RENDER_KEY: frozen})

        async def _boom(doc_id, auth, db):
            raise RuntimeError("assembly exploded")

        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data", _boom)
        out = await trade_docs_api.check_trade_doc_render_fingerprint(
            doc_id=11, auth=_auth(), db=_FakeSession(doc))

        assert out["matches"] is False
        assert out["current_sha256"] is None
        assert out["reason"] == "current_unavailable"
        assert out["current_note"] == "RuntimeError"

    async def test_missing_document_is_404(self, monkeypatch):
        out = None
        try:
            out = await trade_docs_api.check_trade_doc_render_fingerprint(
                doc_id=999, auth=_auth(), db=_FakeSession(None))
        except HTTPException as exc:
            assert exc.status_code == 404
            assert exc.detail["code"] == "DOC_NOT_FOUND"
        assert out is None      # 不能"没这张单据"却返回一份报告
