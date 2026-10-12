"""批量对账（一次查出哪些单据被改过）—— **纯单测**（无 DB、无 HTTP）。

`pytestmark = unit`：判定与"计数口径"都在共享内核
`kaas_common/trade_doc/render_fingerprint.py`，两端端点只是壳；所以规则必须进 `-m unit` 门禁。

为什么批量值得单独钉一遍（它坏掉的方式全是**静默**的）
------------------------------------------------------
1. **假匹配**：某张装配失败却被算进 `matched` ⇒ 用户据此认定"这批没被改过"，
   而实际上根本没比过 —— 这是本功能最危险、也最难被发现的错法；
2. **桶漏一张**：`matched + data_changed + version_drift + no_fingerprint + unavailable`
   加起来不等于 `total` ⇒ 少掉的那张会被读成"没问题"；
3. **两端口径漂移**：一端把 `frozen_unavailable` 算进 `no_fingerprint`、另一端算进
   `unavailable` ⇒ 同一批数据两端给出不同的"结论分布"；
4. **一张炸了拖垮整批**：第 7 张抛异常 ⇒ 前 6 张的结论也拿不到；
5. **路径被动态路由吃掉**：`/trade-docs/{doc_id}` 会匹配 `render-fingerprint-checks`
   再在参数校验处 422（实测见本文件 `TestRouteRegistered`）。

同时钉住"没有真的定时调度"这件事的边界：本文件只覆盖**接口**，没有 scheduler/cron。
"""
from __future__ import annotations

import re
import types
from pathlib import Path

import pytest
from fastapi import HTTPException

from kaas_common.trade_doc import (
    RENDER_CHECK_CARD_FIELDS,
    RENDER_CHECK_CARD_UNAVAILABLE,
    RENDER_CHECK_DOC_IDS_INVALID,
    RENDER_CHECK_DOC_IDS_LIMIT,
    RENDER_CHECK_DOC_IDS_REQUIRED,
    RENDER_CHECK_MAX_DOCS,
    RENDER_CHECK_SUMMARY_FIELDS,
    RENDER_CHECK_VERDICTS,
    RENDER_KEY,
    RENDER_VERSION,
    RenderCheckBatchError,
    parse_render_check_doc_ids,
    render_check_card,
    render_fingerprint,
    summarize_render_checks,
)

from app.api import trade_docs as trade_docs_api

pytestmark = pytest.mark.unit

BATCH_PATH = "/api/v1/trade-docs/render-fingerprint-checks/batch"
FROZEN_AT = "2026-10-12T09:00:00+00:00"

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
    """有 `_render` 的 raw_payload；`meta_overrides` 用来造版本漂移 / 冻结时就没摘要。"""
    meta = render_fingerprint(ASSEMBLED, frozen_at=FROZEN_AT)
    meta.update(meta_overrides)
    return {"sources": {}, "custom": {}, RENDER_KEY: meta}


def _auth():
    return types.SimpleNamespace(tenant_id="default", team_id=None, user_id=1)


def _doc(doc_id, payload, doc_no=None):
    return types.SimpleNamespace(id=doc_id, doc_no=doc_no or f"PI-202610-{doc_id:04d}",
                                 raw_payload=payload)


# ── 取数壳替身 ──────────────────────────────────────────────────────────────

class _FakeScalars:
    def __init__(self, items):
        self._items = list(items)

    def all(self):
        return list(self._items)

    def first(self):
        return self._items[0] if self._items else None


class _FakeResult:
    def __init__(self, items):
        self._items = list(items)

    def scalars(self):
        return _FakeScalars(self._items)

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None


class _FakeSession:
    """只实现 `execute`（批量端点一次 IN 查询；单张端点一次 select）。

    `docs` 就是"这一步查到的单据行" —— 想造"单据不存在"就少给一张。
    """

    def __init__(self, docs=()):
        self._docs = list(docs)
        self.sql: list[str] = []

    async def execute(self, stmt, params=None):
        try:
            self.sql.append(str(stmt.compile(compile_kwargs={"literal_binds": True})))
        except Exception:                       # pragma: no cover - 兜底不掩盖断言
            self.sql.append(str(stmt))
        return _FakeResult(self._docs)


