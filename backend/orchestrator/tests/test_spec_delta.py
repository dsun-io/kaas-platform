"""`services/export_quote/spec_delta.py` 的语义单测（**纯逻辑、无 DB、无 skip**）。

覆盖任务列出的 4 条硬语义 + 计划里承诺的两条"不冻住"用例：

1. **字段缺失** = 不覆盖（取上游）
2. **显式 `null`** = 取消覆盖（回落上游）
3. **字段改名** = 报错 / 显式映射（**不许静默退化**）
4. **列表三态**：缺失 / `null` / `[]` 语义各不相同
5. **未知 key** = 报错（不许静默忽略）
6. 上游改了**未被覆盖**的字段 ⇒ **跟着变**（Q7 允许团队 key 重名的前提）
7. 覆盖之后上游再改 ⇒ **被覆盖字段不变**（这正是"不冻住"的定义）

外加导出契约的边界：身份字段禁改、版本闸门、哈希闸门、add/remove 冲突、选项层复用。
"""
from __future__ import annotations

import pytest

from app.services.export_quote.models import ProductSpec, VariantGroup
from app.services.export_quote.spec_delta import (
    SPEC_DELTA_VERSION,
    DeltaReport,
    SpecDeltaError,
    apply_delta,
    item_identity,
    normalize_delta,
    spec_fingerprint,
)

# 纯逻辑、无外部服务 ⇒ 必须进 `-m unit` 门禁（否则会被 `-m unit` 静默排除，等于没测）
pytestmark = pytest.mark.unit


# ── 夹具：一个"上游系统级 spec"的 dict 形态 ──────────────────────────────────

def _upstream() -> dict:
    return {
        "key": "field_fence",
        "name": "牛栏网",
        "name_en": "Field Fence",
        "category_code": "niulanwang",
        "cost_field": "raw_price",
        "cost_basis": "pretax",
        "cost_unit": "CNY/kg",
        "constants": {"packing": "无包装", "wire_factor": "1.28"},
        "axes": [],
        "variants": [
            {
                "name": "coating",
                "label": "表面处理",
                "label_en": "Coating",
                "options": [
                    {"code": "zinc_40", "name": "普锌40g/㎡"},
                    {"code": "pvc_black", "name": "PVC 黑色"},
                ],
            }
        ],
        "derived": [
            {"name": "weight_base_kg", "expr": "d*d*1.28", "unit": "kg"},
        ],
        "columns": [
            {"key": "price_per_piece", "label": "单件价"},
        ],
        "invariants": [
            {"name": "total_eq", "expr": "a == b", "severity": "error"},
        ],
        "space_deduction": {"mode": "ratio", "value": 0.04, "range": None, "expr": "", "note": ""},
        "pricing_key": [{"field": "d", "label": "丝径"}],
        "notes": ["上游说明"],
        "hs_codes": ["7314410000"],
        "profit_mode": "margin_on_price",
        "profit_value": 0.06,
        "misc_fee_rate": 0.03,
    }


# ── 1. 字段缺失 = 不覆盖 ────────────────────────────────────────────────────

class TestMissingMeansNoOverride:
    def test_空载荷_原样返回且报告为空(self):
        base = _upstream()
        merged, report = apply_delta(base, None)
        assert merged == base
        assert report.is_empty
        assert report.warnings() == []

    def test_只写一个标量_其它字段保持上游(self):
        base = _upstream()
        merged, report = apply_delta(base, {"scalars": {"profit_value": 0.08}})
        assert merged["profit_value"] == 0.08
        assert merged["name"] == "牛栏网"          # 未提 ⇒ 上游
        assert merged["cost_unit"] == "CNY/kg"     # 未提 ⇒ 上游
        assert report.scalars_applied == {"profit_value": 0.08}
        assert report.cleared == ()

    def test_不修改入参(self):
        base = _upstream()
        delta = {"scalars": {"name": "牛栏网（联佳）"}, "lists": {"notes": ["覆盖"]}}
        before = repr(base), repr(delta)
        apply_delta(base, delta)
        assert (repr(base), repr(delta)) == before


# ── 2. 显式 null = 取消覆盖（回落上游）──────────────────────────────────────

