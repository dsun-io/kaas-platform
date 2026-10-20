"""A7 事实层（`kaas_common.trade_doc.facts`）内核测试 —— 纯函数，无 DB / 无网络。

覆盖（对应 `TRADE_DOC_HARDENING_PLAN_2026-10-12.md` §4-A 与 §8 验收断言 2）：

1. **事实模型**：键归一（含行号、同义字段名、未知键不丢信息）、值归一
   （金额→十进制串 / 日期→ISO / 术语保留措辞）、非法 source/trust 直接拒绝；
2. **抽取**：从真实 payload 形状（`sources.*` 快照 + `custom`）抽事实，
   `source`/`trust` 按"谁给的值"推定，`evidence_ref` 可追溯到具体路径；
3. **信任级闸门**（§8-2）：存在 `trust != confirmed` 的事实 ⇒
   `gate_trust(..., "issued")` 返回 `FACT_UNVERIFIED`（带 key 清单）；确认后放行；
4. **不可改写**：`immutable` 事实被派生单改值 ⇒ `FACT_IMMUTABLE` + 原值/新值；
   原值引用（含词表内等价措辞）放行；
5. **单源推导**（§3-#3 真实翻车）：金额只由 `qty × price (÷ fx)` 推导，
   手填入口抛 `FACT_MANUAL_AMOUNT`，已存在的错值核出 `FACT_CONFLICT`；
6. **TBC 渲染**：未确认事实导出 `To be advised` / `待确认`，**不猜值、不留空**；
7. **边界**：空 payload、缺键（只有部分字段）、双语只填一侧。

为什么这些断言值得钉住：复盘里 6 类实质错误全部落在"事实层没有约束"上
（推断值直接被写进合同、PI 条款被派生单覆盖、单价手抄抄错一位）——
它们不是排版问题，靠渲染侧再修一遍是修不掉的。
"""
from __future__ import annotations

import copy
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import pytest

from kaas_common.trade_doc.facts import (
    FACT_CONFLICT,
    FACT_IMMUTABLE,
    FACT_MANUAL_AMOUNT,
    FACT_UNVERIFIED,
    SOURCE_INFERRED,
    SOURCE_MANUAL,
    SOURCE_PI,
    SOURCE_UPSTREAM,
    TBC_EN,
    TBC_ZH,
    TRUST_CONFIRMED,
    TRUST_INFERRED,
    TRUST_UNVERIFIED,
    Fact,
    assert_no_manual_amount,
    check_derived_amount,
    check_immutable,
    confirm_fact,
    derive_amount,
    derive_unit_price,
    extract_facts,
    gate_trust,
    normalize_fact_key,
    parse_payment_terms,
    render_tbc,
    values_equal,
)
from kaas_common.trade_doc.rules import RuleError

pytestmark = pytest.mark.unit


# ─── 真实单证形状的 payload 夹具（字段名取自 worker 的 order_snapshot）───────
#
# 金额/条款取自 2026-10-12 Tim 单（USD 2,826.49 / 汇率 6.7029 / DAP Yangzhou），
# 因为这几个数字正是复盘里被抄错过的那几个，用它当夹具最能锁住口径。
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


def make_payload(**override) -> dict:
    """构造一份 `raw_payload`：上游订单快照 + 手工字段（与落库形状一致）。"""
    order = copy.deepcopy(ORDER_SNAPSHOT)
    order.update(override)
    return {"sources": {"order": order}, "custom": {"pi_no": "LJ-PI-20260929-01"}}


def facts_by_key(payload: dict, doc_type: str = "pi") -> dict[str, Fact]:
    return {fact.key: fact for fact in extract_facts(payload, doc_type)}


