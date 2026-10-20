"""A7 一致性引擎（`kaas_common.trade_doc.consistency`）内核测试 —— 纯函数，无 DB / 无网络。

覆盖 `TRADE_DOC_HARDENING_PLAN_2026-10-12.md` §4-B 与 §8 验收断言 1、3，以及等价词表本身：

1. **一致性**（§8-1）：删掉 CI 的 Incoterms 版本 ⇒ `FACT_CONFLICT(incoterm)`；
   SC 把 `upon dispatch` 改成 `before dispatch`（不在词表）⇒ 冲突；
   改成 `upon dispatch (before delivery)`（在词表）⇒ 不冲突；
2. **不可改写**（§8-3）：基线 PI 的 `payment_deposit_ratio=0.30` 在派生 SC 上改成 0.5
   ⇒ `FACT_IMMUTABLE`，并给出原值/新值（`lint_pair` 的承继核对同口径）；
3. **绝不静默吞差异**：词表外的措辞差异、汇率尾差、金额超容差一律进冲突清单；
   口径内的差异（等价措辞、金额容差内）**不消失**，而是进 ⚠ 分组（`status="equivalent"`）；
4. **边界**：空输入、不足两份单证、身份事实（单号/日期）不参与跨单证比较。

为什么这些断言值得钉住：工位原有一致性校验只到"单证内、字段级"，
跨单证的事实漂移（版本被删、时点被改述、条款被覆盖）没有任何防线，
而信用证审单恰恰是按字面看这几项。
"""
from __future__ import annotations

import copy
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import pytest

from kaas_common.trade_doc.consistency import (
    IDENTITY_KEYS,
    FactCheck,
    FactDiff,
    diff_facts,
    equivalent,
    lint_pair,
)
from kaas_common.trade_doc.facts import (
    FACT_CONFLICT,
    FACT_EQUIVALENT_WORDING,
    FACT_IMMUTABLE,
    FACT_MISSING,
    SOURCE_PI,
    TRUST_CONFIRMED,
    Fact,
    extract_facts,
)
from kaas_common.trade_doc.rules import ItemCheck

pytestmark = pytest.mark.unit


# ─── 夹具：与 worker order_snapshot 同形的上游快照 ─────────────────────────
ORDER_SNAPSHOT = {
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
    "items": [
        {"product_name": "立柱", "qty": 400, "unit_price": 3.7297, "line_amount": 1491.88},
        {"product_name": "绝缘子", "qty": 400, "unit_price": 0.3252, "line_amount": 130.08},
    ],
}


def payload_with(**override) -> dict:
    order = copy.deepcopy(ORDER_SNAPSHOT)
    order.update(override)
    # PI 自己的单号落在 custom（与落库形状一致：单号是 trade_docs 行字段，
    # 派生时冻进 raw_payload.custom）
    return {"sources": {"order": order}, "custom": {"pi_no": "LJ-PI-20260929-01"}}


def facts_of(doc_type: str, **override):
    return extract_facts(payload_with(**override), doc_type)


def by_key(facts) -> dict[str, Fact]:
    return {fact.key: fact for fact in facts}


# ─── 1. §8 断言 1：Incoterms 版本被删 ⇒ FACT_CONFLICT(incoterm) ─────────────

def test_missing_incoterms_version_is_conflict():
    pi = facts_of("pi")
    ci = facts_of("ci", incoterm="DAP Yangzhou, Jiangsu, China")   # 版本被删掉
    diffs = diff_facts({"pi": pi, "ci": ci}, root="pi")

    assert len(diffs) == 1, [diff.key for diff in diffs]
    diff = diffs[0]
    assert diff.key == "incoterm"
    assert diff.status == "conflict"
    assert diff.code == FACT_CONFLICT
    assert diff.baseline_doc == "pi"
    assert diff.baseline_value == "DAP Yangzhou, Jiangsu, China (Incoterms 2020)"
    assert set(diff.values) == {"pi", "ci"}
    assert "Incoterms 2020" in diff.values["pi"]
    assert "Incoterms 2020" not in diff.values["ci"]
    assert "以基线 pi 为准" in diff.detail_zh