async def _call(doc_ids, docs=(), assembly=None, monkeypatch=None):
    if assembly is not None:
        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data", assembly)
    return await trade_docs_api.batch_check_trade_doc_render_fingerprints(
        doc_ids=doc_ids, auth=_auth(), db=_FakeSession(docs))


def _assembly_by_id(mapping):
    """`{doc_id: data|Exception}` → 装配替身。"""
    async def _fake(doc_id, auth, db):
        value = mapping[doc_id]
        if isinstance(value, Exception):
            raise value
        return {"data": value}

    return _fake


# ── 内核：入参校验（纯函数）─────────────────────────────────────────────────

class TestParseDocIds:
    def test_comma_string(self):
        assert parse_render_check_doc_ids("1,2,3") == [1, 2, 3]

    def test_whitespace_and_blank_tokens_are_tolerated(self):
        assert parse_render_check_doc_ids(" 1 , ,2 ,") == [1, 2]

    def test_accepts_sequence(self):
        assert parse_render_check_doc_ids([3, "4"]) == [3, 4]

    def test_duplicates_are_deduped_preserving_order(self):
        """同一张只装配一次（省一半成本），卡片顺序仍按请求顺序。"""
        assert parse_render_check_doc_ids("2,1,2,1,3") == [2, 1, 3]

    @pytest.mark.parametrize("raw", [None, "", "   ", ",", ",,", " , "])
    def test_empty_is_an_error(self, raw):
        with pytest.raises(RenderCheckBatchError) as ei:
            parse_render_check_doc_ids(raw)
        assert ei.value.code == RENDER_CHECK_DOC_IDS_REQUIRED

    @pytest.mark.parametrize("raw", ["1,abc", "1;2", "PI-1", "1,2.5"])
    def test_non_integer_is_an_error(self, raw):
        """不猜、不静默跳过 —— 跳过会让"少对了几张"无声发生。"""
        with pytest.raises(RenderCheckBatchError) as ei:
            parse_render_check_doc_ids(raw)
        assert ei.value.code == RENDER_CHECK_DOC_IDS_INVALID

    def test_limit_boundary_is_inclusive(self):
        assert len(parse_render_check_doc_ids(list(range(1, RENDER_CHECK_MAX_DOCS + 1)))) \
            == RENDER_CHECK_MAX_DOCS

    def test_over_limit_is_an_error(self):
        with pytest.raises(RenderCheckBatchError) as ei:
            parse_render_check_doc_ids(list(range(1, RENDER_CHECK_MAX_DOCS + 2)))
        assert ei.value.code == RENDER_CHECK_DOC_IDS_LIMIT
        assert str(RENDER_CHECK_MAX_DOCS) in ei.value.detail

    def test_limit_counts_unique_ids_only(self):
        """重复 id 不占额度（去重后才判上限）。"""
        raw = ",".join(["1"] * (RENDER_CHECK_MAX_DOCS + 20))
        assert parse_render_check_doc_ids(raw) == [1]


# ── 内核：卡片与汇总（纯函数）───────────────────────────────────────────────

class TestCardAndSummary:
    def test_card_from_check_keeps_verdict(self):
        card = render_check_card(7, "PI-1", {"reason": "data_changed", "matches": False,
                                            "render_version_drift": True})
        assert card == {"doc_id": 7, "doc_no": "PI-1", "reason": "data_changed",
                        "matches": False, "render_version_drift": True, "error": None}
        assert tuple(card) == RENDER_CHECK_CARD_FIELDS

    def test_card_without_check_is_unavailable_never_matched(self):
        card = render_check_card(7, "PI-1", None, error="DOC_NOT_FOUND")
        assert card["reason"] == RENDER_CHECK_CARD_UNAVAILABLE
        assert card["matches"] is False
        assert card["render_version_drift"] is False
        assert card["error"] == "DOC_NOT_FOUND"
        assert RENDER_CHECK_CARD_UNAVAILABLE not in RENDER_CHECK_VERDICTS

    def test_summary_covers_every_card(self):
        items = [
            render_check_card(1, "A", {"reason": "matched", "matches": True}),
            render_check_card(2, "B", {"reason": "data_changed", "matches": False}),
            render_check_card(3, "C", {"reason": "version_drift", "matches": True}),
            render_check_card(4, "D", {"reason": "no_fingerprint", "matches": False}),
            render_check_card(5, "E", {"reason": "frozen_unavailable", "matches": False}),
            render_check_card(6, "F", {"reason": "current_unavailable", "matches": False}),
            render_check_card(7, error="DOC_NOT_FOUND"),
            render_check_card(8, "H", error="RuntimeError"),
        ]
        out = summarize_render_checks(items)
        assert tuple(out) == RENDER_CHECK_SUMMARY_FIELDS
        assert out["total"] == 8
        assert out["matched"] == 1
        assert out["data_changed"] == 1
        assert out["version_drift"] == 1
        assert out["no_fingerprint"] == 1
        # 所有"比不了"的情形都进 unavailable（含内核的两个 *_unavailable）
        assert out["unavailable"] == 4
        assert (out["matched"] + out["data_changed"] + out["version_drift"]
                + out["no_fingerprint"] + out["unavailable"]) == out["total"]

    def test_summary_of_empty_is_all_zero(self):
        assert summarize_render_checks([]) == {k: 0 for k in RENDER_CHECK_SUMMARY_FIELDS}

    def test_summary_ignores_non_card_entries(self):
        """防御：将来有人往 items 里塞了非 dict，也不能把计数弄错。"""
        out = summarize_render_checks([None, "x", render_check_card(1, "A",
                                                                     {"reason": "matched"})])
        assert out["total"] == 1 and out["matched"] == 1


