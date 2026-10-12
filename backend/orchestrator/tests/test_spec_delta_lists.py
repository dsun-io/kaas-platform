"""§8.5 标量列表缺口修复 —— `notes` / `hs_codes` 的 `add`/`remove` 语义（task-9）。

缺口回顾
========

`notes` / `hs_codes` 是**标量列表**（元素是字符串），而 `item_identity()` 要求
条目是带 `key`/`name` 的对象 ⇒ 对它们做 `add`/`remove` 以前**直接抛
`SpecDeltaError`**（"列表条目必须是对象（dict）"），报错文案没说清"这两个字段
不支持按条增删" ⇒ 体验缺口（`PRODUCT_MODULE_IMPL_PLAN.md` §8.5）。

本轮修复（用户已批准扩范围到引擎包）：**修法②** —— 仍在 `add`/`remove` 阶段
**报错**（不静默、不按值增删），但报错文案**明确说明**：

    这两个字段仅支持整体替换（`lists.<字段>`，含 `[]` 清空 / `null` 取消覆盖），
    不支持按条目增删。

为什么选②而不是①（按值增删 + warning 语义）
--------------------------------------------

- **不破坏既有 42 条测试**（`test_spec_delta.py` 的列表三态：缺失 / `null` / `[]`
  互不相同）—— 整体替换语义一行未动。
- 标量元素没有 `key`/`name` 身份 ⇒ 按值增删天然有歧义（同值重复元素删哪个？
  `remove` miss 是 warning 还是 error？），会引入一整套新契约与测试面。
- **报错已经满足"不静默"**；本修复只把**文案**从"看不懂"改成"说清楚"，
  语义边界（报错 vs warning）保持不变 ⇒ 最小、可证、零回归。

本文件覆盖的新语义（7 条）
========================

1. `add.notes` / `add.hs_codes` ⇒ `SpecDeltaError`，文案含"不支持按条目增删" +
   "仅支持整体替换" + 指引 `lists.<字段>`。
2. `remove.notes` / `remove.hs_codes` ⇒ 同上（与 `add` 同文案）。
3. 报错在 **normalize 阶段**就抛（`normalize_delta` 直接调用即可复现，不必等
   `apply_delta`）⇒ 非法载荷越早拒绝越好。
4. 整体替换路径**完全不受影响**：`lists.notes` / `lists.hs_codes` 的三态
   （缺失 / `null` / `[]`）与修复前逐字一致。
5. dict 列表（`columns` 等）的 `add`/`remove` 行为**逐字不变**（含 remove-miss
   ⇒ warning 的既有契约）。
6. 文案对两个字段**逐字一致**（只是字段名不同），不含"尽力而为"的模糊话术。
7. `lists.<标量字段>` 传非数组非 null 时，报错文案不再误导"想按条目增删请用
   `add`/`remove`"，改为说明"只支持整体替换"。
"""
from __future__ import annotations

import pytest

from app.services.export_quote.spec_delta import (
    SCALAR_LIST_FIELDS,
    SpecDeltaError,
    apply_delta,
    normalize_delta,
)

pytestmark = pytest.mark.unit


def _upstream() -> dict:
    return {
        "key": "field_fence",
        "name": "牛栏网",
        "columns": [{"key": "price_per_piece", "label": "单件价"}],
        "notes": ["上游说明", "第二条说明"],
        "hs_codes": ["7314410000", "7314420000"],
        "profit_value": 0.06,
    }


# ── 1. add 对标量列表：报错且文案说清"不支持按条增删 + 仅支持整体替换" ────────

class TestScalarListAddRejectsWithClearMessage:
    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_add_报错_文案说明不支持按条增删(self, field):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"add": {field: ["新增一条"]}})
        msg = str(ei.value)
        assert "不支持按条目增删" in msg, msg
        assert field in msg, msg

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_add_报错_文案指明仅支持整体替换并给出lists写法(self, field):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"add": {field: ["新增一条"]}})
        msg = str(ei.value)
        assert "仅支持整体替换" in msg, msg
        assert f"`lists.{field}`" in msg, msg

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_add_报错_文案说明标量没有key_name身份(self, field):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"add": {field: ["新增一条"]}})
        msg = str(ei.value)
        assert "标量列表" in msg, msg
        assert "key/name" in msg, msg

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_add_报错_文案同时讲清清空与取消的写法(self, field):
        """整体替换的三态要在报错里一次说全，别让用户再猜第二轮。"""
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"add": {field: ["新增一条"]}})
        msg = str(ei.value)
        assert "`[]`" in msg and "`null`" in msg, msg


# ── 2. remove 对标量列表：与 add 同一套文案 ─────────────────────────────────