def test_same_incoterm_but_extra_place_suffix_is_equivalent_not_conflict():
    """`DAP Yangzhou` ↔ `DAP Yangzhou, Jiangsu, China` 属同类归一（地点逐段前缀）。"""
    pi = facts_of("pi", incoterm="DAP Yangzhou, Jiangsu, China")
    ci = facts_of("ci", incoterm="DAP Yangzhou")
    diffs = diff_facts({"pi": pi, "ci": ci}, root="pi")
    assert [(diff.key, diff.status) for diff in diffs] == [("incoterm", "equivalent")]
    assert diffs[0].code == FACT_EQUIVALENT_WORDING


# ─── 2. §8 断言 1：付款时点"改述"的三种情形 ────────────────────────────────

def test_payment_timing_reworded_outside_table_is_conflict():
    """`upon dispatch` → `before dispatch`：限定语不同，词表判定为**不等价**。"""
    pi = facts_of("pi", payment_terms="70% balance upon dispatch")
    sc = facts_of("contract", payment_terms="70% balance before dispatch")
    diffs = {diff.key: diff for diff in diff_facts({"pi": pi, "sc": sc}, root="pi")}

    assert diffs["payment_balance_timing"].status == "conflict"
    assert diffs["payment_balance_timing"].baseline_value == "upon_dispatch"
    assert diffs["payment_balance_timing"].values["sc"] == "upon_dispatch_before_delivery"
    assert diffs["payment_terms"].status == "conflict"


def test_payment_timing_reworded_inside_table_is_not_conflict():
    """`before dispatch` → `upon dispatch (before delivery)`：词表内等价，不算冲突。"""
    pi = facts_of("pi", payment_terms="70% balance before dispatch")
    sc = facts_of("contract",
                  payment_terms="70% balance upon dispatch (before delivery)")
    diffs = diff_facts({"pi": pi, "sc": sc}, root="pi")

    # 一条冲突都不许有；措辞差异以 equivalent 上报（可见，但不阻断）
    assert [diff.key for diff in diffs if diff.status == "conflict"] == []
    statuses = {diff.key: diff.status for diff in diffs}
    assert statuses.get("payment_terms") == "equivalent"
    assert "payment_balance_timing" not in statuses   # 结构化成同一枚举值


def test_payment_ratio_change_is_conflict_between_docs():
    pi = facts_of("pi")
    sc = facts_of("contract",
                  payment_terms="50% deposit upon order confirmation, 50% balance before dispatch")
    diffs = {diff.key: diff for diff in diff_facts({"pi": pi, "sc": sc}, root="pi")}
    assert diffs["payment_deposit_ratio"].status == "conflict"
    assert diffs["payment_deposit_ratio"].values == {"pi": "0.3", "sc": "0.5"}
    assert diffs["payment_balance_ratio"].values == {"pi": "0.7", "sc": "0.5"}


# ─── 3. 金额容差 / 汇率精确 ────────────────────────────────────────────────

def test_amount_within_tolerance_is_equivalent_not_conflict():
    pi = facts_of("pi", total_amount=847.95)
    ci = facts_of("ci", total_amount=847.93)      # 银行手续费/汇率尾差量级
    diffs = diff_facts({"pi": pi, "ci": ci}, root="pi")
    assert [(diff.key, diff.status) for diff in diffs] == [("total_amount", "equivalent")]
    assert "容差" in diffs[0].detail_zh


def test_amount_beyond_tolerance_is_conflict_with_tolerance_amount():
    pi = facts_of("pi")
    ci = facts_of("ci", total_amount=2900)
    diff = [d for d in diff_facts({"pi": pi, "ci": ci}, root="pi")
            if d.key == "total_amount"][0]
    assert diff.status == "conflict"
    assert diff.kind == "money"
    # 容差 = max(5 美分等值, 0.1%)，2900 的 0.1% = 2.9 ⇒ 报出来的是这把尺子
    assert diff.tolerance == "2.9"
    assert diff.diff_amount == "73.51"


def test_fx_rate_must_match_exactly():
    pi = facts_of("pi")
    ci = facts_of("ci", fx_rate=6.7030)
    diffs = diff_facts({"pi": pi, "ci": ci}, root="pi")
    assert [diff.key for diff in diffs] == ["fx_rate"]
    assert diffs[0].status == "conflict"


