"""A14 包装事实内核测试（`kaas_common.trade_doc.facts`）—— 纯函数，无 DB/网络。

背景：产品管理已有 `spec.packaging[] = {id, name, method, is_default, ...}`，
报价行把本单 `packaging_id` 写进 `spec_snapshot`。A12 触发器需要 `packing_type`
枚举才能写「非木包装才出声明」，本任务把包装自由文本收敛成 6 类。

钉住：
1. **归类表**：木/袋/箱/无包装/混合/未知，含中英文与"木箱≠mixed"的优先级口径；
2. **两个事实**：`packing_method`（原文）+ `packing_type`（枚举），trust=confirmed
   （配置派生值不是待确认的人工声明，否则任何带包装单据都签不出去）；
3. **origin 标注**：本单行命中 = `row`（source=manual，evidence 带 packaging_id）；
   回退产品默认 = `inferred:product_default`（source=inferred）；
   产品无配置 = `inferred:none`；快照名回退 = `inferred:snapshot`；
4. **不传 packing 时不产生包装事实**（既有调用方 payload 口径零变化）。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402

from kaas_common.trade_doc.facts import (  # noqa: E402
    FACT_LABELS,
    PACKING_ORIGIN_NONE,
    PACKING_ORIGIN_PRODUCT_DEFAULT,
    PACKING_ORIGIN_ROW,
    PACKING_ORIGIN_SNAPSHOT,
    PACKING_TYPES,
    SOURCE_INFERRED,
    SOURCE_MANUAL,
    TRUST_CONFIRMED,
    classify_packing_type,
    extract_facts,
)


# ── 1) 归类表 ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("method", "expected"),
    [
        # wood：木 / wood / pallet / 托
        ("木托盘", "wood"),
        ("木箱", "wood"),                 # 优先级：木 > 箱（一个木制容器，不是混用）
        ("wooden pallet", "wood"),
        ("Pallet", "wood"),
        ("托盘", "wood"),
        ("plywood crate", "wood"),
        # bag
        ("编织袋", "bag"),
        ("paper bag", "bag"),
        ("Sack", "bag"),
        # carton
        ("纸箱", "carton"),
        ("carton box", "carton"),
        ("箱子", "carton"),
        # none
        ("", "none"),
        ("   ", "none"),
        ("None", "none"),
        ("no packing", "none"),
        ("无包装", "none"),
        # mixed（带分隔符且命中 2+ 类）
        ("木托盘+纸箱", "mixed"),
        ("wooden pallet / carton box", "mixed"),
        ("编织袋、纸箱", "mixed"),
        # other（未知措辞不猜成 wood）
        ("铁架", "other"),
        ("bulk", "other"),
    ],
)
def test_classify_packing_type_table(method, expected):
    assert classify_packing_type(method) == expected
    assert expected in PACKING_TYPES


def test_packing_types_enum_is_fixed():
    assert PACKING_TYPES == ("wood", "bag", "carton", "none", "mixed", "other")


def test_packing_labels_are_registered():
    assert FACT_LABELS["packing_method"] == ("包装方式", "Packing Method")
    assert FACT_LABELS["packing_type"] == ("包装类型", "Packing Type")


# ── 2/3) 事实抽取 + origin 标注 ──────────────────────────────────────────

def _payload() -> dict:
    return {"sources": {}, "custom": {}}


def _facts_by_key(packing: dict) -> dict:
    facts = extract_facts(_payload(), "pi", packing=packing)
    return {fact.key: fact for fact in facts}


def test_row_origin_facts_are_manual_confirmed_with_packaging_id():
    facts = _facts_by_key({
        "method": "木托盘",
        "origin": PACKING_ORIGIN_ROW,
        "packaging_id": "pk_wood",
        "packaging_name": "木托盘",
    })
    method = facts["packing_method"]
    assert method.value == "木托盘"
    assert method.source == SOURCE_MANUAL
    assert method.trust == TRUST_CONFIRMED
    assert "spec_snapshot.packaging_id=pk_wood" in method.evidence_ref
    # packing_type 是归类枚举（text 事实）
    ptype = facts["packing_type"]
    assert ptype.value == "wood"
    assert ptype.text_en == "wood"
    assert ptype.source == SOURCE_MANUAL


def test_product_default_origin_is_annotated_inferred():
    facts = _facts_by_key({
        "method": "纸箱",
        "origin": PACKING_ORIGIN_PRODUCT_DEFAULT,
        "packaging_id": "pk_carton",
        "packaging_name": "纸箱",
    })
    method = facts["packing_method"]
    assert method.source == SOURCE_INFERRED
    assert method.trust == TRUST_CONFIRMED
    assert method.evidence_ref.startswith("inferred:product_default")
    assert "pk_carton" in method.evidence_ref
    assert facts["packing_type"].value == "carton"


def test_no_config_origin_gives_none_type():
    facts = _facts_by_key({
        "method": "none",
        "origin": PACKING_ORIGIN_NONE,
        "packaging_id": None,
        "packaging_name": None,
    })
    assert facts["packing_method"].value == "none"
    assert facts["packing_type"].value == "none"
    assert facts["packing_method"].evidence_ref == "inferred:none"


def test_snapshot_origin_is_annotated():
    facts = _facts_by_key({
        "method": "编织袋",
        "origin": PACKING_ORIGIN_SNAPSHOT,
        "packaging_id": None,
        "packaging_name": "编织袋",
    })
    assert facts["packing_method"].source == SOURCE_INFERRED
    assert facts["packing_method"].evidence_ref == "inferred:snapshot"
    assert facts["packing_type"].value == "bag"


def test_empty_method_falls_back_to_none_type():
    facts = _facts_by_key({"method": "", "origin": PACKING_ORIGIN_NONE})
    assert facts["packing_method"].value == "none"
    assert facts["packing_type"].value == "none"


def test_no_packing_argument_means_no_packing_facts():
    facts = extract_facts(_payload(), "pi")
    keys = {fact.key for fact in facts}
    assert "packing_method" not in keys
    assert "packing_type" not in keys


def test_packing_facts_do_not_break_other_extraction():
    payload = {
        "sources": {"order": {"status": "confirmed", "currency": "USD",
                              "total_amount": 1200, "incoterm": "FOB"}},
        "custom": {},
    }
    facts = {fact.key: fact for fact in extract_facts(
        payload, "pi", packing={"method": "木托盘", "origin": PACKING_ORIGIN_ROW,
                                "packaging_id": "pk_wood"},
    )}
    # 原有事实照常抽出，包装事实只是追加
    assert facts["incoterm"].value == "FOB"
    assert facts["currency"].value == "USD"
    assert facts["packing_type"].value == "wood"
