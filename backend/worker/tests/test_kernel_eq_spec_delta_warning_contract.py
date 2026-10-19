from __future__ import annotations

import sys
from pathlib import Path

# S4（2026-10-19）：报价引擎真源已迁到 backend/kaas_common/export_quote；
# 本文件从 orchestrator 测试迁来，仅重定向 import，断言不变。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

"""`spec_delta` 的 **remove-miss 契约**：上层该"拒绝"还是"接受 + 回传 warning"。

背景
====

`spec_delta.apply_delta()` 已实现："`remove` 指向**上游已不存在**的条目"⇒
幂等 no-op + 把 `field[identity]` 记进 `DeltaReport.missing_removals`
（`spec_delta.py` 的 `_remove_items` / `DeltaReport.warnings`）。

本文件钉住的是**上层（API / 编辑器保存路径）该怎么呈现它** —— 因为"引擎如实回报"
只解决了一半：**另一半是接口决定用 200 还是 4xx**，而定错了会让业务
要么被无意义地阻断，要么把"我以为定制过"的错误长期潜伏。

我的建议（本文件即契约）
========================

**接受（HTTP 200）+ `warnings[]` 回传 + 保留原始标识**，**不是**拒绝、**不是**静默。
三条理由：

1. **目标是"该条目不被覆盖"，而它本来就没被覆盖** ⇒ 语义上**已经达成**，属**幂等成功**。
   拒绝会强迫用户去"修"一条其实已经满足的差异 —— 用错误码阻断正确状态。
2. **但绝不能静默**：miss 通常意味着**上游改名/删除**。用户以为自己在覆盖 `X`，
   而上游可能已改成 `Y` 并**继续生效** ⇒ 不改名的前提下，"我定制过"是**错觉**。
3. **与仓库既有口径一致**：`verify.py` 的 `VerificationReport.to_dict()` 就是
   `{"ok": …, "warnings": [...]}`（`verify.py:89`），`RateSet.warnings()`
   （`rates.py:121`）、`importers.py:179`、`pricing.py:414` 也都是"警告不阻断"的先例。
   ⇒ 本契约**沿用 `warnings` 这个词与"warnings ≠ errors"的语义**，不发明新词汇。

**但要与"真非法"分开**（这是本契约最容易做错的一点）：

| 输入 | 性质 | 建议状态码 |
|---|---|---|
| `remove` 指向已不存在的条目 | 差异**有效**，只是目标已不在 | **200** + `warnings[]` |
| 未知字段 / 未知 `spec_version` / `base_spec_hash` 不匹配 / 结构矛盾 | **我读不懂你的差异** | **422**（`SpecDeltaError`） |

把后者也降级成 warning 会让"公式被静默忽略"重新长回来 —— 那正是 SPEC_DELTA 要消灭的东西。

⚠️ 上层**尚未实现**（`app/api` 里还没有"存差异"的端点）⇒ 本文件**只钉契约、不改上层**。
"""

import pytest

from kaas_common.export_quote.spec_delta import (
    SpecDeltaError,
    apply_delta,
    spec_fingerprint,
)

pytestmark = pytest.mark.unit


# ── 建议的上层映射（**参考实现，仅存在于测试里**，用于钉契约）──────────────

def _save_response(report) -> tuple[int, dict]:
    """上层保存差异时**建议**这样回（本函数就是契约本身）。

    - 永远 200：`apply_delta` 已经成功产出有效 spec；
    - warning 逐条原样回传（**不折叠成一句笼统的话**，UI 要能点名到条目）；
    - 另给 `ok`：借鉴 `verify.py` 的 `to_dict()`（"跑完了，但有警告"）。
    """
    warnings = report.warnings()
    return 200, {"ok": not warnings, "warnings": warnings, "missing_removals": list(report.missing_removals)}


def _upstream() -> dict:
    return {
        "key": "field_fence",
        "name": "牛栏网",
        "columns": [{"key": "price_per_piece", "label": "单件价"}],
        "notes": ["上游说明"],
        "profit_value": 0.06,
    }


# ── 1. remove 指向不存在：200 + warning，且是幂等 no-op ─────────────────────

