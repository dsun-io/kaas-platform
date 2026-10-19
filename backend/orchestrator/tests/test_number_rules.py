"""共享内核编号规则回归测试（P0：2026-10-19 手改编号 NameError）。

背景：`7b21e1d` 重写 `number_rules.py` 时丢了 `_NUMBER_RE` / `MAX_LEN` 定义，
但 `normalize_number()` 仍在引用 ⇒ 所有「手改编号」路径（询盘/报价/单证）
在 orchestrator 与 worker 两侧都会 NameError → 500。
本文件钉死编号校验的正反例，防止再次静默回归。
"""
from __future__ import annotations

import pytest

from kaas_common.workstation.number_rules import NumberError, normalize_number

pytestmark = pytest.mark.unit


def test_normalize_number_accepts_plain_and_chinese() -> None:
    assert normalize_number("INQ-1") == "INQ-1"
    assert normalize_number("  PI-US-TIM-20261018193045  ") == "PI-US-TIM-20261018193045"
    assert normalize_number("报价-张工") == "报价-张工"
    assert normalize_number("QUO/US/TIM/20261018") == "QUO/US/TIM/20261018"


@pytest.mark.parametrize("bad", ["", "   ", "含 空格", "line\nbreak", "tab\tchar"])
def test_normalize_number_rejects_blank_and_whitespace(bad: str) -> None:
    with pytest.raises(NumberError):
        normalize_number(bad)


def test_normalize_number_rejects_overlong() -> None:
    with pytest.raises(NumberError):
        normalize_number("A" * 65)
    assert len(normalize_number("A" * 64)) == 64


def test_normalize_number_rejects_control_chars() -> None:
    with pytest.raises(NumberError):
        normalize_number("INQ\x00-1")
