"""收款容差（P1 · §E + UNCERTAIN #17 ③）—— `max(5 美分等值, 0.1%)` 判定。

裁决口径：
- 差额 ≤ 容差 → 自动核销（fx_rounding）；
- 差额 > 容差 → short_paid 告警；
- 无账期金额（手工登记）→ 不判定差额（manual）。
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from kaas_common.workstation.receipt_rules import (
    classify_receipt_diff,
    receipt_tolerance,
)

pytestmark = pytest.mark.unit


def test_小额收款_容差取绝对值5美分():
    # 100 USD × 0.1% = 0.1 > 0.05 → 取比例？不：max(0.05, 0.1) = 0.1
    assert receipt_tolerance("USD", 100) == Decimal("0.1")
    # 10 USD × 0.1% = 0.01 < 0.05 → 取 5 美分
    assert receipt_tolerance("USD", 10) == Decimal("0.05")


def test_大额收款_容差取比例0_1百分比():
    # 100000 USD × 0.1% = 100 > 0.05 → 取 100
    assert receipt_tolerance("USD", 100000) == Decimal("100.000")


def test_币种表_5美分等值换算():
    assert receipt_tolerance("CNY", 10) == Decimal("0.35")   # 5 美分≈0.35 元
    assert receipt_tolerance("JPY", 10) == Decimal("5")      # 日元零头量级不同
    assert receipt_tolerance("XXX", 10) == Decimal("0.05")   # 未知币种兜底


def test_容差内_自动核销_fx_rounding():
    # 账期 100，实收 99.95（差 0.05 ≤ 容差 0.1）→ 核销
    v = classify_receipt_diff(100, 99.95, "USD")
    assert v.auto_cleared is True
    assert v.diff_reason == "fx_rounding"
    assert v.diff == Decimal("-0.05")


def test_容差外_挂_short_paid():
    # 账期 100，实收 95（差 5 > 容差 0.1）→ short_paid
    v = classify_receipt_diff(100, 95, "USD")
    assert v.auto_cleared is False
    assert v.diff_reason == "short_paid"
    assert v.diff == Decimal("-5")


def test_无账期金额_手工登记不判定():
    v = classify_receipt_diff(None, 500, "USD")
    assert v.auto_cleared is True
    assert v.diff_reason == "manual"
    assert v.diff == Decimal("0")


def test_超收也算差额_按容差判定():
    # 账期 100，实收 100.03（差 0.03 ≤ 0.1）→ 核销；100.5（差 0.5 > 0.1）→ short_paid
    assert classify_receipt_diff(100, 100.03, "USD").auto_cleared is True
    assert classify_receipt_diff(100, 100.5, "USD").diff_reason == "short_paid"