# ─── 1. 键归一 ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw, expected", [
    ("incoterm", "incoterm"),
    ("Incoterms", "incoterm"),
    ("Delivery term", "incoterm"),          # 真实单证 SC 的栏位名就叫 Delivery term
    ("payment_terms", "payment_terms"),
    ("Terms of Payment", "payment_terms"),
    ("payment_ratio_deposit", "payment_deposit_ratio"),   # §8 的写法与任务书写法互认
    ("payment_deposit_ratio", "payment_deposit_ratio"),
    ("total_amount", "total_amount"),
    ("Total Amount", "total_amount"),
    ("currency", "currency"),
    ("Items[1].unit_price", "unit_price[1]"),   # 行号保留、1 起
    ("unit_price_2", "unit_price[2]"),
    ("qty[3]", "qty[3]"),
    ("port_of_loading", "port_of_loading"),
    ("port_of_unloading", "port_of_destination"),   # 落库字段叫 destination，同义归一
    ("country_of_origin", "country_of_origin"),
    ("doc_no", "doc_no"),
    ("date", "date"),
    ("单据日期", "date"),
    ("贸易术语", "incoterm"),
    ("定金比例", "payment_deposit_ratio"),
    # 未知键：小写 + 下划线化，**信息不丢**（不许映射成"其它"）
    ("Freight Note", "freight_note"),
    ("customs-declaration-form", "customs_declaration_form"),
])
def test_normalize_fact_key(raw, expected):
    assert normalize_fact_key(raw) == expected


def test_normalize_fact_key_keeps_unknown_and_handles_empty():
    assert normalize_fact_key("Some Weird Key!") == "some_weird_key"
    assert normalize_fact_key("") == ""
    assert normalize_fact_key(None) == ""
    # 行号是"第几条明细"，不能被别名表吃掉
    assert normalize_fact_key("items[0].line_amount") == "line_amount[0]"


# ─── 2. Fact 模型 ──────────────────────────────────────────────────────────

def test_fact_normalizes_value_by_kind():
    # 金额 → 十进制字符串（0.30 → 0.3，两端都无损）
    assert Fact(key="payment_deposit_ratio", value=Decimal("0.30")).value == "0.3"
    assert Fact(key="total_amount", value=2826.49).value == "2826.49"
    # 日期 → ISO
    assert Fact(key="date", value="12 Oct 2026").value == "2026-10-12"
    assert Fact(key="date", value="2026年10月12日").value == "2026-10-12"
    # 术语 → 保留原措辞（排版归一，不改语义；比较时才走等价词表）
    assert Fact(key="incoterm", value="DAP  Yangzhou,  Jiangsu").value == "DAP Yangzhou, Jiangsu"
    # 币种 → 大写
    assert Fact(key="currency", value="usd").value == "USD"


def test_fact_rejects_illegal_source_or_trust():
    with pytest.raises(ValueError):
        Fact(key="incoterm", value="DAP X", source="magic")
    with pytest.raises(ValueError):
        Fact(key="incoterm", value="DAP X", trust="probably")
    with pytest.raises(ValueError):
        Fact(key="", value="x")


def test_fact_bilingual_one_side_and_confirm():
    fact = Fact(key="incoterm", value="DAP Yangzhou", text_en="DAP Yangzhou")
    assert fact.bilingual == ("", "DAP Yangzhou")
    assert fact.trust == TRUST_UNVERIFIED
    confirmed = confirm_fact(fact, by=7, at="2026-10-20T10:00:00+08:00")
    assert confirmed.confirmed is True
    assert confirmed.confirmed_by == 7
    assert confirmed.confirmed_at.startswith("2026-10-20")
    # confirm_fact 返回新对象，原事实不变（事实层不改历史）
    assert fact.trust == TRUST_UNVERIFIED


# ─── 3. 抽取：来源 / 信任级 / 证据 ──────────────────────────────────────────

