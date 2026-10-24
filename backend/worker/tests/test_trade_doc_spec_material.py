"""单证行项材质并入 Specification 文本（2026-10-24 用户裁决）—— 纯函数，无 DB/网络。

背景：报价行把材质写进 `spec_snapshot.material`（frontend line-to-item.ts:280），
但单证装配 `payload_shared.item_from_source` 的 `_spec_to_text` 原先只取
specification/spec/size/mesh/wire_diameter/height/length ⇒ 单证模板不显示材质。
用户裁决：并入 Specification 文本末尾（英文单据口径 `Material: <值>`），
**不新增列/字段**，不改 render.ts。

钉住：
1. 有 material ⇒ `items[0].specification` 以 ", Material: 低碳钢丝" 结尾；
2. 无 material ⇒ 输出与旧版逐字一致（回归基线）；
3. material 为空串/纯空白/None ⇒ 不追加；
4. spec_snapshot 为 str/None/非 dict ⇒ 行为不变。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402

from kaas_common.trade_doc.payload_shared import build_render_data  # noqa: E402


def _render(spec_snapshot):
    """走上游快照 → 渲染数据的真实装配路径（quote/order 任一 sources 同口径）。"""
    return build_render_data(
        doc_type="pi", doc_no="PI-1", doc_status="draft", currency="USD",
        total_amount=100,
        sources={"quote": {"items": [{
            "product_name": "Chain Link Fence", "qty": 1, "unit_price": 100,
            "line_amount": 100, "spec_snapshot": spec_snapshot,
        }]}},
    )


def test_material_appended_to_specification_tail():
    data = _render({"specification": "2m x 25m", "material": "低碳钢丝"})
    spec = data["items"][0]["specification"]
    assert spec == "2m x 25m, Material: 低碳钢丝"
    assert spec.endswith(", Material: 低碳钢丝")


def test_without_material_output_unchanged():
    """既有口径：无 material 时逐字保持旧输出（parts 顺序 + 逗号分隔）。"""
    data = _render({"specification": "2m x 25m", "size": "2m", "material": None})
    assert data["items"][0]["specification"] == "2m x 25m, 2m"


@pytest.mark.parametrize("material", ["", "   ", None])
def test_blank_material_not_appended(material):
    data = _render({"specification": "2m x 25m", "material": material})
    assert data["items"][0]["specification"] == "2m x 25m"


def test_non_dict_spec_snapshot_behaviour_unchanged():
    for snapshot, expected in [("2m x 25m", "2m x 25m"), (None, None)]:
        data = _render(snapshot)
        assert data["items"][0].get("specification") == expected


def test_material_appended_after_legacy_fallback_parts():
    """没有可识别规格键时旧兜底逐键输出不变，Material 仍追加在末尾。"""
    data = _render({"product_key": "field_fence", "material": "低碳钢丝"})
    assert data["items"][0]["specification"] == (
        "product_key: field_fence, Material: 低碳钢丝"
    )
