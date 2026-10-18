"""客户阶段纯函数（共享内核）单测。

2026-10-18 用户口径：
  · 客户阶段 = 活跃 / 沉寂 / 已下单；
  · 已下单 = 名下存在开启中的订单（pending/confirmed/producing/shipped）；
  · 活跃/沉寂是手动值（存在 customers.stage），沉寂 = 客户关系关闭；
  · 询盘/报价/订单的 lead→inquiry→quoted→won→lost 属于**单据阶段**，不是客户阶段；
  · 不再按 30/90 天自动改客户阶段。
"""
import pytest

from kaas_common.workstation.customer_rules import (
    CUSTOMER_STAGES,
    MANUAL_CUSTOMER_STAGES,
    OPEN_ORDER_STATUSES,
    derive_customer_stage,
    has_open_order,
    is_manual_customer_stage,
    normalize_manual_stage,
    validate_manual_stage,
)


def test_stage_vocabulary_is_exactly_three():
    assert CUSTOMER_STAGES == ("active", "inactive", "ordered")
    assert MANUAL_CUSTOMER_STAGES == ("active", "inactive")
    # 单据阶段不得出现在客户阶段里（用户明确要求两层分开）
    for legacy in ("lead", "inquiry", "quoted", "won", "lost"):
        assert legacy not in CUSTOMER_STAGES


def test_open_order_statuses_match_user_definition():
    assert OPEN_ORDER_STATUSES == ("pending", "confirmed", "producing", "shipped")
    # 完成/取消 = 关闭
    assert not has_open_order(["completed"])
    assert not has_open_order(["cancelled"])
    assert has_open_order(["pending"])
    assert has_open_order(["completed", "shipped"])


@pytest.mark.parametrize(
    "manual,has_open,expected",
    [
        ("active", False, "active"),
        ("inactive", False, "inactive"),
        # 有开启中的订单时一律「已下单」，手动沉寂也不能盖过（用户口径：订单优先）
        ("active", True, "ordered"),
        ("inactive", True, "ordered"),
    ],
)
def test_derive_customer_stage(manual, has_open, expected):
    assert derive_customer_stage(manual, has_open) == expected


@pytest.mark.parametrize(
    "legacy,expected",
    [
        ("lead", "active"),
        ("inquiry", "active"),
        ("quoted", "active"),
        ("won", "active"),
        ("inactive", "inactive"),
        ("lost", "inactive"),   # 流失并入沉寂：用户「沉寂就是关闭状态」
        (None, "active"),
        ("garbage", "active"),
    ],
)
def test_normalize_manual_stage_tolerates_legacy(legacy, expected):
    """代码先上线、迁移后跑时，旧值必须still能渲染成活跃/沉寂。"""
    assert normalize_manual_stage(legacy) == expected


def test_validate_manual_stage():
    assert validate_manual_stage("active") == (True, "")
    assert validate_manual_stage("inactive") == (True, "")
    ok, msg = validate_manual_stage("ordered")
    assert not ok and "自动推导" in msg
    ok, msg = validate_manual_stage("won")
    assert not ok and "单据阶段" in msg
    assert is_manual_customer_stage("active")
    assert not is_manual_customer_stage("ordered")