# ── 端点：正常批量 / 混合 reason ────────────────────────────────────────────

class TestBatchEndpointHappyPath:
    async def test_mixed_reasons_and_summary(self, monkeypatch):
        docs = [
            _doc(1, _payload(), "PI-1"),                                   # matched
            _doc(2, _payload(), "PI-2"),                                   # data_changed
            _doc(3, _payload(render_version=RENDER_VERSION - 1), "PI-3"),  # version_drift
            _doc(4, {"sources": {}, "custom": {}}, "PI-4"),                # no_fingerprint
        ]
        assembly = _assembly_by_id({
            1: _copy(),
            2: _copy(total_amount=7777.0),
            3: _copy(),
            4: _copy(),
        })
        out = await _call("1,2,3,4", docs, assembly, monkeypatch)

        assert [it["doc_id"] for it in out["items"]] == [1, 2, 3, 4]
        assert [it["doc_no"] for it in out["items"]] == ["PI-1", "PI-2", "PI-3", "PI-4"]
        assert [it["reason"] for it in out["items"]] == [
            "matched", "data_changed", "version_drift", "no_fingerprint"]
        assert [it["render_version_drift"] for it in out["items"]] == [False, False, True, False]
        assert out["total"] == 4
        assert out["matched"] == 1 and out["data_changed"] == 1
        assert out["version_drift"] == 1 and out["no_fingerprint"] == 1
        assert out["unavailable"] == 0

    async def test_matches_only_ever_means_content_identical(self, monkeypatch):
        """不变式：`matches=true` 只能来自内核的 matched / version_drift（数据确实一致）。"""
        docs = [_doc(1, _payload(), "PI-1"), _doc(2, _payload(), "PI-2"),
                _doc(3, _payload(), "PI-3"), _doc(4, _payload(), "PI-4")]
        assembly = _assembly_by_id({
            1: _copy(), 2: _copy(total_amount=1.0),
            3: RuntimeError("boom"), 4: _copy(),
        })
        out = await _call("1,2,3,4", docs, assembly, monkeypatch)
        for card in out["items"]:
            if card["matches"]:
                assert card["reason"] in ("matched", "version_drift"), card
        by_id = {c["doc_id"]: c for c in out["items"]}
        assert by_id[3]["reason"] == "current_unavailable"
        assert by_id[3]["matches"] is False          # 装配炸了绝不假报一致
        assert by_id[2]["reason"] == "data_changed"
        assert out["matched"] == 2                   # 1 与 4 真的一致；2 被改、3 比不了
        assert out["unavailable"] == 1

    async def test_query_is_tenant_scoped_and_single(self, monkeypatch):
        """一次 IN 查询取本批（省 N-1 次），且必须带租户过滤。"""
        db = _FakeSession([_doc(1, _payload(), "PI-1")])
        monkeypatch.setattr(trade_docs_api, "get_trade_doc_render_data",
                            _assembly_by_id({1: _copy()}))
        out = await trade_docs_api.batch_check_trade_doc_render_fingerprints(
            doc_ids="1,2", auth=_auth(), db=db)
        assert len(db.sql) == 1
        assert "trade_docs" in db.sql[0] and "tenant_id" in db.sql[0]
        assert out["total"] == 2                     # 2 号没查到 → 一张卡


