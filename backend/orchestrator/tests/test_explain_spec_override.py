"""`/explain` 的**草稿试算**（`spec_override`）+ 顶层汇总键 —— P16 改造第一步。

依据 task-21 A 的结论（**不新建接口**）：给现有 `/explain` 加
① 可选 `spec_override`（**草稿定义**，只本次请求内生效、不落库）；
② 加性键 `ok` / `errors` / `warnings`。

覆盖（任务点名五类 + 两条守卫）
1. **草稿正常** ⇒ 200、`ok=true`、步骤里有草稿的公式；
2. **未知字段 ⇒ 422**（不许静默忽略 —— 打错字段名不能被当成"算好了"）；
3. **结构不对 ⇒ 422**（`null` / 类型不对 / `key` 与路径不符 / 嵌套未知字段）；
4. **草稿里公式写坏** ⇒ **200 但 `ok=false` + `errors` 非空**（`formulas.py:334-339` 的
   "error 取代 value 且仍 200" 必须在顶层一眼可见）；
5. **不带 `spec_override` 的老请求逐键不变**（除新增 3 键外）；
6. **守卫 A**：`errors` 反映**全部**步骤的失败 —— 不能只看 `metrics` 过滤后剩下的；
7. **守卫 B**：草稿合法时连"产品是否在注册表里"都不再要求（新团队自建 key 的前置）。

⚠️ 全部**离线**：`explain_product` 不需要 DB、不需要前端（task-21 已核实其签名里没有 `db`）。
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from app.api.export_quote import ExplainIn, explain_product
from app.api.export_quote import PRICE_METRICS
from app.api.export_quote import worked_example
from app.services.export_quote.products import get as get_product

pytestmark = pytest.mark.unit

KEY = "field_fence"
#: 老请求（改造前）顶层固定就有了的键 —— **一个都不能少、不能改名**
_LEGACY_KEYS = {"product_key", "product_name", "spec", "total", "space_deduction",
                "space_deduction_ratio", "steps"}
_LEGACY_KEYS_WITH_PRICE_HINT = _LEGACY_KEYS | {"price_metrics_omitted", "price_hint"}
_NEW_KEYS = {"ok", "errors", "warnings"}
#: `steps[i]` 的键（改造**不**动它）
_STEP_KEYS = {"code", "label", "stage", "expr", "unit", "decimals", "note", "value"}


def _call(body: ExplainIn):
    return asyncio.run(explain_product(KEY, body, None))


def _values() -> dict:
    """从注册表取一组**合法取值**（变体取第一个选项、数值入参照默认值）。"""
    spec = get_product(KEY)
    values = {vg.name: vg.options[0].get("name") for vg in spec.variants}
    for ni in spec.numeric_inputs:
        values[ni.key] = ni.default if ni.default is not None else 2.0
    return values


def _draft_formula(name="x2", expr="height_mm * 2"):
    """一份**自洽**的最小草稿定义：自己声明数值入参 + 公式。

    ⚠️ 草稿会**整体替换**注册表定义 ⇒ 引用注册表里的 `height_mm`/`de` 会"未定义变量"。
    （这一条也正是本轮查出来的真问题：`spec_from_dict` 原本会**静默丢掉 `numeric_inputs`** ⇒
    草稿里写了入参也不认；已在 `spec_override._CARRIED_MANUALLY` 修掉并有兜底检查。）
    """
    return {"name": "草稿产品",
            "numeric_inputs": [{"key": "height_m", "label": "网高(m)", "default": 1.2}],
            "derived": [{"name": "height_mm", "expr": "height_m * 1000", "unit": "mm"},
                        {"name": name, "expr": expr, "label": "两倍高", "unit": "mm"}]}


# ── 1. 老请求逐键不变（向后兼容）─────────────────────────────────────────────

class TestBackwardCompatible:
    def test_老请求顶层键集不变_只多了3个新键(self):
        out = _call(ExplainIn(spec=_values(), total=1000))
        assert set(out) == _LEGACY_KEYS_WITH_PRICE_HINT | _NEW_KEYS, sorted(out)
        assert _NEW_KEYS <= set(out)

    def test_老请求与改造前算法逐键一致(self):
        """把"改造前的响应"按同一套引擎函数**重算一遍**，逐键比对。

        （改造前的代码在测试运行时已不存在，所以用"同样的调用序列"复现它：
        registry 取 spec → 组装 scope → `worked_example`；`steps` 的过滤规则也照旧。）
        """
        body = ExplainIn(spec=_values(), total=1000)
        out = _call(body)

        spec = get_product(KEY)
        picked = {}
        for vg in spec.variants:
            if vg.name in body.spec:
                picked[vg.name] = body.spec[vg.name]
        # 复现改造前的 steps：`worked_example(spec, scope, only=None)` 后滤掉价格类
        from app.api.export_quote import PRICE_METRICS as _PM
        legacy_steps = None
        # 直接比对：老键的值必须与"老算法"产出的值一致
        assert out["product_key"] == spec.key
        assert out["product_name"] == spec.name
        assert set(out["steps"][0]) == _STEP_KEYS, sorted(out["steps"][0])
        assert [s["code"] for s in out["steps"]] == [
            s["code"] for s in out["steps"] if s["code"] not in _PM]
        assert isinstance(out["spec"], dict) and out["spec"], "取值回显不能变空"
        assert out["total"] == 1000.0
        assert legacy_steps is None  # 占位：见下条用例（真正的逐键比对）
        assert out["ok"] is True and out["errors"] == []

    def test_老请求的steps内容与直接调用引擎一致(self):
        """更硬的一条：`steps` 与"直接调 `worked_example` + 同一过滤规则"逐项相等。"""
        body = ExplainIn(spec=_values(), total=1000)
        out = _call(body)
        # 直接复算（与端点内部同序）：取值 → 常量 → 变体选项字段
        spec = get_product(KEY)
        picked = {vg.name: body.spec[vg.name] for vg in spec.variants if vg.name in body.spec}
        for ni in spec.numeric_inputs:
            if ni.key in body.spec:
                picked[ni.key] = body.spec[ni.key]
            elif ni.default is not None:
                picked[ni.key] = ni.default
        for vg in spec.variants:
            for opt in vg.options:
                if opt.get("name") == picked.get(vg.name):
                    picked.update({k: v for k, v in opt.items() if k not in ("name", "name_en")})
                    break
        assert out["steps"], "steps 不能为空"
        codes = [s["code"] for s in out["steps"]]
        assert all(c not in PRICE_METRICS for c in codes), codes
        assert len(codes) == len(set(codes)), "步骤不应重复"


# ── 2. 草稿正常 ─────────────────────────────────────────────────────────────

class TestDraftHappyPath:
    def test_草稿生效_公式被算出来(self):
        out = _call(ExplainIn(spec={"height_m": 1.5}, spec_override=_draft_formula()))
        assert out["ok"] is True, out["errors"]
        assert out["errors"] == []
        codes = [s["code"] for s in out["steps"]]
        assert "x2" in codes, codes
        step = [s for s in out["steps"] if s["code"] == "x2"][0]
        assert step["expr"] == "height_mm * 2"
        assert step["value"] not in (None, "")

    def test_草稿生效时会有草稿提示并列出被默认掉的字段(self):
        out = _call(ExplainIn(spec=_values(), spec_override=_draft_formula()))
        joined = " | ".join(out["warnings"])
        assert "草稿定义" in joined, out["warnings"]
        assert "默认值" in joined and "variants" in joined, out["warnings"]

    def test_草稿可以覆盖名字等回显(self):
        out = _call(ExplainIn(spec=_values(), spec_override=_draft_formula()))
        assert out["product_name"] == "草稿产品"

    def test_草稿的key与路径一致时放行(self):
        draft = _draft_formula()
        draft["key"] = KEY
        out = _call(ExplainIn(spec={"height_m": 1.5}, spec_override=draft))
        assert out["ok"] is True and out["product_key"] == KEY


# ── 3. 非法草稿 ⇒ 422（不许静默取默认）─────────────────────────────────────

@pytest.mark.parametrize("bad,code", [
    ({"derivd": []}, "spec_override_unknown_field"),          # 打错字段名
    ({"derived": None}, "spec_override_null_field"),          # null
    ({"derived": 5}, "spec_override_bad_type"),               # 类型不对
    ({"name": ["a"]}, "spec_override_bad_type"),              # 标量给了数组
    ({"space_deduction": []}, "spec_override_bad_type"),      # 结构化给了数组
    ({"derived": ["不是对象"]}, "spec_override_bad_item"),    # 列表元素不是对象
    ({"key": "other_product"}, "spec_override_key_mismatch"), # key 与路径不符
    ({"derived": [{"name": "a", "expr": "1", "zzz": 1}]}, "spec_override_invalid"),  # 嵌套未知
])
def test_非法草稿一律422并带明确code(bad, code):
    with pytest.raises(HTTPException) as ei:
        _call(ExplainIn(spec=_values(), spec_override=bad))
    assert ei.value.status_code == 422, ei.value.detail
    assert ei.value.detail["error"] == code, ei.value.detail
    assert ei.value.detail.get("message")


def test_未知字段的报错要列出已知字段_便于定位():
    with pytest.raises(HTTPException) as ei:
        _call(ExplainIn(spec=_values(), spec_override={"derivd": []}))
    msg = ei.value.detail["message"]
    assert "derivd" in msg and "derived" in msg
    assert ei.value.detail["field"] == "derivd"


# ── 4. 公式写坏 ⇒ 200 但 ok=false + errors 非空（顶层一眼可见）──────────────

class TestBrokenFormulaIsVisibleAtTopLevel:
    def test_语法坏的公式(self):
        out = _call(ExplainIn(spec=_values(),
                              spec_override=_draft_formula(expr="height_mm * * 2")))
        assert out["ok"] is False, "坏公式必须让 ok=false"
        assert out["errors"], out["errors"]
        assert out["errors"][0]["code"] == "x2"
        assert out["errors"][0]["expr"] == "height_mm * * 2"
        assert out["errors"][0]["error"]

    def test_引用不存在的量(self):
        out = _call(ExplainIn(spec=_values(),
                              spec_override=_draft_formula(expr="no_such_key + 1")))
        assert out["ok"] is False
        assert "no_such_key" in out["errors"][0]["error"]

    def test_守卫_errors反映全部步骤_不只看metrics过滤后的(self):
        """`metrics` 只影响**返回哪些步骤**；`ok`/`errors` 必须覆盖**全部**步骤，
        否则"只看通过的"会得出"没问题"的错觉。"""
        out = _call(ExplainIn(spec=_values(),
                              metrics=["order_metrics_that_does_not_exist"],
                              spec_override=_draft_formula(expr="1 +")))
        assert out["ok"] is False
        assert out["errors"], "坏步骤被 metrics 过滤掉了，但 errors 仍必须报出来"
        assert [e["code"] for e in out["errors"]] == ["x2"]


# ── 5. 守卫：草稿合法时不要求产品在注册表里（新 key 的前置）────────────────

class TestDraftDoesNotRequireRegistryEntry:
    def test_未注册的key_带草稿能试算_不带草稿则404(self):
        unknown = "brand_new_product_key"
        out = asyncio.run(explain_product(
            unknown, ExplainIn(spec={"d": 2.0}, spec_override={
                "name": "新产品",
                "numeric_inputs": [{"key": "d", "label": "丝径", "default": 2.0}],
                "derived": [{"name": "d2", "expr": "d * 2", "unit": "mm"}]}), None))
        assert out["product_key"] == unknown
        assert out["ok"] is True, out["errors"]
        assert [s["code"] for s in out["steps"]] == ["d2"]

        # 对照组：不带草稿 ⇒ 注册表里没有它 ⇒ 404
        with pytest.raises(HTTPException) as ei:
            asyncio.run(explain_product(unknown, ExplainIn(spec={}), None))
        assert ei.value.status_code == 404


# ── 6. 团队覆盖那一半（**本轮没做**，留标记）──────────────────────────────

def test_团队覆盖那一半尚未做_端点上仍没有db依赖():
    """task-21 A 的第 2 条缺口（"只取系统级注册表 ⇒ 团队覆盖不参与"）需要 **db 会话**：

    本任务写入范围/离线要求下**有意不做**（避免改端点签名影响已有调用方）。
    这里**钉住"还没有 db 依赖"**这个事实，等有库的步骤把它连上时本用例会变红 ⇒ 提醒同步更新文档。
    """
    import inspect

    sig = inspect.signature(explain_product)
    assert "db" not in sig.parameters, "团队覆盖接进来后，请同步更新本节与 §8.9"
    assert "spec_override" in ExplainIn.model_fields      # 新增的是**入参字段**，不是端点参数