def test_extract_facts_from_real_payload_shape():
    facts = facts_by_key(make_payload(), "pi")
    for key in (
        "incoterm", "payment_terms", "currency", "total_amount", "fx_rate",
        "port_of_loading", "port_of_destination", "country_of_origin", "shipping_marks",
        "qty[1]", "unit_price[1]", "line_amount[1]",
        "doc_no", "order_no", "buyer_name",
        "payment_deposit_ratio", "payment_deposit_timing",
        "payment_balance_ratio", "payment_balance_timing",
    ):
        assert key in facts, f"缺少事实 {key}"
    # 上游快照 = 已确认基线；证据指到具体路径
    assert facts["incoterm"].source == SOURCE_UPSTREAM
    assert facts["incoterm"].trust == TRUST_CONFIRMED
    assert facts["incoterm"].evidence_ref == "sources.order.incoterm"
    # 行号 1 起（与界面行号一致）
    assert facts["unit_price[1]"].value == "3.7297"
    assert facts["unit_price[2]"].value == "0.3252"
    # 身份事实：单号来自 custom.pi_no（doc_type=pi），日期缺失就不造
    assert facts["doc_no"].value == "LJ-PI-20260929-01"
    assert "date" not in facts
    # 上游单号是**另一条**事实（交叉引用用），不能和自身单号混成一个键
    assert facts["order_no"].value == "LJ-O-20260928-01"


def test_extract_facts_marks_parsed_payment_structure_unverified():
    """付款结构是从散文解析出来的 ⇒ 推断，必须人工确认后才能进 issued。"""
    facts = facts_by_key(make_payload(), "pi")
    for key in ("payment_deposit_ratio", "payment_deposit_timing",
                "payment_balance_ratio", "payment_balance_timing"):
        assert facts[key].trust == TRUST_UNVERIFIED, key
        assert facts[key].evidence_ref.endswith("（解析）")
    assert facts["payment_deposit_ratio"].value == "0.3"
    assert facts["payment_balance_ratio"].value == "0.7"
    assert facts["payment_deposit_timing"].value == "upon_order_confirmation"
    assert facts["payment_balance_timing"].value == "upon_dispatch_before_delivery"
    # 原句仍在 text 里（双语只填一侧：这句话是英文）
    assert facts["payment_balance_timing"].text_en.startswith("70% balance")
    assert facts["payment_balance_timing"].text_zh == ""


def test_extract_facts_manual_field_is_manual_source():
    payload = make_payload()
    payload["custom"]["shipping_marks"] = "TIM-01"   # 手工改过的唛头优先于快照
    facts = facts_by_key(payload, "pi")
    assert facts["shipping_marks"].value == "TIM-01"
    assert facts["shipping_marks"].source == SOURCE_MANUAL
    assert facts["shipping_marks"].trust == TRUST_CONFIRMED
    assert facts["shipping_marks"].evidence_ref == "custom.shipping_marks"


def test_extract_facts_draft_baseline_is_unverified():
    """源单还没定稿（status=draft）⇒ 快照里的事实不能当已确认。"""
    facts = facts_by_key(make_payload(status="draft"), "pi")
    assert facts["incoterm"].trust == TRUST_UNVERIFIED


def test_extract_facts_custom_cannot_override_amounts():
    """受保护字段（items/total_amount）不受 custom 覆盖 —— 与渲染侧同一道闸门。"""
    payload = make_payload()
    payload["custom"]["total_amount"] = 1.00
    payload["custom"]["items"] = [{"qty": 1, "unit_price": 1}]
    facts = facts_by_key(payload, "pi")
    assert facts["total_amount"].value == "2826.49"     # 仍来自上游快照
    assert facts["total_amount"].source == SOURCE_UPSTREAM
    assert facts["qty[1]"].value == "400"
    assert len([key for key in facts if key.startswith("qty[")]) == 2


def test_extract_facts_derived_doc_shape_is_flattened():
    """派生单的 `sources.pi` 存的是**上游单证整份 raw_payload**：要能摊平取到条款。"""
    pi_payload = make_payload()
    derived = {
        "sources": {"pi": pi_payload},
        "custom": {"invoice_no": "LJ-CI-20261012-01"},
    }
    facts = facts_by_key(derived, "ci")
    assert facts["incoterm"].value == "DAP Yangzhou, Jiangsu, China (Incoterms 2020)"
    assert facts["incoterm"].source == SOURCE_PI
    assert facts["incoterm"].evidence_ref == "sources.pi.incoterm"
    assert facts["doc_no"].value == "LJ-CI-20261012-01"     # 自身单号取 CI 的号
    assert facts["pi_no"].value == "LJ-PI-20260929-01"      # 上游 PI 号是另一条事实