def test_hand_copied_unit_price_is_conflict():
    """§3-#3：单价抄错一位（0.3252 → 0.3253）不能被容差吞掉。"""
    pi = facts_of("pi")
    items = copy.deepcopy(ORDER_SNAPSHOT["items"])
    items[1]["unit_price"] = 0.3253          # 第 2 行（绝缘子）单价被抄错
    ci = facts_of("ci", items=items)
    diffs = diff_facts({"pi": pi, "ci": ci}, root="pi")
    assert [(diff.key, diff.status) for diff in diffs] == [("unit_price[2]", "conflict")]


# ─── 4. diff_facts 的边界与口径 ────────────────────────────────────────────

def test_diff_facts_ignores_document_identity_facts():
    """单号/日期是每张单证自己的标识：CI 的发票号 ≠ PI 的 PI 号，不算冲突。"""
    pi = facts_of("pi")
    ci = extract_facts({**payload_with(), "custom": {"invoice_no": "LJ-CI-20261012-01"}}, "ci")
    assert by_key(pi)["doc_no"].value != by_key(ci)["doc_no"].value
    assert IDENTITY_KEYS == frozenset({"doc_no", "date"})
    assert [diff.key for diff in diff_facts({"pi": pi, "ci": ci}, root="pi")] == []
    # 显式要求时仍然可以比（审计/排查用）
    identity = diff_facts({"pi": pi, "ci": ci}, root="pi", include_identity=True)
    assert "doc_no" in {diff.key for diff in identity}


def test_diff_facts_empty_and_single_doc():
    assert diff_facts({}, "order") == []
    assert diff_facts({"pi": facts_of("pi")}, root="pi") == []
    assert diff_facts(None, "order") == []


def test_diff_facts_baseline_selection_and_domain():
    pi = facts_of("pi")
    ci = facts_of("ci", total_amount=2900)
    # ① root 命中 doc_facts 键 ⇒ 它就是基线
    diff = diff_facts({"ci": ci, "pi": pi}, root="pi")[0]
    assert diff.baseline_doc == "pi"
    assert diff.domain == "pi"
    # ② root 只是交易域名（不在键里）⇒ 基线取第一份（插入序），域名原样记录
    diff = diff_facts({"ci": ci, "pi": pi}, root="order")[0]
    assert diff.baseline_doc == "ci"
    assert diff.domain == "order"


def test_diff_facts_is_deterministic_and_json_friendly():
    pi = facts_of("pi")
    ci = facts_of("ci", total_amount=2900, incoterm="FOB Shanghai", fx_rate=6.8)
    diffs = diff_facts({"pi": pi, "ci": ci}, root="pi")
    keys = [diff.key for diff in diffs]
    assert keys == sorted(keys)                       # 顺序稳定（快照测试/前端渲染依赖）
    assert [diff.key for diff in diff_facts({"ci": ci, "pi": pi}, root="pi")] == keys
    payload = diffs[0].as_dict()
    assert payload["code"] and payload["status"] and payload["key"]
    assert isinstance(payload["values"], dict)


def test_diff_facts_check_missing_is_opt_in():
    pi = facts_of("pi")
    bare = extract_facts({"custom": {"invoice_no": "LJ-CI-1"}}, "ci")
    assert diff_facts({"pi": pi, "ci": bare}, root="pi") == []
    missing = diff_facts({"pi": pi, "ci": bare}, root="pi", check_missing=True)
    assert missing and all(diff.status == "missing" for diff in missing)
    assert "ci" in missing[0].detail_zh


# ─── 5. §8 断言 3：不可改写（派生单改定金比例）─────────────────────────────

def test_lint_pair_flags_rewritten_payment_ratio():
    pi = facts_of("pi")
    sc = facts_of("contract",
                  payment_terms="50% deposit upon order confirmation, 50% balance before dispatch")
    checks = lint_pair(pi, sc)
    failing = {check.key: check for check in checks if not check.ok}

    assert "payment_deposit_ratio" in failing
    ratio_check = failing["payment_deposit_ratio"]
    assert isinstance(ratio_check, ItemCheck)          # 复用 rules.ItemCheck 的形状
    assert isinstance(ratio_check, FactCheck)
    assert ratio_check.status == "immutable"
    assert ratio_check.original == "0.3"
    assert ratio_check.provided == "0.5"
    assert FACT_IMMUTABLE in ratio_check.issues[0]
    assert "原值引用" in ratio_check.issues[0]