class TestExplicitNullCancelsOverride:
    def test_标量传null_回落上游(self):
        base = _upstream()
        merged, report = apply_delta(base, {"scalars": {"profit_value": None}})
        assert merged["profit_value"] == base["profit_value"]
        assert report.cleared == ("profit_value",)

    def test_列表传null_回落上游(self):
        base = _upstream()
        merged, report = apply_delta(base, {"lists": {"notes": None}})
        assert merged["notes"] == ["上游说明"]
        assert report.cleared == ("notes",)

    def test_结构化字段传null_回落上游(self):
        base = _upstream()
        merged, report = apply_delta(base, {"structs": {"space_deduction": None}})
        assert merged["space_deduction"] == base["space_deduction"]
        assert report.cleared == ("space_deduction",)


# ── 3. 字段改名：报错 / 显式映射（不许静默退化）─────────────────────────────

class TestRenamedFieldMustNotDegradeSilently:
    def test_未知字段直接报错_并列出已知字段(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"scalars": {"display_name": "想改名字"}})
        msg = str(ei.value)
        assert "display_name" in msg
        assert "name" in msg                      # 已知字段被列出来
        assert "field_aliases" in msg             # 并指明显式映射的出路

    def test_显式alias可用_且留痕(self):
        delta = {"scalars": {"display_name": "牛栏网（联佳）"}}
        merged, report = apply_delta(
            _upstream(), delta, field_aliases={"display_name": "name"})
        assert merged["name"] == "牛栏网（联佳）"
        assert report.aliases_used == {"display_name": "name"}

    def test_上游结构改名_报错而不是静默丢包(self):
        # 假设上游把 variants 的条目结构改了（多了个不认识的键）
        base = _upstream()
        base["variants"] = [{"name": "coating", "options": [], "extra_new_key": 1}]
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(base, {"options": {"coating": {"disabled": ["zinc_40"]}}})
        assert "VariantGroup" in str(ei.value)

    def test_身份字段key禁止覆盖(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"scalars": {"key": "hacked"}})
        assert "身份字段" in str(ei.value)


# ── 4. 列表三态：缺失 / null / [] ───────────────────────────────────────────

class TestListThreeStates:
    def test_缺失_不覆盖(self):
        base = _upstream()
        merged, report = apply_delta(base, {"scalars": {"name": "X"}})
        assert merged["notes"] == ["上游说明"]
        assert "notes" not in report.lists_replaced

    def test_显式空数组_是清空而不是未覆盖(self):
        merged, report = apply_delta(_upstream(), {"lists": {"notes": []}})
        assert merged["notes"] == []
        assert report.lists_replaced == {"notes": 0}
        assert report.cleared == ()               # 清空 ≠ 取消覆盖

    def test_null_是取消覆盖而不是清空(self):
        merged, report = apply_delta(_upstream(), {"lists": {"notes": None}})
        assert merged["notes"] == ["上游说明"]     # 回上游，不是空
        assert report.cleared == ("notes",)
        assert report.lists_replaced == {}

    def test_三态互不相同(self):
        base = _upstream()
        missing, _ = apply_delta(base, {})
        cleared, _ = apply_delta(base, {"lists": {"notes": None}})
        emptied, _ = apply_delta(base, {"lists": {"notes": []}})
        assert missing["notes"] == ["上游说明"]
        assert cleared["notes"] == ["上游说明"]
        assert emptied["notes"] == []
        assert missing["notes"] != emptied["notes"]

    def test_整体替换会替换整份列表(self):
        merged, report = apply_delta(
            _upstream(), {"lists": {"derived": [{"name": "only_one", "expr": "1"}]}})
        assert [d["name"] for d in merged["derived"]] == ["only_one"]
        assert report.lists_replaced == {"derived": 1}

    def test_列表非数组非null_报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"lists": {"notes": "上游说明"}})
        assert "add" in str(ei.value) and "remove" in str(ei.value)


# ── 5. 未知 key 不许静默忽略 ────────────────────────────────────────────────

class TestUnknownKeysNeverIgnored:
    def test_未知顶层键报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"scalrs": {"name": "typo"}})
        assert "scalrs" in str(ei.value)

    def test_未知顶层键_在normalize阶段就报错(self):
        with pytest.raises(SpecDeltaError):
            normalize_delta({"whatever": 1})

    def test_标量里塞列表字段_报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"scalars": {"derived": []}})
        assert "lists" in str(ei.value)

    def test_列表里塞标量字段_报错(self):
        with pytest.raises(SpecDeltaError):
            apply_delta(_upstream(), {"lists": {"name": []}})

    def test_未知spec_version报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"spec_version": 99, "scalars": {"name": "X"}})
        assert "spec_version" in str(ei.value)

    def test_选项层未知键报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"options": {"coating": {"renmae": {}}}})
        assert "renmae" in str(ei.value)