def test_extract_facts_immutable_flags_terms_not_money():
    facts = facts_by_key(make_payload(), "pi")
    for key in ("incoterm", "payment_terms", "currency", "fx_rate",
                "port_of_loading", "country_of_origin",
                "payment_deposit_ratio", "payment_balance_timing"):
        assert facts[key].immutable is True, key
    # 金额不做"不可改写"（部分出运时 CI 与 PI 金额天然不同，靠推导规则约束）
    assert facts["total_amount"].immutable is False
    assert facts["unit_price[1]"].immutable is False


def test_extract_facts_empty_and_partial_payload():
    assert extract_facts({}, "pi") == []
    assert extract_facts(None, "ci") == []
    assert extract_facts({"custom": {}}, "ci") == []
    # 缺键：只抽出存在的字段，不补默认值、不造空事实
    partial = {"custom": {"incoterm": "FOB Shanghai"}}
    facts = facts_by_key(partial, "ci")
    assert set(facts) == {"incoterm"}
    assert facts["incoterm"].value == "FOB Shanghai"
    # 非 dict 的 custom/sources 不炸
    assert extract_facts({"custom": "oops", "sources": []}, "ci") == []


def test_extract_facts_date_from_row_fields():
    payload = make_payload()
    payload["issued_at"] = "2026-10-12T09:30:00+08:00"
    facts = facts_by_key(payload, "ci")
    assert facts["date"].value == "2026-10-12"


def test_extract_facts_identity_facts_are_confirmed():
    """单号/日期是系统落库的自身标识，不能算"未确认" —— 否则任何单证都签不出去。"""
    payload = make_payload()
    payload["custom"]["invoice_no"] = "LJ-CI-20261012-01"
    payload["issued_at"] = "2026-10-12T09:30:00+08:00"
    facts = facts_by_key(payload, "ci")
    assert facts["doc_no"].value == "LJ-CI-20261012-01"
    assert facts["doc_no"].trust == TRUST_CONFIRMED
    assert facts["date"].trust == TRUST_CONFIRMED
    blocked = gate_trust(facts.values(), "issued")
    assert blocked, "付款结构（解析所得）本来就应该拦一下"
    assert "date" not in blocked[0].keys and "doc_no" not in blocked[0].keys


# ─── 4. 硬规则 1：trust 闸门（§8 断言 2）────────────────────────────────────

def test_gate_trust_blocks_issued_when_inferred_fact_exists():
    facts = [
        Fact(key="incoterm", value="DAP Yangzhou", trust=TRUST_CONFIRMED, source=SOURCE_PI),
        # 真实翻车 #5：从邮箱域名"推出"的买方公司名
        Fact(key="buyer_name", value="One Atmosphere", trust=TRUST_INFERRED,
             source=SOURCE_INFERRED, evidence_ref="ai:domain-inference"),
    ]
    violations = gate_trust(facts, "issued")
    assert len(violations) == 1
    violation = violations[0]
    assert violation.code == FACT_UNVERIFIED
    assert violation.keys == ("buyer_name",)
    assert "推断值" in violation.detail
    assert violation.evidence_ref == "ai:domain-inference"
    # 非 issued 目标放行（草稿本来就在改）
    assert gate_trust(facts, "draft") == []
    assert gate_trust(facts, "void") == []


def test_gate_trust_passes_after_confirmation():
    facts = extract_facts(make_payload(), "pi")
    blocked = gate_trust(facts, "issued")
    assert len(blocked) == 1
    assert set(blocked[0].keys) >= {"payment_deposit_ratio", "payment_balance_timing"}
    # 逐项确认（模拟业务员在界面上点确认）后放行
    confirmed = [confirm_fact(fact) for fact in facts]
    assert gate_trust(confirmed, "issued") == []
    # 只确认一部分：未确认的那些仍被拦下
    partially = [confirm_fact(f) if f.key != "payment_balance_ratio" else f for f in facts]
    assert gate_trust(partially, "issued")[0].keys == ("payment_balance_ratio",)