class TestRemoveMissIsAcceptedWithWarning:
    def test_返回值仍是有效spec_条目原样保留(self):
        base = _upstream()
        merged, report = apply_delta(base, {"remove": {"columns": ["no_such_column"]}})
        assert merged["columns"] == base["columns"]      # 幂等 no-op
        assert report.removed == {"columns": 0}
        assert report.missing_removals == ("columns[no_such_column]",)

    def test_上层应回200而不是4xx(self):
        _, report = apply_delta(_upstream(), {"remove": {"columns": ["no_such_column"]}})
        status, body = _save_response(report)
        assert status == 200, "目标已达成 ⇒ 幂等成功，不该用 4xx 阻断"
        assert body["ok"] is False                        # 跑完了，但不干净
        assert body["missing_removals"] == ["columns[no_such_column]"]

    def test_warning必须点名到具体条目_不许折叠成笼统话(self):
        _, report = apply_delta(_upstream(), {"remove": {"columns": ["ghost_a", "ghost_b"]}})
        _, body = _save_response(report)
        joined = " | ".join(body["warnings"])
        assert "columns[ghost_a]" in joined
        assert "columns[ghost_b]" in joined
        assert len(body["warnings"]) == 2, "两条 miss 就该有两条 warning"

    def test_warning里要提示可能是上游改了名并指向人工复核(self):
        _, report = apply_delta(_upstream(), {"remove": {"columns": ["老名字"]}})
        text = report.warnings()[0]
        assert "上游" in text and "人工复核" in text

    def test_命中存在的条目时不许有warning_避免狼来了(self):
        _, report = apply_delta(_upstream(), {"remove": {"columns": ["price_per_piece"]}})
        assert report.missing_removals == ()
        assert report.warnings() == []
        status, body = _save_response(report)
        assert status == 200 and body["ok"] is True


# ── 2. warning 不阻断同一请求里的其它差异（关键）────────────────────────────

class TestWarningDoesNotBlockTheRest:
    def test_同请求里既有miss又有覆盖_覆盖照样生效(self):
        merged, report = apply_delta(_upstream(), {
            "scalars": {"profit_value": 0.09},       # 应生效
            "remove": {"columns": ["no_such_column"]},  # miss ⇒ warning
        })
        assert merged["profit_value"] == 0.09, "miss 不该把同一请求里的有效差异一起废掉"
        assert report.missing_removals == ("columns[no_such_column]",)
        status, body = _save_response(report)
        assert status == 200 and body["warnings"]


# ── 3. "真非法"必须仍是 422，不许被降级成 warning ───────────────────────────

class TestRealErrorsStay422:
    def test_未知字段报错而不是warning(self):
        with pytest.raises(SpecDeltaError):
            apply_delta(_upstream(), {"scalars": {"no_such_field": 1}})

    def test_未知版本报错(self):
        with pytest.raises(SpecDeltaError):
            apply_delta(_upstream(), {"spec_version": 99, "scalars": {"name": "X"}})

    def test_哈希不匹配报错(self):
        with pytest.raises(SpecDeltaError):
            apply_delta(_upstream(), {"base_spec_hash": "sha256:0000", "scalars": {"name": "X"}})

    def test_契约要能区分两类_否则等于回到静默(self):
        """把 4 类输入并排跑一遍：两类必须 200+warning，两类必须抛错。"""
        base = _upstream()
        accepted = [
            {"remove": {"columns": ["ghost"]}},                    # 幂等 miss
            {"remove": {"invariants": ["老约束名"]}},               # 幂等 miss
        ]
        rejected = [
            {"scalars": {"no_such_field": 1}},                     # 未知字段
            {"spec_version": 99, "scalars": {"name": "X"}},        # 未知版本
        ]
        for delta in accepted:
            _, report = apply_delta(base, delta)
            status, _ = _save_response(report)
            assert status == 200 and report.warnings()
        for delta in rejected:
            with pytest.raises(SpecDeltaError):
                apply_delta(base, delta)

    def test_哈希不匹配不会被当成上游改名的warning(self):
        """上游改名会表现为 **哈希不匹配**（而不是 miss）—— 这条必须仍然拒绝。

        否则最危险的情形（上游整块改过、差异已失效）会被当成"温和提示"放过去。
        """
        base = _upstream()
        delta = {"base_spec_hash": spec_fingerprint({"key": "field_fence"}),  # 故意用错的指纹
                 "remove": {"columns": ["ghost"]}}
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(base, delta)
        assert "人工复核" in str(ei.value)