# ── 6. 上游改了未覆盖字段 ⇒ 跟着变（"不冻住"的前提）────────────────────────

class TestUpstreamChangesPropagateWhenNotOverridden:
    def test_上游改公式_未覆盖的团队跟着变(self):
        delta = {"scalars": {"profit_value": 0.08}}      # 只覆盖利润率

        up1 = _upstream()
        up1["derived"] = [{"name": "weight_base_kg", "expr": "OLD", "unit": "kg"}]
        merged1, _ = apply_delta(up1, delta)

        up2 = _upstream()
        up2["derived"] = [{"name": "weight_base_kg", "expr": "NEW", "unit": "kg"}]
        merged2, _ = apply_delta(up2, delta)

        assert merged1["derived"][0]["expr"] == "OLD"
        assert merged2["derived"][0]["expr"] == "NEW"     # ← 上游改了，生效
        assert merged1["profit_value"] == merged2["profit_value"] == 0.08

    def test_上游加了一条公式_未覆盖的团队也看得到(self):
        delta = {"scalars": {"name": "牛栏网（联佳）"}}
        up = _upstream()
        up["derived"].append({"name": "volume_m3", "expr": "x*y", "unit": "m3"})
        merged, _ = apply_delta(up, delta)
        assert [d["name"] for d in merged["derived"]] == ["weight_base_kg", "volume_m3"]

    def test_团队自建key与系统级重名_差异仍按上游合并(self):
        """Q7 允许重名：团队自建的行有自己的 key，但差异是**按上游 spec**套的。"""
        delta = {"scalars": {"name": "团队私有牛栏网"}}
        merged, _ = apply_delta(_upstream(), delta)
        assert merged["key"] == "field_fence"        # 上游 key 不动
        assert merged["name"] == "团队私有牛栏网"


# ── 7. 覆盖之后上游再改 ⇒ 被覆盖字段不变（"不冻住"的定义）──────────────────

class TestOverriddenFieldsStayPinned:
    def test_被覆盖的标量不随上游变(self):
        delta = {"scalars": {"profit_value": 0.08, "misc_fee_rate": 0.01}}

        up1 = _upstream()
        up1["profit_value"], up1["misc_fee_rate"] = 0.06, 0.03
        merged1, _ = apply_delta(up1, delta)

        up2 = _upstream()
        up2["profit_value"], up2["misc_fee_rate"] = 0.12, 0.05   # 上游改了
        merged2, _ = apply_delta(up2, delta)

        assert merged1["profit_value"] == merged2["profit_value"] == 0.08
        assert merged1["misc_fee_rate"] == merged2["misc_fee_rate"] == 0.01

    def test_被整体覆盖的列表不随上游变(self):
        delta = {"lists": {"notes": ["团队自己的说明"]}}
        up = _upstream()
        up["notes"] = ["上游改过的说明"]
        merged, _ = apply_delta(up, delta)
        assert merged["notes"] == ["团队自己的说明"]

    def test_取消覆盖之后又跟着上游变(self):
        """先覆盖、后**取消覆盖**（传 null）⇒ 重新跟随上游。"""
        up1 = _upstream()
        up1["notes"] = ["上游 A"]
        # 覆盖
        pinned, _ = apply_delta(up1, {"lists": {"notes": ["团队"]}})
        assert pinned["notes"] == ["团队"]
        # 取消覆盖（null）⇒ 回上游
        up2 = _upstream()
        up2["notes"] = ["上游 B"]
        back, report = apply_delta(up2, {"lists": {"notes": None}})
        assert back["notes"] == ["上游 B"]
        assert report.cleared == ("notes",)


# ── 8. add / remove / 选项层 / 哈希闸门 ─────────────────────────────────────