def test_gate_trust_all_confirmed_is_clean():
    facts = [
        Fact(key="incoterm", value="DAP X", trust=TRUST_CONFIRMED, source=SOURCE_PI),
        Fact(key="total_amount", value="100", trust=TRUST_CONFIRMED),
    ]
    assert gate_trust(facts, "issued") == []


# ─── 5. 硬规则 2：不可改写 ─────────────────────────────────────────────────

def test_check_immutable_rejects_overridden_payment_ratio():
    base = [Fact(key="payment_deposit_ratio", value="0.30", immutable=True,
                 trust=TRUST_CONFIRMED)]
    derived = [Fact(key="payment_deposit_ratio", value="0.5", trust=TRUST_CONFIRMED)]
    violations = check_immutable(base, derived)
    assert len(violations) == 1
    violation = violations[0]
    assert violation.code == FACT_IMMUTABLE
    assert violation.keys == ("payment_deposit_ratio",)
    assert violation.original == "0.3"      # 归一后的原值
    assert violation.provided == "0.5"
    assert "原值引用" in violation.detail


def test_check_immutable_allows_original_value_and_equivalent_wording():
    base = [
        Fact(key="incoterm", value="DAP Yangzhou, Jiangsu, China (Incoterms 2020)",
             immutable=True, trust=TRUST_CONFIRMED),
        Fact(key="payment_deposit_ratio", value="0.3", immutable=True,
             trust=TRUST_CONFIRMED),
    ]
    # 原值引用：允许
    assert check_immutable(base, [Fact(key="incoterm",
                                       value="DAP Yangzhou, Jiangsu, China (Incoterms 2020)"),
                                  Fact(key="payment_deposit_ratio", value="0.30")]) == []
    # 词表内等价措辞（少写省/国）：不算改值，允许
    no_version = Fact(key="incoterm", value="DAP Yangzhou, Jiangsu, China",
                      immutable=True, trust=TRUST_CONFIRMED)
    assert check_immutable([no_version], [Fact(key="incoterm", value="DAP Yangzhou")]) == []
    # 换了个省：算改值
    assert len(check_immutable(
        [no_version], [Fact(key="incoterm", value="DAP Yangzhou, Anhui, China")]
    )) == 1


def test_check_immutable_ignores_non_immutable_and_unknown_keys():
    base = [Fact(key="total_amount", value="100", immutable=False)]
    derived = [Fact(key="total_amount", value="200"),
               Fact(key="invoice_no", value="LJ-CI-1")]
    assert check_immutable(base, derived) == []
    assert check_immutable([], derived) == []


# ─── 6. 硬规则 3：单源推导 ─────────────────────────────────────────────────

def test_derive_amount_and_unit_price_from_fx():
    # 真实翻车 #3：绝缘子 USD 单价 = 2.18 ÷ 6.7029 = 0.3252（被抄成 0.3253）
    assert derive_unit_price("2.18", "6.7029") == Decimal("0.3252")
    assert derive_amount(400, "0.3252") == Decimal("130.0800")
    assert derive_amount("2.18", 1, "6.7029") == Decimal("0.3252")
    # 四舍五入口径与 rules.line_amount 一致（4 位小数 ROUND_HALF_UP）
    assert derive_amount("1", "1.00005") == Decimal("1.0001")


def test_derive_amount_rejects_missing_inputs():
    with pytest.raises(RuleError) as excinfo:
        derive_amount(None, "3.72")
    assert excinfo.value.code == "ITEMS_INVALID"
    with pytest.raises(RuleError):
        derive_unit_price(None)
    with pytest.raises(RuleError):
        derive_amount(1, 1, 0)      # 汇率为 0 无法推导
    with pytest.raises(RuleError):
        derive_unit_price(1, "-6.7")