class TestScalarListRemoveRejectsWithClearMessage:
    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_remove_报错_文案说明不支持按条增删(self, field):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"remove": {field: ["上游说明"]}})
        msg = str(ei.value)
        assert "不支持按条目增删" in msg, msg
        assert f"`remove.{field}`" in msg, msg

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_remove_报错_文案指明仅支持整体替换(self, field):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"remove": {field: ["上游说明"]}})
        msg = str(ei.value)
        assert "仅支持整体替换" in msg, msg
        assert f"`lists.{field}`" in msg, msg

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_add与remove的文案逐字同构(self, field):
        """两条路径给同一套指引 —— 不许出现"add 能删、remove 不能"之类分叉。"""
        with pytest.raises(SpecDeltaError) as ei_add:
            apply_delta(_upstream(), {"add": {field: ["x"]}})
        with pytest.raises(SpecDeltaError) as ei_rm:
            apply_delta(_upstream(), {"remove": {field: ["x"]}})
        tail_add = str(ei_add.value).split(f"`add.{field}`", 1)[1]
        tail_rm = str(ei_rm.value).split(f"`remove.{field}`", 1)[1]
        assert tail_add == tail_rm, (tail_add, tail_rm)


# ── 3. 报错在 normalize 阶段就抛（非法载荷尽早拒绝）──────────────────────────

class TestRejectedAtNormalizeStage:
    @pytest.mark.parametrize("op", ["add", "remove"])
    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_normalize_delta_直接抛错(self, op, field):
        with pytest.raises(SpecDeltaError) as ei:
            normalize_delta({op: {field: ["x"]}})
        assert "不支持按条目增删" in str(ei.value)

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_报错发生在触碰base之前(self, field):
        """错误载荷不该先改 base 再报错 —— 拒绝必须是纯粹的前置校验。"""
        base = _upstream()
        before = repr(base)
        with pytest.raises(SpecDeltaError):
            apply_delta(base, {"add": {field: ["x"]}})
        assert repr(base) == before


# ── 4. 整体替换路径完全不受影响（列表三态逐字不变）───────────────────────────

class TestWholeReplaceUnaffected:
    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_缺失_不覆盖(self, field):
        merged, report = apply_delta(_upstream(), {"scalars": {"name": "X"}})
        assert merged[field] == _upstream()[field]
        assert field not in report.lists_replaced

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_显式空数组_是清空(self, field):
        merged, report = apply_delta(_upstream(), {"lists": {field: []}})
        assert merged[field] == []
        assert report.lists_replaced == {field: 0}
        assert report.cleared == ()

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_null_是取消覆盖并回落上游(self, field):
        merged, report = apply_delta(_upstream(), {"lists": {field: None}})
        assert merged[field] == _upstream()[field]
        assert report.cleared == (field,)
        assert report.lists_replaced == {}

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_三态互不相同(self, field):
        base = _upstream()
        missing, _ = apply_delta(base, {})
        cleared, _ = apply_delta(base, {"lists": {field: None}})
        emptied, _ = apply_delta(base, {"lists": {field: []}})
        assert missing[field] == cleared[field] == _upstream()[field]
        assert emptied[field] == []
        assert missing[field] != emptied[field]

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_整体替换替换成新列表(self, field):
        merged, report = apply_delta(_upstream(), {"lists": {field: ["团队自己的"]}})
        assert merged[field] == ["团队自己的"]
        assert report.lists_replaced == {field: 1}


# ── 5. dict 列表的 add/remove 行为逐字不变（回归护栏）────────────────────────

class TestDictListBehaviorUnchanged:
    def test_dict列表_remove_miss仍是warning不是error(self):
        merged, report = apply_delta(_upstream(), {"remove": {"columns": ["ghost"]}})
        assert merged["columns"] == _upstream()["columns"]
        assert report.missing_removals == ("columns[ghost]",)
        assert report.warnings()

    def test_dict列表_add追加到末尾(self):
        merged, report = apply_delta(
            _upstream(), {"add": {"columns": [{"key": "extra", "label": "追加列"}]}})
        assert [c["key"] for c in merged["columns"]] == ["price_per_piece", "extra"]
        assert report.added == {"columns": 1}

    def test_dict列表_add身份已存在仍报错(self):
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"add": {"columns": [{"key": "price_per_piece", "label": "重复"}]}})
        assert "已存在" in str(ei.value)

    def test_同一字段既整体替换又增删_仍报错(self):
        with pytest.raises(SpecDeltaError):
            apply_delta(_upstream(), {"lists": {"columns": []}, "add": {"columns": [{"key": "x", "label": "x"}]}})


# ── 6. 常量与集合关系自检（防止后来者把 SCALAR_LIST_FIELDS 删了）───────────────

class TestScalarListFieldContract:
    def test_scalar_list_fields是notes与hs_codes(self):
        assert SCALAR_LIST_FIELDS == frozenset({"notes", "hs_codes"})

    def test_scalar_list_fields是list_fields的子集(self):
        from app.services.export_quote.spec_delta import LIST_FIELDS
        assert SCALAR_LIST_FIELDS <= LIST_FIELDS

    @pytest.mark.parametrize("field", ["notes", "hs_codes"])
    def test_lists_非数组非null_报错文案不再误导去用add_remove(self, field):
        """修复前：文案说"想按条目增删请用 add/remove" —— 对标量列表是错误指引。"""
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"lists": {field: "不是数组"}})
        msg = str(ei.value)
        assert "只支持整体替换" in msg, msg
        assert "add" not in msg and "remove" not in msg, msg