# ── 端点：一张炸了，其余照交付 ──────────────────────────────────────────────

class TestBatchResilience:
    async def test_one_card_explodes_others_still_delivered(self, monkeypatch):
        docs = [_doc(i, _payload(), f"PI-{i}") for i in (1, 2, 3)]
        real = trade_docs_api._check_one_doc_render_fingerprint

        async def _flaky(d, doc_id, auth, db):
            if doc_id == 2:
                raise RuntimeError("card exploded")
            return await real(d, doc_id, auth, db)

        monkeypatch.setattr(trade_docs_api, "_check_one_doc_render_fingerprint", _flaky)
        assembly = _assembly_by_id({1: _copy(), 2: _copy(), 3: _copy()})
        out = await _call("1,2,3", docs, assembly, monkeypatch)

        by_id = {c["doc_id"]: c for c in out["items"]}
        assert by_id[2]["reason"] == RENDER_CHECK_CARD_UNAVAILABLE
        assert by_id[2]["error"] == "RuntimeError"
        assert by_id[2]["matches"] is False
        assert by_id[2]["doc_no"] == "PI-2"          # 卡片仍带上可读的 doc_no
        assert by_id[1]["reason"] == "matched" and by_id[3]["reason"] == "matched"
        assert out["matched"] == 2 and out["unavailable"] == 1 and out["total"] == 3

    async def test_missing_document_is_a_card_not_a_batch_404(self, monkeypatch):
        docs = [_doc(1, _payload(), "PI-1")]         # 请求了 1 和 2，只查到 1
        out = await _call("1,2", docs, _assembly_by_id({1: _copy()}), monkeypatch)

        by_id = {c["doc_id"]: c for c in out["items"]}
        assert by_id[1]["reason"] == "matched"
        assert by_id[2]["reason"] == RENDER_CHECK_CARD_UNAVAILABLE
        assert by_id[2]["error"] == "DOC_NOT_FOUND"
        assert by_id[2]["doc_no"] is None
        assert by_id[2]["matches"] is False
        assert out["unavailable"] == 1 and out["matched"] == 1

    async def test_frozen_without_digest_never_counts_as_matched(self, monkeypatch):
        docs = [_doc(1, _payload(input_sha256=None, note="input_unavailable"), "PI-1")]
        out = await _call("1", docs, _assembly_by_id({1: _copy()}), monkeypatch)
        card = out["items"][0]
        assert card["reason"] == "frozen_unavailable"
        assert card["matches"] is False
        assert out["matched"] == 0 and out["unavailable"] == 1

    async def test_duplicate_ids_assemble_once(self, monkeypatch):
        calls = []

        async def _assembly(doc_id, auth, db):
            calls.append(doc_id)
            return {"data": _copy()}

        out = await _call("1,1,1", [_doc(1, _payload(), "PI-1")], _assembly, monkeypatch)
        assert calls == [1]                          # 去重后只装配一次
        assert out["total"] == 1 and out["matched"] == 1


# ── 端点：入参 400（且不碰库）──────────────────────────────────────────────