def test_assert_no_manual_amount_blocks_entry_but_returns_derived():
    assert assert_no_manual_amount(qty=400, unit_price="3.7297") == Decimal("1491.8800")
    with pytest.raises(RuleError) as excinfo:
        assert_no_manual_amount(provided="1491.90", qty=400, unit_price="3.7297")
    assert excinfo.value.code == FACT_MANUAL_AMOUNT
    # 空串 = 没填，仍按推导走
    assert assert_no_manual_amount(provided="", qty=1, unit_price="2.5") == Decimal("2.5000")


def test_check_derived_amount_reports_conflict_and_manual_without_basis():
    conflict = check_derived_amount("1491.8800", "1492.00")
    assert len(conflict) == 1
    assert conflict[0].code == FACT_CONFLICT
    assert conflict[0].original == "1491.88"
    assert conflict[0].provided == "1492"
    # 对得上（含位数差异）⇒ 无违例
    assert check_derived_amount("1491.88", "1491.8800") == []
    assert check_derived_amount("1491.88", None) == []
    # 有钱数但没有推导依据 ⇒ 手填
    manual = check_derived_amount(None, "1491.88")
    assert manual[0].code == FACT_MANUAL_AMOUNT


def test_check_derived_amount_catches_hand_copied_unit_price():
    """§3-#3 的机器化：手抄 0.3253 对不上 2.18÷6.7029，必须报出来。"""
    derived = derive_amount(400, derive_unit_price("2.18", "6.7029"))
    provided = (Decimal("0.3253") * 400).quantize(Decimal("0.0001"))
    assert check_derived_amount(derived, provided)[0].code == FACT_CONFLICT


# ─── 7. TBC 渲染（不猜值、不留空）─────────────────────────────────────────

def test_render_tbc_uses_placeholder_not_value():
    facts = [
        Fact(key="incoterm", value="DAP Yangzhou", trust=TRUST_UNVERIFIED,
             evidence_ref="custom.incoterm"),
        Fact(key="buyer_name", value="One Atmosphere", trust=TRUST_INFERRED,
             source=SOURCE_INFERRED),
        Fact(key="currency", value="USD", trust=TRUST_CONFIRMED),
    ]
    rendered = render_tbc(facts)
    assert [item["key"] for item in rendered] == ["buyer_name", "incoterm"]  # 已确认的不出现
    for item in rendered:
        # 关键断言：**绝不**把推测值渲染出去
        assert item["value_zh"] == TBC_ZH == "待确认"
        assert item["value_en"] == TBC_EN == "To be advised"
        assert "DAP Yangzhou" not in item["text_en"]
        assert "One Atmosphere" not in item["text_zh"]
        # 不留空：中英两侧都有占位
        assert item["text_zh"] and item["text_en"]
        assert item["placeholder"] == "TBC"
    assert rendered[1]["evidence_ref"] == "custom.incoterm"


def test_render_tbc_dedupes_and_labels_indexed_keys():
    facts = [
        Fact(key="unit_price[2]", value="0.3252", trust=TRUST_UNVERIFIED),
        Fact(key="unit_price[2]", value="0.3253", trust=TRUST_UNVERIFIED),
    ]
    rendered = render_tbc(facts)
    assert len(rendered) == 1
    assert rendered[0]["label_zh"] == "单价（第2行）"
    assert rendered[0]["label_en"] == "Unit Price (line 2)"


# ─── 8. 值比较口径（容差 / 精确 / 词表）────────────────────────────────────

def test_values_equal_money_uses_receipt_tolerance():
    # USD：max(5 美分, 0.1%) —— 847.95 的 0.1% = 0.85，所以 0.02/0.06 都在容差内
    assert values_equal("total_amount", "847.95", "847.93", currency="USD") is True
    assert values_equal("total_amount", "847.95", "848.60", currency="USD") is True
    # 超出容差才算冲突（0.1% 与 5 美分取大者，不是固定 5 美分）
    assert values_equal("total_amount", "847.95", "850.00", currency="USD") is False
    # 精确模式（对账/审计场景）：容差归零
    assert values_equal("total_amount", "847.95", "847.93",
                        currency="USD", tolerance=False) is False