def test_lint_pair_clean_pair_is_all_ok():
    pi = facts_of("pi")
    sc = facts_of("contract",
                  payment_terms="30% deposit upon confirmation of the order, "
                                "70% balance upon dispatch (before delivery)")
    checks = lint_pair(pi, sc)
    assert checks, "应当逐条给出核对结果（对应原型脚本的 OK/MISS 矩阵）"
    assert all(check.ok for check in checks)
    # 措辞不同但词表内等价的项标记为 equivalent（可见，不阻断）
    assert any(check.status == "equivalent" for check in checks)
    # 派生单新增的事实（这里没有）不产生条目；基线每条不可改写事实都应被核到
    assert {check.key for check in checks} >= {"incoterm", "payment_deposit_ratio"}


def test_lint_pair_reports_missing_immutable_facts():
    pi = facts_of("pi")
    bare = extract_facts({"custom": {"invoice_no": "LJ-CI-1"}}, "ci")
    checks = lint_pair(pi, bare)
    missing = [check for check in checks if check.status == "missing"]
    assert missing
    assert all(not check.ok and FACT_MISSING in check.issues[0] for check in missing)
    assert "incoterm" in {check.key for check in missing}
    # 关掉缺失检查后只剩"值不一致"那一类
    assert all(check.ok for check in lint_pair(pi, bare, check_missing=False))


def test_lint_pair_ignores_identity_and_new_facts():
    pi = facts_of("pi")
    ci = extract_facts({**payload_with(), "custom": {"invoice_no": "LJ-CI-20261012-01"}}, "ci")
    checks = lint_pair(pi, ci)
    assert all(check.ok for check in checks)
    # 自身单号是身份事实，不进承继核对（否则每对单证都假冲突）
    assert "doc_no" not in {check.key for check in checks}
    # 派生单新增的事实（发票号）本来就不是"承继"，不产生条目
    assert by_key(ci)["doc_no"].value not in {check.provided for check in checks}


def test_lint_pair_empty_inputs():
    assert lint_pair([], []) == []
    assert lint_pair(facts_of("pi"), []) != []      # 基线有不可改写事实 ⇒ 报缺失
    assert lint_pair([], facts_of("ci")) == []


def test_fact_check_is_json_friendly():
    pi = facts_of("pi")
    sc = facts_of("contract", total_amount=2900)
    check = [item for item in lint_pair(pi, sc) if not item.ok][0]
    payload = check.as_dict()
    assert payload["key"] == "total_amount"
    assert payload["status"] == "conflict"
    assert payload["original"] == "2826.49" and payload["provided"] == "2900"
    assert payload["issues"]


# ─── 6. `equivalent()`：词表 + 租户增量的边界 ──────────────────────────────

def test_equivalent_normalizes_case_space_and_punctuation():
    assert equivalent("DAP  Yangzhou ,  Jiangsu", "dap yangzhou,jiangsu") is True
    assert equivalent("ＰＡＩＤ　ＢＹ　ＢＵＹＥＲ", "paid by buyer") is True
    assert equivalent("30% deposit", "30 % deposit") is True
    assert equivalent("N/M", "n/m") is True


def test_equivalent_only_inside_word_table():
    """词表外的措辞一律不等价 —— 这是"绝不静默吞差异"的底线。"""
    assert equivalent("before dispatch", "upon dispatch (before delivery)") is True
    assert equivalent("upon dispatch", "before dispatch") is False
    assert equivalent("upon order confirmation", "upon confirmation of the order") is True
    assert equivalent("DAP Yangzhou, Jiangsu, China (Incoterms 2020)",
                      "DAP Yangzhou, Jiangsu, China") is False       # 版本不同
    # 看着很像但没进表 ⇒ False（不允许模糊匹配）
    assert equivalent("before shipment", "before dispatch") is False


