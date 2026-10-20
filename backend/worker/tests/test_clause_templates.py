"""A5-W1 条款模板库内核（`kaas_common.trade_doc.clause_templates`）测试 —— 纯函数。

钉住：
1. **默认 6 类**：分类齐全、名称唯一、每条 `doc_types` 都是 23 类合法子集、中英至少一侧非空；
2. **doc_types 校验**：非空、23 类子集、去重保序；空数组/未知类型/字符串都拒绝；
3. **name/text 校验**：name 非空、至少一侧正文、超长拒绝；单语（只有中文或只有英文）允许；
4. **sort_order**：必须是整数（字符串整数可接受，`"abc"` 拒绝）；
5. **pick_for_doc_type**：按单证类型筛选、默认排除停用、稳定排序、非法类型报错；
6. **default_seed_rows** 返回深拷贝（调用方改它不能污染模块常量）。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402

from kaas_common.domain.enums import DOC_TYPE  # noqa: E402
from kaas_common.trade_doc.clause_templates import (  # noqa: E402
    CLAUSE_DOC_TYPE_SET,
    CLAUSE_DOC_TYPES,
    CLAUSE_NAME_MAX,
    CLAUSE_TEXT_MAX,
    DEFAULT_CLAUSE_CATEGORIES,
    DEFAULT_CLAUSE_TEMPLATES,
    ClauseTemplateError,
    default_seed_rows,
    is_valid_doc_type,
    normalize_doc_types,
    pick_for_doc_type,
    validate_clause_template,
)


def test_doc_types_match_domain_enums():
    """内核里的本地 23 类清单必须与 `domain.enums.DOC_TYPE` **逐项一致**。

    `domain/enums.py` 依赖 FastAPI（orchestrator 内核测试环境没装），所以
    `clause_templates.py` 不能 import 它、只能存一份本地元组；这条测试就是防漂移的
    唯一门禁 —— 新增单证类型时两边必须同改。
    """
    assert CLAUSE_DOC_TYPES == tuple(DOC_TYPE)
    assert CLAUSE_DOC_TYPE_SET == frozenset(DOC_TYPE)


# ── 1) 默认 6 类 ───────────────────────────────────────────────────────────

def test_six_default_templates_are_valid_and_unique():
    assert len(DEFAULT_CLAUSE_TEMPLATES) == 6
    assert [t["category"] for t in DEFAULT_CLAUSE_TEMPLATES] == list(
        DEFAULT_CLAUSE_CATEGORIES
    )
    names = [t["name"] for t in DEFAULT_CLAUSE_TEMPLATES]
    assert len(set(names)) == 6
    for template in DEFAULT_CLAUSE_TEMPLATES:
        assert template["name"].strip()
        assert template["text_zh"].strip()
        assert template["text_en"].strip()
        assert template["doc_types"], "每条默认模板都要挂适用单证类型"
        assert set(template["doc_types"]) <= set(DOC_TYPE)
        assert isinstance(template["sort_order"], int)
        # 逐条走一遍入库前校验：默认数据本身必须过校验（否则懒种子会 500）
        validate_clause_template(
            name=template["name"],
            doc_types=list(template["doc_types"]),
            text_zh=template["text_zh"],
            text_en=template["text_en"],
            sort_order=template["sort_order"],
        )


def test_default_seed_rows_are_deep_copies():
    rows = default_seed_rows()
    assert len(rows) == 6
    rows[0]["name"] = "篡改"
    rows[0]["doc_types"].append("other")
    # 模块常量不受影响
    assert DEFAULT_CLAUSE_TEMPLATES[0]["name"] != "篡改"
    assert "other" not in DEFAULT_CLAUSE_TEMPLATES[0]["doc_types"]


# ── 2) doc_types 校验 ─────────────────────────────────────────────────────

def test_normalize_doc_types_dedupes_and_keeps_order():
    assert normalize_doc_types(["pi", "ci", "pi"]) == ["pi", "ci"]


@pytest.mark.parametrize("raw", [[], None, "pi", 123])
def test_normalize_doc_types_rejects_empty_or_non_list(raw):
    with pytest.raises(ClauseTemplateError) as excinfo:
        normalize_doc_types(raw)
    assert excinfo.value.code == "CLAUSE_DOC_TYPES_REQUIRED"


def test_normalize_doc_types_rejects_unknown_type():
    with pytest.raises(ClauseTemplateError) as excinfo:
        normalize_doc_types(["pi", "not_a_doc_type"])
    assert excinfo.value.code == "INVALID_DOC_TYPE"
    assert "not_a_doc_type" in excinfo.value.detail


def test_is_valid_doc_type_requires_exact_enum():
    assert is_valid_doc_type("pi")
    assert is_valid_doc_type(" non_wood_packing ")
    assert not is_valid_doc_type("PI")          # 不做大小写猜测
    assert not is_valid_doc_type("")
    assert not is_valid_doc_type(None)
    assert CLAUSE_DOC_TYPE_SET == frozenset(DOC_TYPE)


# ── 3) name / text 校验 ──────────────────────────────────────────────────

def test_validate_accepts_single_language():
    zh_only = validate_clause_template(
        name="  付款条件  ", doc_types=["pi"], text_zh="  30% 定金  ",
    )
    assert zh_only["name"] == "付款条件"
    assert zh_only["text_zh"] == "30% 定金"
    assert zh_only["text_en"] is None

    en_only = validate_clause_template(
        name="Payment", doc_types=["ci"], text_en="T/T in advance",
    )
    assert en_only["text_zh"] is None
    assert en_only["text_en"] == "T/T in advance"


def test_validate_rejects_empty_name():
    with pytest.raises(ClauseTemplateError) as excinfo:
        validate_clause_template(name="   ", doc_types=["pi"], text_zh="x")
    assert excinfo.value.code == "CLAUSE_NAME_REQUIRED"


def test_validate_rejects_too_long_name():
    with pytest.raises(ClauseTemplateError) as excinfo:
        validate_clause_template(
            name="a" * (CLAUSE_NAME_MAX + 1), doc_types=["pi"], text_zh="x",
        )
    assert excinfo.value.code == "CLAUSE_NAME_TOO_LONG"


def test_validate_rejects_both_texts_empty():
    with pytest.raises(ClauseTemplateError) as excinfo:
        validate_clause_template(
            name="空条款", doc_types=["pi"], text_zh="  ", text_en="\n",
        )
    assert excinfo.value.code == "CLAUSE_TEXT_REQUIRED"


def test_validate_rejects_too_long_text():
    with pytest.raises(ClauseTemplateError) as excinfo:
        validate_clause_template(
            name="超长", doc_types=["pi"], text_zh="x" * (CLAUSE_TEXT_MAX + 1),
        )
    assert excinfo.value.code == "CLAUSE_TEXT_TOO_LONG"


# ── 4) sort_order ────────────────────────────────────────────────────────

def test_sort_order_accepts_numeric_string_but_rejects_garbage():
    assert validate_clause_template(
        name="n", doc_types=["pi"], text_en="x", sort_order="7",
    )["sort_order"] == 7
    with pytest.raises(ClauseTemplateError) as excinfo:
        validate_clause_template(
            name="n", doc_types=["pi"], text_en="x", sort_order="abc",
        )
    assert excinfo.value.code == "CLAUSE_SORT_INVALID"


# ── 5) pick_for_doc_type ─────────────────────────────────────────────────

def _items():
    return [
        {"id": 3, "name": "c", "doc_types": ["ci"], "sort_order": 30, "is_active": True},
        {"id": 1, "name": "a", "doc_types": ["pi", "ci"], "sort_order": 10, "is_active": True},
        {"id": 2, "name": "b", "doc_types": ["pi"], "sort_order": 10, "is_active": False},
    ]


def test_pick_for_doc_type_filters_and_sorts():
    picked = pick_for_doc_type(_items(), "pi")
    assert [row["name"] for row in picked] == ["a"]   # b 停用；c 不适用 pi
    picked_ci = pick_for_doc_type(_items(), "ci")
    assert [row["name"] for row in picked_ci] == ["a", "c"]  # sort_order 10 < 30


def test_pick_for_doc_type_include_inactive():
    picked = pick_for_doc_type(_items(), "pi", include_inactive=True)
    assert [row["name"] for row in picked] == ["a", "b"]


def test_pick_for_doc_type_rejects_invalid_type():
    with pytest.raises(ClauseTemplateError) as excinfo:
        pick_for_doc_type(_items(), "nope")
    assert excinfo.value.code == "INVALID_DOC_TYPE"


def test_pick_for_doc_type_does_not_mutate_input():
    items = _items()
    picked = pick_for_doc_type(items, "pi")
    picked[0]["name"] = "modified"
    assert items[1]["name"] == "a"