def test_values_equal_fx_ratio_qty_are_exact():
    assert values_equal("fx_rate", "6.7029", "6.7029") is True
    assert values_equal("fx_rate", "6.7029", "6.7030") is False     # 汇率必须完全一致
    assert values_equal("payment_deposit_ratio", "0.3", "0.30") is True
    assert values_equal("payment_deposit_ratio", "0.3", "0.31") is False
    # 单价要精确：5 美分下限对 0.3252 是 15% 的宽容度，会吞掉真实抄数错误
    assert values_equal("unit_price[1]", "0.3252", "0.3253") is False
    assert values_equal("qty[1]", "400", "400.0") is True


def test_values_equal_text_and_date_go_through_equivalents():
    assert values_equal("incoterm", "DAP Yangzhou", "DAP Yangzhou, Jiangsu, China") is True
    assert values_equal("incoterm", "DAP Yangzhou, Jiangsu, China (Incoterms 2020)",
                        "DAP Yangzhou, Jiangsu, China") is False
    assert values_equal("payment_balance_timing", "before dispatch",
                        "upon dispatch (before delivery)") is True
    assert values_equal("payment_balance_timing", "upon dispatch", "before dispatch") is False
    assert values_equal("date", "2026-10-12", "12 Oct 2026") is True


# ─── 9. 付款条件结构化 ─────────────────────────────────────────────────────

def test_parse_payment_terms_real_sentence():
    parts = parse_payment_terms(
        "30% deposit upon order confirmation, 70% balance before dispatch")
    assert [(part.role, part.ratio) for part in parts] == [
        ("deposit", Decimal("0.3")), ("balance", Decimal("0.7")),
    ]
    assert parts[0].timing == "upon_order_confirmation"
    assert parts[1].timing == "upon_dispatch_before_delivery"


def test_parse_payment_terms_bare_upon_dispatch_is_not_upgraded():
    """裸 `upon dispatch` 不能被"猜"成带限定语的时点（少写限定语就是不符点）。"""
    parts = parse_payment_terms("70% balance upon dispatch")
    assert parts[0].timing == "upon_dispatch"


def test_parse_payment_terms_skips_ambiguous_or_unparsable():
    assert parse_payment_terms("") == []
    assert parse_payment_terms("T/T in advance") == []              # 没比例 ⇒ 不猜
    assert parse_payment_terms("deposit and balance 50%") == []     # 角色词冲突 ⇒ 不猜
    # 100% 无角色词 ⇒ full
    full = parse_payment_terms("100% payment before delivery")
    assert [(part.role, part.ratio, part.timing) for part in full] == [
        ("full", Decimal("1"), "upon_dispatch_before_delivery"),
    ]


def test_parse_payment_terms_extracts_full_payment_facts():
    facts = facts_by_key(make_payload(payment_terms="100% payment before delivery"), "pi")
    assert facts["payment_full_ratio"].value == "1"
    assert facts["payment_full_timing"].value == "upon_dispatch_before_delivery"
    assert facts["payment_full_ratio"].trust == TRUST_UNVERIFIED


def test_parse_payment_terms_accepts_tenant_extra_table():
    """租户自己的时点写法只有"以参数传进来"才会被认成枚举（内核不读库）。"""
    sentence = "70% balance net 60 days after B/L"
    assert parse_payment_terms(sentence)[0].timing is None          # 不认识 ⇒ 不猜
    extra = {"net_60_after_bl": ["net 60 days after B/L"]}
    assert parse_payment_terms(sentence, extra)[0].timing == "net_60_after_bl"
    # extract_facts 把这个增量一路传给付款条件解析
    facts = facts_by_key(
        make_payload(payment_terms=sentence), "pi",
    )
    assert "payment_balance_timing" not in facts
    facts = {fact.key: fact for fact in extract_facts(
        make_payload(payment_terms=sentence), "pi", extra_equivalents=extra)}
    assert facts["payment_balance_timing"].value == "net_60_after_bl"