class TestBatchValidation:
    @pytest.mark.parametrize("raw", [None, "", "   ", ",,"])
    async def test_empty_doc_ids_is_400(self, raw, monkeypatch):
        db = _FakeSession()
        with pytest.raises(HTTPException) as ei:
            await trade_docs_api.batch_check_trade_doc_render_fingerprints(
                doc_ids=raw, auth=_auth(), db=db)
        assert ei.value.status_code == 400
        assert ei.value.detail["code"] == RENDER_CHECK_DOC_IDS_REQUIRED
        assert db.sql == []                          # 入参不合法不查库

    async def test_invalid_token_is_400(self):
        db = _FakeSession()
        with pytest.raises(HTTPException) as ei:
            await trade_docs_api.batch_check_trade_doc_render_fingerprints(
                doc_ids="1,abc", auth=_auth(), db=db)
        assert ei.value.status_code == 400
        assert ei.value.detail["code"] == RENDER_CHECK_DOC_IDS_INVALID
        assert db.sql == []

    async def test_over_limit_is_400_and_says_why(self):
        db = _FakeSession()
        with pytest.raises(HTTPException) as ei:
            await trade_docs_api.batch_check_trade_doc_render_fingerprints(
                doc_ids=list(range(1, RENDER_CHECK_MAX_DOCS + 2)), auth=_auth(), db=db)
        assert ei.value.status_code == 400
        assert ei.value.detail["code"] == RENDER_CHECK_DOC_IDS_LIMIT
        assert str(RENDER_CHECK_MAX_DOCS) in ei.value.detail["detail"]
        assert db.sql == []

    async def test_at_limit_is_accepted(self):
        """上限本身是允许的（50 张）—— 只是没有这些单据，逐张记 unavailable。"""
        out = await trade_docs_api.batch_check_trade_doc_render_fingerprints(
            doc_ids=list(range(1, RENDER_CHECK_MAX_DOCS + 1)), auth=_auth(),
            db=_FakeSession())
        assert out["total"] == RENDER_CHECK_MAX_DOCS
        assert out["unavailable"] == RENDER_CHECK_MAX_DOCS
        assert out["matched"] == 0


# ── 路由与两端一致性 ────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parents[3]
ORCH_SRC = ROOT / "backend" / "orchestrator" / "app" / "api" / "trade_docs.py"
WORKER_SRC = ROOT / "backend" / "worker" / "src" / "ws_docs_ext.py"


class TestRouteRegistered:
    def test_batch_route_is_registered_and_not_shadowed(self):
        """路由必须真的注册上，且**首个 FULL 匹配就是它**。

        为什么单列这条：`/trade-docs/{doc_id}` 的路径正则是不带 int 转换器的 `[^/]+`
        ⇒ 请求会被它先匹配、再在参数校验处 422。批量端点用 3 段静态路径正是为了
        避开它（见端点上方注释）；这条测试钉住"没被吃掉"。
        """
        from starlette.routing import Match

        scope = {"type": "http", "path": BATCH_PATH, "method": "GET", "headers": []}
        first = None
        for route in trade_docs_api.router.routes:
            try:
                match, _ = route.matches(scope)
            except Exception:                        # pragma: no cover
                continue
            if match == Match.FULL:
                first = getattr(route, "path", None)
                break
        assert first == BATCH_PATH, f"批量路由被其它路由吃掉了：{first!r}"


class TestTwoEndConsistency:
    """`route-parity` 只对比路由字面量；这里再钉一层"契约同源"。"""

    def test_same_path_and_method_on_both_ends(self):
        # orchestrator 的 router 带 prefix="/api/v1"，所以源码里的字面量是相对路径
        orch_literal = BATCH_PATH[len("/api/v1"):]
        orch = ORCH_SRC.read_text(encoding="utf-8")
        worker = WORKER_SRC.read_text(encoding="utf-8")
        assert f'@router.get("{orch_literal}"' in orch
        assert f'@app.get("{BATCH_PATH}"' in worker

    def test_both_ends_use_the_kernel_contract(self):
        """两端都必须用内核的校验/卡片/汇总（**不各写一份计数口径**，G1）。"""
        for src in (ORCH_SRC, WORKER_SRC):
            text = src.read_text(encoding="utf-8")
            for name in ("parse_render_check_doc_ids", "render_check_card",
                         "summarize_render_checks", "RenderCheckBatchError"):
                assert name in text, f"{src.name} 没有用内核的 {name}"

    def test_both_ends_declare_the_heavy_operation_warning(self):
        """成本控制不是"性能调优"而是**误用防线**：两端都要写明不要挂高频路径。"""
        for src in (ORCH_SRC, WORKER_SRC):
            text = src.read_text(encoding="utf-8")
            assert re.search(r"重操作.*不要挂(到)?高频路径|不要挂(到)?高频路径", text), src.name

    def test_no_scheduler_in_scope(self):
        """如实钉边界：这次只做**接口**，没有定时调度（没有 APScheduler/crontab 接线）。"""
        for src in (ORCH_SRC, WORKER_SRC):
            text = src.read_text(encoding="utf-8")
            for banned in ("APScheduler", "BackgroundScheduler", "crontab"):
                assert banned not in text, f"{src.name} 出现了调度器痕迹：{banned}"