class TestAddRemoveAndOptions:
    def test_remove_按身份删除(self):
        merged, report = apply_delta(
            _upstream(), {"remove": {"columns": ["price_per_piece"]}})
        assert merged["columns"] == []
        assert report.removed == {"columns": 1}
        assert report.missing_removals == ()
        assert report.warnings() == []

    def test_remove_指向不存在的条目_是warning不是静默(self):
        merged, report = apply_delta(
            _upstream(), {"remove": {"columns": ["no_such_column"]}})
        assert merged["columns"] == _upstream()["columns"]   # 幂等 no-op
        assert report.removed == {"columns": 0}
        assert report.missing_removals == ("columns[no_such_column]",)
        assert "no_such_column" in report.warnings()[0]

    def test_add_追加到末尾(self):
        merged, report = apply_delta(_upstream(), {
            "add": {"invariants": [{"name": "extra", "expr": "x > 0", "severity": "warning"}]}})
        assert [i["name"] for i in merged["invariants"]] == ["total_eq", "extra"]
        assert report.added == {"invariants": 1}

    def test_add_身份已存在_报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"add": {"invariants": [{"name": "total_eq", "expr": "x"}]}})
        assert "已存在" in str(ei.value)

    def test_同一字段既整体替换又增删_报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {
                "lists": {"notes": ["a"]}, "add": {"notes": ["b"]}})
        assert "同一字段" in str(ei.value)

    def test_条目没有key也没有name_报错(self):
        with pytest.raises(SpecDeltaError):
            item_identity({"expr": "没有身份"})

    def test_选项层_改显示名不改code(self):
        merged, report = apply_delta(_upstream(), {
            "options": {"coating": {"rename": {"zinc_40": "40克锌层"}}}})
        opts = {o["code"]: o for o in merged["variants"][0]["options"]}
        assert opts["zinc_40"]["name"] == "40克锌层"      # 显示名改了
        assert opts["zinc_40"]["code"] == "zinc_40"      # code 一字未动
        assert opts["pvc_black"]["name"] == "PVC 黑色"
        assert report.options_applied == ("coating",)

    def test_选项层_停用是标记不是移除(self):
        merged, report = apply_delta(_upstream(), {
            "options": {"coating": {"disabled": ["pvc_black"]}}})
        opts = {o["code"]: o for o in merged["variants"][0]["options"]}
        assert set(opts) == {"zinc_40", "pvc_black"}     # 一条都没少
        assert opts["pvc_black"]["disabled"] is True
        assert "disabled" not in opts["zinc_40"]

    def test_选项层_改名为空串等于取消改名(self):
        merged, report = apply_delta(_upstream(), {
            "options": {"coating": {"rename": {"zinc_40": ""}}}})
        opts = {o["code"]: o for o in merged["variants"][0]["options"]}
        assert opts["zinc_40"]["name"] == "普锌40g/㎡"      # 回到上游写法
        assert report.options_applied == ()               # 空指令 ⇒ 不算生效

    def test_哈希匹配才允许合并(self):
        base = _upstream()
        good = spec_fingerprint(base)
        merged, _ = apply_delta(base, {
            "base_spec_hash": good, "scalars": {"name": "X"}})
        assert merged["name"] == "X"

    def test_哈希不匹配_拒绝合并并说明原因(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {
                "base_spec_hash": "sha256:0000", "scalars": {"name": "X"}})
        msg = str(ei.value)
        assert "上游已变更" in msg and "人工复核" in msg

    def test_指纹与字段书写顺序无关(self):
        a = {"key": "k", "name": "n", "profit_value": 0.06}
        b = {"profit_value": 0.06, "name": "n", "key": "k"}
        assert spec_fingerprint(a) == spec_fingerprint(b)

    def test_报告里带版本号(self):
        _, report = apply_delta(_upstream(), {"scalars": {"name": "X"}})
        assert isinstance(report, DeltaReport)
        assert report.version == SPEC_DELTA_VERSION


# ── 9. 与线上实现同源（选项层复用 apply_option_overrides）────────────────────

class TestReusesLiveImplementation:
    def test_选项层结果与线上实现一致(self):
        from app.services.export_quote.models import apply_option_overrides

        overrides = {"coating": {"rename": {"zinc_40": "40克锌层"},
                                 "disabled": ["pvc_black"]}}
        base = _upstream()
        via_delta, _ = apply_delta(base, {"options": overrides})

        spec = ProductSpec(
            key="field_fence",
            variants=[VariantGroup(**base["variants"][0])],
        )
        expected = apply_option_overrides(spec, overrides)
        got = via_delta["variants"][0]
        assert got["name"] == expected.variants[0].name
        assert list(got["options"]) == [
            {"code": "zinc_40", "name": "40克锌层"},
            {"code": "pvc_black", "name": "PVC 黑色", "disabled": True},
        ]