# ── 4. 幂等性：同一条差异重复提交，warning 形态稳定 ─────────────────────────

class TestIdempotentRepeat:
    def test_重复提交同一条miss差异_结果与warning都稳定(self):
        base = _upstream()
        delta = {"remove": {"columns": ["ghost"]}}
        first, r1 = apply_delta(base, delta)
        second, r2 = apply_delta(first, delta)
        assert first == second
        assert r1.missing_removals == r2.missing_removals == ("columns[ghost]",)
        assert r1.warnings() == r2.warnings()

    def test_上游补上该条目后_同一条差异变成真正生效(self):
        """同一份差异：上游没有该条目 ⇒ warning；上游有了 ⇒ 真删除。

        这正是"差异按上游变化重新解释"的定义（Q7：上游变更仍按差异合并）。
        """
        delta = {"remove": {"columns": ["late_column"]}}
        _, r_before = apply_delta(_upstream(), delta)
        assert r_before.warnings(), "上游没有它 ⇒ 应当 warning"

        up = _upstream()
        up["columns"] = up["columns"] + [{"key": "late_column", "label": "迟到列"}]
        merged, r_after = apply_delta(up, delta)
        assert r_after.missing_removals == ()
        assert r_after.warnings() == []
        assert [c["key"] for c in merged["columns"]] == ["price_per_piece"]


# ── 5. 写本文件时发现的缺口（**已修**，见 task-9 / test_spec_delta_lists.py）──

class TestKnownGapScalarLists:
    def test_标量列表的remove目前会报错而不是warning_这是待修缺口(self):
        """**缺口**（已记进 `PRODUCT_MODULE_IMPL_PLAN.md` §8.5 待办）：

        `notes` / `hs_codes` 的元素是**字符串**，而 `item_identity()` 要求条目是
        带 `key`/`name` 的对象 ⇒ 对它们做 `remove` **直接抛 `SpecDeltaError`**，
        而不是像 dict 列表那样给 warning。

        这**不是静默**（它报错了，符合"不许静默"），但报错文案没告诉用户
        "这两个字段的 remove 不支持" ⇒ 属**体验缺口**。两种合理修法：
        ① 标量列表的身份 = 值本身（`remove: {notes: ["上游说明"]}` 可删）；
        ② 明确把 `notes`/`hs_codes` 从 `add`/`remove` 的可用字段里排除，并在报错里说清。
        **已修**（task-9 扩范围到引擎包，修法②：报错文案明确"仅支持整体替换"，
        语义边界不变 —— 仍是报错而非 warning）。

        对照：同一个 `apply_delta` 对 dict 列表（`columns`）的同类操作**是 warning** ✓
        """
        with pytest.raises(SpecDeltaError) as ei:
            apply_delta(_upstream(), {"remove": {"notes": ["上游说明"]}})
        # **缺口已修**（task-9，修法②）：仍在 `add`/`remove` 阶段报错（不静默、
        # 不按值增删），但报错文案现在明确说明"仅支持整体替换"，不再是底层
        # `item_identity()` 的"列表条目必须是对象"。行为契约（报错 vs warning）
        # 不变，故本文件的 remove-miss 契约不受影响。
        assert "不支持按条目增删" in str(ei.value), str(ei.value)
        assert "仅支持整体替换" in str(ei.value), str(ei.value)

        # 第二道校验（对象但没有 key/name）同样报错 —— 两条都属同一缺口
        shapeless = _upstream()
        shapeless["columns"] = [{"label": "没有身份的列"}]
        with pytest.raises(SpecDeltaError) as ei2:
            apply_delta(shapeless, {"remove": {"columns": ["x"]}})
        assert "没有可用于定位的身份" in str(ei2.value), str(ei2.value)

        _, r = apply_delta(_upstream(), {"remove": {"columns": ["ghost"]}})
        assert r.warnings(), "dict 列表是 warning ⇒ 两种字段行为不一致，就是缺口所在"

    def test_标量列表本身仍可被整体替换_缺口只影响remove和add(self):
        """缺口范围要写清：`lists.notes`（整体替换，含 `[]` 清空与 `null` 取消）**完全可用**。"""
        merged, _ = apply_delta(_upstream(), {"lists": {"notes": []}})
        assert merged["notes"] == []
        merged2, _ = apply_delta(_upstream(), {"lists": {"notes": None}})
        assert merged2["notes"] == ["上游说明"]
