from __future__ import annotations

import sys
from pathlib import Path

# S4（2026-10-19）：报价引擎真源已迁到 backend/kaas_common/export_quote；
# 本文件从 orchestrator 测试迁来，仅重定向 import，断言不变。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

"""P13 差异读路径接线：`effective_spec.py` 语义测试（纯逻辑、无 DB、无 skip）。

验收信号（IMPL_PLAN P13）：
- 改上游公式后，未设差异的团队跟着变；
- 设了差异的团队：未被差异覆盖的部分也跟着变（"不冻住"）；
- `base_spec_hash` 不匹配 ⇒ 拒绝合并。
"""

import pytest

pytestmark = pytest.mark.unit

from kaas_common.export_quote.effective_spec import (
    SpecUpstreamChanged,
    assert_base_hash_match,
    resolve_effective_product,
)
from kaas_common.export_quote.spec_delta import SpecDeltaError, spec_fingerprint


def _base_dict() -> dict:
    """一个足够真实的 ProductSpec dict 形态（field_fence 简化版）。"""
    return {
        "key": "field_fence",
        "name": "牛栏网",
        "name_en": "",
        "category_code": "",
        "cost_field": "raw_price",
        "cost_basis": "pretax",
        "cost_unit": "",
        "constants": {},
        "axes": [],
        "variants": [],
        "derived": [
            {"name": "weight_base_kg", "expr": "1.0", "label": "基础重量"},
        ],
        "space_deduction": {},
        "piece_metrics": [],
        "order_metrics": [],
        "columns": [],
        "invariants": [],
        "pricing_key": ["mesh", "wire_dia"],
        "notes": [],
        "hs_codes": [],
        "profit_mode": "margin_on_price",
        "profit_value": 0.06,
        "misc_fee_rate": 0.03,
    }


class TestResolveEffectiveProduct:
    def test_无基线返回None_产品不存在(self):
        spec, warnings = resolve_effective_product(None, None)
        assert spec is None
        assert warnings == []

    def test_基线无差异_原样返回_跟着变(self):
        base = _base_dict()
        spec, warnings = resolve_effective_product(base, None)
        assert spec is not None
        assert spec.key == "field_fence"
        assert warnings == []

    def test_基线空差异_同None(self):
        base = _base_dict()
        spec, warnings = resolve_effective_product(base, {})
        assert spec is not None
        assert warnings == []

    def test_设了差异_覆盖部分变化_未覆盖部分跟着变(self):
        base = _base_dict()
        delta = {
            "spec_version": 1,
            "scalars": {"name": "定制牛栏网"},
        }
        spec, warnings = resolve_effective_product(base, delta)
        assert spec is not None
        assert spec.name == "定制牛栏网"  # 差异覆盖
        assert spec.key == "field_fence"   # 未覆盖部分跟着变
        assert len(spec.derived) == 1      # 未覆盖
        assert spec.derived[0].name == "weight_base_kg"

    def test_改上游公式后_未设差异的团队跟着变(self):
        """上游改了 derived 表达式 ⇒ 无差异时直接反映。"""
        base = _base_dict()
        base["derived"] = [
            {"name": "weight_base_kg", "expr": "2.0", "label": "新重量"},
        ]
        spec, _ = resolve_effective_product(base, None)
        assert spec.derived[0].expr == "2.0"

    def test_设了差异后_上游改未覆盖字段_跟着变(self):
        """设了 name 覆盖，但 derived 改了 ⇒ derived 跟着变。"""
        base = _base_dict()
        base["derived"] = [
            {"name": "weight_base_kg", "expr": "2.0", "label": "新重量"},
        ]
        delta = {
            "spec_version": 1,
            "scalars": {"name": "定制牛栏网"},
        }
        spec, _ = resolve_effective_product(base, delta)
        assert spec.name == "定制牛栏网"
        assert spec.derived[0].expr == "2.0"  # 上游改了，差异没覆盖 ⇒ 跟着变


class TestAssertBaseHashMatch:
    def test_无差异_不抛(self):
        assert_base_hash_match(_base_dict(), None)

    def test_空差异_不抛(self):
        assert_base_hash_match(_base_dict(), {})

    def test_hash匹配_不抛(self):
        base = _base_dict()
        delta = {
            "spec_version": 1,
            "base_spec_hash": spec_fingerprint(base),
            "scalars": {"name": "x"},
        }
        assert_base_hash_match(base, delta)

    def test_hash不匹配_抛SpecUpstreamChanged(self):
        base = _base_dict()
        delta = {
            "spec_version": 1,
            "base_spec_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "scalars": {"name": "x"},
        }
        with pytest.raises(SpecUpstreamChanged) as ei:
            assert_base_hash_match(base, delta)
        assert "上游已变更" in str(ei.value)