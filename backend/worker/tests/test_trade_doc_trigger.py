"""A12 单证清单触发条件（`kaas_common.trade_doc.trigger`）内核测试 —— 纯函数，无 DB/网络。

覆盖（对应 `docs/TRADE_DOC_HARDENING.md` 的 trigger 一节）：

1. **真值口径**：`None` / 空串 / 纯空白 ⇒ 总是适用（True）；
2. **比较**：`== != > >= < <=`，数值/布尔/字符串三种形态（`Fact.value` 恒为字符串，
   所以 `"1200" > 1000` 与 `"False" == false` 都必须成立）；
3. **逻辑**：`and` / `or` / `not` + 括号 + 优先级（`and` 高于 `or`）；
4. **成员**：`in` / `not in` 对列表字面量，`in` 对字符串（子串）；
5. **事实键**：扁平键、嵌套 dict、`facts.` 前缀、扁平点号键、最后一段回退；
6. **结构化错误**：未知键 / 语法错 / 类型错 / 超长·过深（**绝不 eval**，
   `__import__("os")` 之类只能得到语法错，不能执行）；
7. **doc-set 标注**：跳过项**不删除**、`role=required` 才标 `skipped_by_trigger`、
   无法求值按"适用"处理并带 `trigger_error`。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402

from kaas_common.trade_doc.trigger import (  # noqa: E402
    MAX_DEPTH,
    MAX_EXPR_LENGTH,
    TRIGGER_SYNTAX,
    TRIGGER_TOO_COMPLEX,
    TRIGGER_TYPE,
    TRIGGER_UNKNOWN_KEY,
    TriggerError,
    evaluate_trigger,
    parse_trigger,
    resolve_doc_set,
    validate_trigger,
)

FACTS = {
    "incoterm": "FOB",
    "total_amount": "1200",
    "currency": "USD",
    "has_wood": "False",
    "packaging": {"has_wood": False, "kind": "carton"},
    "packaging.has_wood": "False",
}


# ── 1) 空表达式 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("expr", [None, "", "   ", "\n\t"])
def test_empty_expression_is_always_applicable(expr):
    assert evaluate_trigger(expr, FACTS) is True
    assert validate_trigger(expr) is True


# ── 2) 比较（数值 / 布尔 / 字符串）────────────────────────────────────────

@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ('incoterm == "FOB"', True),
        ("incoterm == 'CIF'", False),
        ('incoterm != "CIF"', True),
        ("total_amount > 1000", True),
        ("total_amount >= 1200", True),
        ("total_amount < 1200", False),
        ("total_amount <= 1200", True),
        ("-5 < 0", True),
        ("0.5 == 0.50", True),
        ("1200 == 1200", True),
        ('"FOB" == "FOB"', True),
        ("True == true", True),
        ("None == none", True),
    ],
)
def test_comparisons(expr, expected):
    assert evaluate_trigger(expr, FACTS) is expected


def test_bool_fact_string_compares_as_bool():
    # 事实值是字符串 "False"（extract_facts 归一后），仍必须与布尔字面量比较
    assert evaluate_trigger("has_wood == false", FACTS) is True
    assert evaluate_trigger("has_wood != true", FACTS) is True
    assert evaluate_trigger("has_wood == true", FACTS) is False


# ── 3) 逻辑 + 括号 + 优先级 ───────────────────────────────────────────────

@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ('incoterm == "FOB" and total_amount > 1000', True),
        ('incoterm == "CIF" and total_amount > 1000', False),
        ('incoterm == "CIF" or total_amount > 1000', True),
        ('not (incoterm == "CIF")', True),
        ("not False and True", True),
        ("False or False and True", False),      # and 优先级高于 or
        ("(False or False) and True", False),
        ("not not True", True),
        ('not incoterm in ["FOB"]', False),
    ],
)
def test_boolean_logic(expr, expected):
    assert evaluate_trigger(expr, FACTS) is expected


# ── 4) in / not in ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ('incoterm in ["FOB", "CIF"]', True),
        ('incoterm not in ["FOB"]', False),
        ('incoterm in []', False),
        ('"OB" in incoterm', True),
        ('"XX" in incoterm', False),
        ("total_amount in [1200, 1300]", True),
    ],
)
def test_membership(expr, expected):
    assert evaluate_trigger(expr, FACTS) is expected


# ── 5) 事实键解析：嵌套 / 点号 / 扁平 / 回退 ───────────────────────────────

@pytest.mark.parametrize(
    "expr",
    [
        "packaging.has_wood == false",
        "facts.packaging.has_wood == false",
        "packaging.has_wood",            # 嵌套 dict 的 bool False ⇒ 假
    ],
)
def test_nested_and_dotted_fact_keys(expr):
    expected = False if expr == "packaging.has_wood" else True
    assert evaluate_trigger(expr, FACTS) is expected


def test_nested_dict_wins_over_flat_dotted_key():
    facts = {"packaging": {"has_wood": True}, "packaging.has_wood": "False"}
    assert evaluate_trigger("packaging.has_wood == true", facts) is True


def test_flat_dotted_key_fallback_when_not_nested():
    assert evaluate_trigger("packaging.has_wood == false", {"packaging.has_wood": "False"}) is True


def test_last_segment_flat_fallback():
    assert evaluate_trigger("packaging.has_wood == false", {"has_wood": "False"}) is True


# ── 6) 结构化错误 ─────────────────────────────────────────────────────────

def test_unknown_key_raises_structured_error():
    with pytest.raises(TriggerError) as excinfo:
        evaluate_trigger("no_such_fact == 1", FACTS)
    assert excinfo.value.code == TRIGGER_UNKNOWN_KEY
    assert "no_such_fact" in excinfo.value.message
    assert excinfo.value.as_dict()["code"] == TRIGGER_UNKNOWN_KEY


@pytest.mark.parametrize(
    "expr",
    [
        "incoterm ==",              # 不完整
        "incoterm = 'FOB'",         # 赋值不是表达式
        "incoterm ==",
        "1abc == 1",                # 非法数字
        "'unterminated == 1",
        "incoterm == 'FOB' extra",  # 多余内容
        "incoterm == \"FOB",        # 字符串未闭合
        "not",                      # 只有关键字
        "()",                       # 空括号
        "1 + 1",                    # 本语言没有算术（+ 只能作数字正号）
    ],
)
def test_syntax_errors(expr):
    with pytest.raises(TriggerError) as excinfo:
        evaluate_trigger(expr, FACTS)
    assert excinfo.value.code == TRIGGER_SYNTAX


@pytest.mark.parametrize("expr", ["incoterm > 1", "incoterm < \"FOB\"", "has_wood >= true"])
def test_type_errors(expr):
    with pytest.raises(TriggerError) as excinfo:
        evaluate_trigger(expr, FACTS)
    assert excinfo.value.code == TRIGGER_TYPE


def test_too_long_rejected_before_parse():
    expr = "a" + " and a" * (MAX_EXPR_LENGTH // 5)
    with pytest.raises(TriggerError) as excinfo:
        evaluate_trigger(expr, FACTS)
    assert excinfo.value.code == TRIGGER_TOO_COMPLEX


def test_too_deep_parens_rejected():
    expr = "(" * (MAX_DEPTH + 2) + "True" + ")" * (MAX_DEPTH + 2)
    with pytest.raises(TriggerError) as excinfo:
        evaluate_trigger(expr, FACTS)
    assert excinfo.value.code == TRIGGER_TOO_COMPLEX


def test_too_many_tokens_rejected():
    expr = " and ".join(["True"] * 300)
    with pytest.raises(TriggerError) as excinfo:
        evaluate_trigger(expr, FACTS)
    assert excinfo.value.code == TRIGGER_TOO_COMPLEX


# ── 7) 安全边界：绝不是 eval ──────────────────────────────────────────────

@pytest.mark.parametrize(
    "expr",
    [
        '__import__("os")',
        "open('/etc/passwd')",
        "os.system('id')",
        "().__class__.__bases__",
        "lambda: True",
        "fact.upper()",
        "[x for x in range(3)]",
    ],
)
def test_python_code_is_rejected_not_executed(expr):
    with pytest.raises(TriggerError) as excinfo:
        evaluate_trigger(expr, FACTS)
    assert excinfo.value.code in (TRIGGER_SYNTAX, TRIGGER_UNKNOWN_KEY, TRIGGER_TYPE)


def test_validate_allows_unknown_key_but_rejects_bad_syntax():
    # 写入时未知键允许（事实集合会随 payload 演进）：只校验语法
    assert validate_trigger("future_fact == 1") is True
    with pytest.raises(TriggerError):
        validate_trigger("future_fact ==")


def test_parse_trigger_returns_ast():
    node = parse_trigger('incoterm == "FOB"')
    assert node[0] == "cmp"


# ── 8) resolve_doc_set：标注不删除 ────────────────────────────────────────

def test_resolve_doc_set_marks_skipped_required_without_deleting():
    items = [
        {"doc_type": "pd", "role": "required", "trigger_expr": "has_wood == true"},
        {"doc_type": "ci", "role": "required", "trigger_expr": None},
        {"doc_type": "co", "role": "optional", "trigger_expr": "has_wood == true"},
    ]
    resolved = resolve_doc_set(items, FACTS)

    assert [item["doc_type"] for item in resolved] == ["pd", "ci", "co"]  # 不删除、保序
    assert resolved[0]["applicable"] is False
    assert resolved[0]["skipped_by_trigger"] is True
    assert "触发条件不满足" in resolved[0]["trigger_reason"]
    assert resolved[1]["applicable"] is True
    assert resolved[1]["skipped_by_trigger"] is False
    assert resolved[1]["trigger_reason"] is None
    # 非 required：条件不满足也不标 skipped（只是展示适用性）
    assert resolved[2]["applicable"] is False
    assert resolved[2]["skipped_by_trigger"] is False


def test_resolve_doc_set_unknown_key_keeps_applicable_with_error():
    items = [{"doc_type": "pd", "role": "required", "trigger_expr": "renamed_fact == true"}]
    resolved = resolve_doc_set(items, FACTS)
    assert resolved[0]["applicable"] is True          # 未知键不隐藏必出单证
    assert resolved[0]["skipped_by_trigger"] is False
    assert resolved[0]["trigger_error"]["code"] == TRIGGER_UNKNOWN_KEY
    assert "无法求值" in resolved[0]["trigger_reason"]


def test_resolve_doc_set_empty_expression_is_applicable():
    resolved = resolve_doc_set(
        [{"doc_type": "ci", "role": "required", "trigger_expr": "  "}],
        FACTS,
    )
    assert resolved[0]["applicable"] is True
    assert resolved[0].get("trigger_error") is None
