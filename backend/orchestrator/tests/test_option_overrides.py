"""团队级档位覆盖：改显示名 / 软停用（#2b）。

粒度是**团队**（2026-10-11 用户裁决）：档位 = 公司能做什么，不该因买家而异。
成本价相反，仍是买家客户级，本文件不涉及。

这里测的是**纯函数**部分（不碰数据库）—— 逻辑都在那里：
  · `apply_option_overrides` 改名 + 标记停用
  · `visible_options` 给界面用的过滤
  · `describe_space` / `describe_pricing_key` 必须跟着滤
  · `normalize_overrides` / `merge_override` 载荷收敛与增量修改
"""
from decimal import Decimal

import pytest

from app.services.export_quote.engine import EngineError, spec_from_partial
from app.services.export_quote.formulas import describe_pricing_key, describe_space
from app.services.export_quote.models import (
    apply_option_overrides,
    visible_options,
)
from app.services.export_quote.products import get
from app.services.option_overrides import merge_override, normalize_overrides

pytestmark = pytest.mark.unit

OVERRIDES = {
    "coating_code": {
        "rename": {"zinc_40": "40克锌层"},
        "disabled": ["pvc_black"],
    }
}


def _coating_options(product):
    return [o for v in product.variants if v.name == "coating" for o in v.options]


class TestRename:
    def test_renames_only_the_display_name(self):
        product = apply_option_overrides(get("field_fence"), OVERRIDES)
        first = _coating_options(product)[0]
        assert first["name"] == "40克锌层"
        # **code 绝不能改** —— 它是查价键的一半，一改历史定价数据就对不上
        assert first["code"] == "zinc_40"

    def test_pricing_key_still_uses_code(self):
        product = apply_option_overrides(get("field_fence"), OVERRIDES)
        dim = next(d for d in describe_pricing_key(product)
                   if d["field"] == "coating_code")
        assert dim["options"][0]["value"] == "zinc_40", "查价键必须仍用 code"

    def test_engine_still_resolves_by_the_untouched_code(self):
        product = apply_option_overrides(get("field_fence"), OVERRIDES)
        picked = spec_from_partial(product, {
            "de": 2.0, "height_m": 1.2, "mesh_mm": 100, "coating_code": "zinc_40",
            "wave": "无波款",
        }, 1)
        assert picked["coating_code"] == "zinc_40"


class TestSoftDisable:
    def test_disabled_option_is_marked_not_removed(self):
        product = apply_option_overrides(get("field_fence"), OVERRIDES)
        opts = {o["code"]: o for o in _coating_options(product)}
        assert "pvc_black" in opts, "必须**留在 options 里**，否则历史报价单解析不了"
        assert opts["pvc_black"]["disabled"] is True

    def test_engine_can_still_resolve_a_disabled_option(self):
        """**这条是软停用的核心**：停用只影响展示，不影响解析。

        否则已引用该档位的历史报价单重算会直接报「无法识别的取值」。
        """
        product = apply_option_overrides(get("field_fence"), OVERRIDES)
        picked = spec_from_partial(product, {
            "de": 2.0, "height_m": 1.2, "mesh_mm": 100,
            "coating_code": "pvc_black", "wave": "无波款",
        }, 1)
        assert picked["coating_code"] == "pvc_black"

    def test_hidden_from_the_ui_清单s(self):
        product = apply_option_overrides(get("field_fence"), OVERRIDES)
        space = describe_space(product)
        coating = next(v for v in space["variants"] if v["name"] == "coating")
        names = [o["value"] for o in coating["options"]]
        assert "PVC涂塑(黑色)" not in names
        assert "40克锌层" in names

        dim = next(d for d in describe_pricing_key(product)
                   if d["field"] == "coating_code")
        codes = [o["value"] for o in dim["options"]]
        assert "pvc_black" not in codes, "定价矩阵也不该再提供停用档位"

    def test_visible_options_helper(self):
        opts = [{"name": "a"}, {"name": "b", "disabled": True}]
        assert [o["name"] for o in visible_options(opts)] == ["a"]


class TestNoOverrideIsANoOp:
    def test_empty_overrides_return_the_same_product(self):
        product = get("field_fence")
        assert apply_option_overrides(product, None) is product
        assert apply_option_overrides(product, {}) is product

    def test_unknown_field_is_ignored(self):
        product = get("field_fence")
        assert apply_option_overrides(product, {"不存在的维": {"disabled": ["x"]}}) is product


class TestPayloadNormalisation:
    def test_only_rename_and_disabled_survive(self):
        raw = {"coating_code": {"rename": {"a": "b"}, "disabled": ["c"],
                                "乱键": 1, "金额": None}}
        assert normalize_overrides(raw) == {
            "coating_code": {"rename": {"a": "b"}, "disabled": ["c"]}}

    def test_garbage_is_dropped(self):
        assert normalize_overrides(None) == {}
        assert normalize_overrides({"x": "不是字典"}) == {}
        assert normalize_overrides({"x": {}}) == {}

    def test_merge_adds_disable_and_clears_rename(self):
        merged = merge_override(OVERRIDES, "coating_code",
                                disable=["elec_galv"], rename={"zinc_40": ""})
        entry = merged["coating_code"]
        assert entry["disabled"] == ["pvc_black", "elec_galv"]
        assert "rename" not in entry, "显示名传空串 = 取消改名"

    def test_merge_can_re_enable(self):
        merged = merge_override(OVERRIDES, "coating_code", enable=["pvc_black"])
        assert "disabled" not in merged["coating_code"]

    def test_merge_does_not_mutate_input(self):
        before = {"coating_code": {"disabled": ["a"]}}
        snapshot = {"coating_code": {"disabled": ["a"]}}
        merge_override(before, "coating_code", disable=["b"])
        assert before == snapshot