def test_equivalent_structural_normalizations():
    # Incoterms：地点逐段前缀
    assert equivalent("DAP Yangzhou", "DAP Yangzhou, Jiangsu, China") is True
    assert equivalent("DAP Yangzhou, Jiangsu", "DAP Yangzhou, Anhui") is False
    # 金额：数字 / 英文大写 / 中文大写
    assert equivalent("USD 2,826.49",
                      "SAY US DOLLARS TWO THOUSAND EIGHT HUNDRED AND TWENTY SIX "
                      "AND CENTS FORTY NINE ONLY") is True
    assert equivalent("USD 2,826.49", "美元贰仟捌佰贰拾陆元肆角玖分") is True
    assert equivalent("USD 2,826.49", "人民币贰仟捌佰贰拾陆元肆角玖分") is False  # 币种不同
    # 日期格式变体
    assert equivalent("2026-10-12", "12 Oct 2026") is True
    assert equivalent("2026-10-12", "October 12, 2026") is True
    assert equivalent("2026-10-12", "2026年10月12日") is True
    assert equivalent("2026-10-12", "2026-10-13") is False


def test_equivalent_tenant_extra_table_is_parameter_not_database():
    """租户增量以参数传入（内核不读库）：可以给已有分组追加措辞。"""
    sentence = "net 60 days after bill of lading"
    assert equivalent("60 天电汇", sentence) is False
    extra = {"net_60": ["60 天电汇", "net 60 days after bill of lading"]}
    assert equivalent("60 天电汇", sentence, extra) is True
    # 租户增量不污染全局表（下一次不带 extra 仍不等价）
    assert equivalent("60 天电汇", sentence) is False


def test_diff_and_lint_accept_tenant_extra_table():
    """租户增量要能一路传到 diff/lint（否则两处判定口径会分裂）。"""
    extra = {"net_60": ["60 天电汇", "net 60 days after bill of lading"]}
    tenant_pi = [Fact(key="shipping_marks", value="60 天电汇", immutable=True,
                      trust=TRUST_CONFIRMED)]
    tenant_sc = [Fact(key="shipping_marks", value="net 60 days after bill of lading",
                      immutable=True, trust=TRUST_CONFIRMED)]

    assert diff_facts({"pi": tenant_pi, "sc": tenant_sc}, root="pi")[0].status == "conflict"
    tolerant = diff_facts({"pi": tenant_pi, "sc": tenant_sc}, root="pi", extra=extra)
    assert tolerant[0].status == "equivalent"

    assert [check.ok for check in lint_pair(tenant_pi, tenant_sc)] == [False]
    assert [check.ok for check in lint_pair(tenant_pi, tenant_sc, extra=extra)] == [True]


def test_equivalent_handles_empty_values():
    assert equivalent("", None) is True
    assert equivalent("DAP Yangzhou", "") is False
    assert equivalent(None, "x") is False


# ─── 7. FactDiff 三态与错误码映射 ─────────────────────────────────────────

def test_fact_diff_code_mapping():
    assert FactDiff(key="k", kind="text", status="conflict").code == FACT_CONFLICT
    assert FactDiff(key="k", kind="text", status="equivalent").code == FACT_EQUIVALENT_WORDING
    assert FactDiff(key="k", kind="text", status="missing").code == FACT_MISSING
    assert FactDiff(key="k", kind="money", status="conflict").is_conflict is True


def test_diff_facts_reports_multiple_docs_in_one_entry():
    pi = facts_of("pi")
    ci = facts_of("ci", total_amount=2900)
    sc = facts_of("contract", total_amount=3000)
    diffs = [d for d in diff_facts({"pi": pi, "ci": ci, "sc": sc}, root="pi")
             if d.key == "total_amount"]
    assert len(diffs) == 1                       # 同一个 key 只出一条 diff
    assert set(diffs[0].values) == {"pi", "ci", "sc"}
    assert diffs[0].values["pi"] == "2826.49"
    assert diffs[0].diff_amount == "173.51"      # 相对基线的最大差额


def test_fact_conflict_values_are_normalized_text_not_objects():
    pi = facts_of("pi", total_amount=Decimal("2826.490"))
    ci = facts_of("ci", total_amount=2900)
    diff = [d for d in diff_facts({"pi": pi, "ci": ci}, root="pi")
            if d.key == "total_amount"][0]
    assert diff.values["pi"] == "2826.49"        # 十进制串，可直接 JSON
    assert isinstance(diff.values["ci"], str)
    assert diff.kind == "money"
