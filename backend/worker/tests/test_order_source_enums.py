"""订单来源 / 确认来源 / 渠道 值域（设计 OPTIMIZATION_PLAN_2026-10-22 §3.2 §4 §5.1）。

无数据库、无网络：只钉住 `kaas_common/domain/enums.py` 这份唯一清单，
确保它与迁移 `202610220004` 的 CHECK 约束逐字对齐 —— 否则前端下拉能选出
被数据库拒绝的值，用户看到的是「保存失败」而不是「这个选项不该有」。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from kaas_common.domain.enums import (  # noqa: E402
    ENUMS,
    INQUIRY_CHANNEL,
    ORDER_CHANNEL,
    ORDER_CONFIRM_SOURCE,
    ORDER_SOURCE_TYPE,
    validate_enum,
)


def test_order_source_type_matches_migration_check():
    """迁移 ck_orders_source_type: source_type IN ('inquiry','direct')。"""
    assert ORDER_SOURCE_TYPE == ("inquiry", "direct")
    assert ENUMS["order_source_type"] is ORDER_SOURCE_TYPE


def test_order_confirm_source_matches_migration_check():
    """迁移 ck_orders_confirm_source: manual / deposit_receipt（两者都是人工触发）。"""
    assert ORDER_CONFIRM_SOURCE == ("manual", "deposit_receipt")
    assert ENUMS["order_confirm_source"] is ORDER_CONFIRM_SOURCE


def test_channel_drops_quote_and_adds_phone_referral():
    """'quote' 是来源类型不是渠道（D-7）；线下电话单/转介绍单要有归位选项。"""
    assert "quote" not in INQUIRY_CHANNEL
    assert "phone" in INQUIRY_CHANNEL
    assert "referral" in INQUIRY_CHANNEL
    assert INQUIRY_CHANNEL[-1] == "other", "兜底值固定在末尾，前端下拉顺序稳定"


def test_order_channel_is_the_same_list_as_inquiry_channel():
    """渠道不因「是订单」而变：同一份清单，避免两处漂移。"""
    assert ORDER_CHANNEL is INQUIRY_CHANNEL
    assert ENUMS["source_channel"] is INQUIRY_CHANNEL


def test_validate_enum_accepts_new_values_and_rejects_quote_channel():
    assert validate_enum("order_source_type", "inquiry") == "inquiry"
    assert validate_enum("order_source_type", "direct") == "direct"
    assert validate_enum("order_confirm_source", "deposit_receipt") == "deposit_receipt"
    assert validate_enum("source_channel", "phone") == "phone"
    # 存量 'quote' 渠道已由迁移回填为 other，新写入必须拒。
    with pytest.raises(Exception) as exc:
        validate_enum("source_channel", "quote")
    assert "INVALID_ENUM" in str(exc.value)


def test_validate_enum_still_passes_none_through():
    """可空字段：source_channel 在 direct 单上允许为空（不伪造渠道）。"""
    assert validate_enum("source_channel", None) is None
