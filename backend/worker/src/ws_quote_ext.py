"""报价工位补充端点（Worker 镜像 · 生产对齐）。

为什么需要这个文件
-----------------
orchestrator 的 `app/api/export_quote.py` 有一条报价辅助路由，线上 Worker 的
`quote_api.py` 只搬了算价 / 规格空间 / 批量导入，这条一直没搬：

    1. `POST /api/v1/export-quote/products/{key}/explain` —— 逐条摊开计算过程

**TAX-06 起 HS 退税率查询已下线**：原 `rebate-rate/lookup` 路由与文件版税务档案
（`rates.py`）一并删除；退税率由业务人工核实后显式填 `policy`。

对齐口径
-------
- **不重写任何计算**：公式渲染取自 `kaas_common.export_quote.*`
  （`scripts/sync-shared.ps1` 镜像的同一份引擎），本文件只做「组装请求 + 投影出参」。
- **引擎惰性导入 + 503 降级**：与 `quote_api.py` 走同一条路径（直接复用它的
  `_require_engine()`）。引擎是构建产物，漏同步时**不能**让模块级导入把整个
  Worker 拖死（连 /health 一起挂）—— 故一律在函数内导入，失败统一 503
  `engine_unavailable`，并说清楚怎么修。
- **错误体逐字同构**：`{"error": "unknown_product" | "unknown_variant" | "missing_axis", ...}`
  与 orchestrator 完全一致。
"""
from __future__ import annotations

from typing import Any, List, Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
# 本模块只有 `/explain` 一条路由，且它**不碰**客户定价 / 税务档案；但解析"产品定义"时
# 会经 `quote_api._db` 回落租户运行时产品（2026-10-21 起），因此库句柄由 quote_api 持有，
# 这里仍不直接绑定 main.db / DEFAULT_TENANT。

# ── 引擎符号：**惰性**取用 ────────────────────────────────────────────────────
# 为什么不在模块顶部 from kaas_common.export_quote import ...：
#   · `kaas_common/export_quote/**` 是 scripts/sync-shared.ps1 的构建产物
#     （不进版本控制），漏同步时模块级导入会抛异常，而本模块由 main.py 末尾
#     `import ws_quote_ext` 挂载 —— 那会让**整个 Worker 起不来**。
#   · 引擎 15 个模块 / 5445 行，模块级导入 = 每次冷启动都多解析一遍；
#     Worker 的启动 CPU 有硬限额（历史修过 ecf50ad），所以只在真正调用
#     这两条路由时才付这份代价。
# 本字典同时充当「已加载」标志：非空即已就绪。
_ENGINE: dict = {}


def _ensure_engine() -> dict:
    """导入解释器所需的引擎符号并缓存；引擎缺失一律 503（与 quote_api 同文案）。

    先调 `quote_api._require_engine()`：它是全仓唯一的引擎可用性判据，
    503 的错误体（error/code/修复指引）与 /calculate 等既有接口完全一致，
    这样同一个「引擎没打进包」的故障不会有两种说法。
    """
    if _ENGINE:
        return _ENGINE
    import quote_api  # noqa: PLC0415 - 同级模块，函数内导入避免挂载期耦合

    quote_api._require_engine()
    try:  # 引擎残缺时给可执行的修复指引，而不是把 ImportError 原样抛成 500
        from kaas_common.export_quote.engine import (
            resolve_space_deduction,
            resolve_space_deduction_ratio,
        )
        from kaas_common.export_quote.formulas import PRICE_METRICS, worked_example
        from kaas_common.export_quote.numeric import DECIMAL, to_decimal
        # 草稿定义的**严格解析**：与 orchestrator 用**同一份**实现（引擎包里的
        # `spec_override`），**不在 worker 另写一份** —— 两套解析必然漂移。
        from kaas_common.export_quote.spec_override import (
            SpecOverrideError,
            parse_spec_override,
        )
    except Exception as exc:  # noqa: BLE001 - 镜像残缺时不该是 500 裸栈
        raise HTTPException(status_code=503, detail={
            "error": "engine_unavailable",
            "message": ("报价引擎符号缺失（kaas_common.export_quote.* 导入失败：%s: %s）。"
                        "部署前请执行 `pwsh scripts/sync-shared.ps1`，"
                        "并确认 backend/worker/src/kaas_common/ 被打进了包。"
                        % (type(exc).__name__, exc)),
        })
    _ENGINE.update({
        "resolve_space_deduction": resolve_space_deduction,
        "resolve_space_deduction_ratio": resolve_space_deduction_ratio,
        "PRICE_METRICS": PRICE_METRICS,
        "worked_example": worked_example,
        "DECIMAL": DECIMAL,
        "to_decimal": to_decimal,
        "SpecOverrideError": SpecOverrideError,
        "parse_spec_override": parse_spec_override,
    })
    return _ENGINE


# ── Schemas ───────────────────────────────────────────────────────────────────

class _ExplainIn(BaseModel):
    """逐步代入计算逻辑的输入：给一组规格取值。"""

    spec: dict = Field(
        default_factory=dict,
        description="规格取值，如 {'height_m': 1.2, 'mesh_mm': 100, 'wire': '全丝2.0', "
                    "'coating': '普锌40g/㎡', 'wave': '无波款'}",
    )
    total: Optional[float] = Field(
        default=None, description="订单总长度，用于算件数与订单级指标"
    )
    constants: Optional[dict] = Field(
        default=None, description="常量覆盖（如 wave_add_per_100m）"
    )
    metrics: Optional[List[str]] = Field(
        default=None, description="只算这些指标；不传则全算"
    )
    spec_override: Optional[dict] = Field(
        default=None,
        description="**草稿定义**（可选）：用这份**未保存**的 ProductSpec 代替产品注册表里的定义来试算。"
                    "只在本次请求内生效、**不落库**；结构不合法会 422（未知字段/类型不对都报错，"
                    "不会静默取默认）。缺字段则按默认值参与，并在响应的 `warnings` 里如实列出。"
                    "**与 orchestrator 的 ExplainIn 逐字段一致**（同一份解析器）。",
    )


# ── 逐步代入（计算说明书）────────────────────────────────────────────────────

@app.post("/api/v1/export-quote/products/{product_key}/explain")
async def export_quote_explain_product(
    product_key: str,
    body: _ExplainIn,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """给定一组规格取值，按公式顺序逐步代入，产出可核对的计算过程。

    只做「把公式摊开算一遍」：不进价链、不查税务档案，因此不涉及成本与利润，
    普通登录用户即可调用 —— 客户/业务问「这个 29.9 立方怎么来的」时能当场自证。

    与 orchestrator 一致，这里**不并入客户自定义档位**：本接口是"照着产品定义自证
    口径"，取值以产品定义 + 请求给的为准。

    **产品定义来源**（2026-10-21 改）：先查 Python 注册表，未命中再回落**租户运行时
    产品**（`tenant_products`，团队隔离 + `is_active`，与发现列表同口径，统一走
    `quote_api._product_or_404_tenant`）。此前只查注册表 ⇒ 租户产品（含编辑器刚保存的）
    调本接口 404，与"编辑器试算"这一主用途冲突。故本路由现在**会**读一次库来解析定义。

    **草稿试算（与 orchestrator 同构，task-26）**：带 `spec_override` 时，用这份**未保存**的
    定义代替注册表定义来算；只本次请求内生效、不落库；合法草稿连"是否已注册"都不再要求
    （这条路径不查库）。
    """
    import quote_api  # noqa: PLC0415

    eng = _ensure_engine()
    warnings: List[str] = []
    if body.spec_override is not None:
        try:
            parsed = eng["parse_spec_override"](body.spec_override, product_key=product_key)
        except eng["SpecOverrideError"] as exc:
            raise HTTPException(status_code=422, detail={
                "error": exc.code, "message": str(exc), "field": exc.field})
        spec = parsed.spec
        warnings.append("本次试算使用请求内的**草稿定义**（spec_override）：不落库、不影响线上产品")
        if parsed.defaulted:
            warnings.append("草稿未提供这些字段，按**默认值**参与试算："
                            + "、".join(parsed.defaulted))
    else:
        spec = await quote_api._product_or_404_tenant(request, user, product_key)

    # 规格轴取值：对齐到轴声明的类型（1.2 这类浮点要能与 Decimal 比）
    picked: dict = {}
    for axis in spec.axes:
        if axis.name in body.spec:
            picked[axis.name] = _coerce(body.spec[axis.name], axis.options)
    # 自由数值参数（丝径/网高/间距/卷长/卷径…）：给了就用，没给用声明的默认值。
    # **不做枚举** —— 丝径 2.3mm 就是 2.3mm；只挡明显填错的（越界/非数值）。
    # 与 orchestrator 同一口径。少了这一步，尺寸类改自由数值后公式取不到这些值，
    # 逐步代入会全是空（orchestrator 端就踩过，错返 200）。
    for ni in spec.numeric_inputs:
        if ni.key in body.spec:
            raw = body.spec[ni.key]
            try:
                value = eng["to_decimal"](raw)
            except Exception:
                raise HTTPException(status_code=400, detail={
                    "error": "invalid_numeric",
                    "message": f"{ni.label or ni.key} 不是数值: {raw!r}",
                })
            if ni.min_value is not None and value < eng["to_decimal"](ni.min_value):
                raise HTTPException(status_code=400, detail={
                    "error": "invalid_numeric",
                    "message": f"{ni.label or ni.key}={value} 小于下界 {ni.min_value}",
                })
            if ni.max_value is not None and value > eng["to_decimal"](ni.max_value):
                raise HTTPException(status_code=400, detail={
                    "error": "invalid_numeric",
                    "message": f"{ni.label or ni.key}={value} 大于上界 {ni.max_value}",
                })
            picked[ni.key] = value
        elif ni.default is not None:
            picked[ni.key] = ni.default
    for vg in spec.variants:
        want = body.spec.get(vg.name)
        if want is None:
            continue
        for opt in vg.options:
            if opt.get("name") == want:
                picked.update({k: v for k, v in opt.items()
                               if k not in ("name", "name_en")})
                picked[vg.name] = want
                break
        else:
            raise HTTPException(status_code=400, detail={
                "error": "unknown_variant",
                "message": f"{vg.label or vg.name} 没有取值 {want!r}；"
                           f"可选: " + ", ".join(
                               str(o.get("name")) for o in vg.options),
            })
    missing = [a.label or a.name for a in spec.axes if a.name not in picked]
    if missing:
        raise HTTPException(status_code=400, detail={
            "error": "missing_axis",
            "message": "缺少规格取值: " + ", ".join(missing),
        })
    # 可枚举的变体（表面处理/工艺）必须给：它们决定查价与增重，**不能默认**。
    # 少了它们公式取不到 raw_price / wave_factor，逐步代入算出空值却仍返 200 ——
    # 那比报错更坏（业务会以为这就是答案）。与 orchestrator 同一口径。
    missing_variants = [vg.label or vg.name for vg in spec.variants
                        if vg.name not in picked]
    if missing_variants:
        raise HTTPException(status_code=400, detail={
            "error": "missing_variant",
            "message": "缺少规格选择: " + ", ".join(missing_variants),
        })

    DECIMAL = eng["DECIMAL"]
    scope: dict = {}
    scope.update(spec.constants)
    scope.update(picked)
    for name, value in (body.constants or {}).items():
        scope[name] = value
    # 订单量：按 body.total 换算件数，未给则用 1 卷的尺度
    total = body.total
    roll_len = scope.get("roll_len_m") or 0
    if total and roll_len:
        scope["total"] = total
        scope["pieces"] = DECIMAL.divide(
            DECIMAL.convert(total), DECIMAL.convert(roll_len)
        )
    else:
        scope["total"] = 0
        scope["pieces"] = 0
    scope["space_deduction"] = eng["resolve_space_deduction"](spec, scope, DECIMAL)
    scope["space_deduction_ratio"] = eng["resolve_space_deduction_ratio"](spec)
    # 价格类量不在本接口范围内，给 0 占位以免公式求值失败
    scope.setdefault("terms_enabled", 0)
    scope.setdefault("main_price_incl", 0)
    scope.setdefault("unit_price", 0)
    scope.setdefault("fx_rate", 1)

    # 价格类量默认不在此接口计算：它们由完整价链 + 税务档案决定，
    # 在这里给 0 会让人误以为价格就是 0。数量口径才是本接口要自证的东西。
    PRICE_METRICS = eng["PRICE_METRICS"]
    requested = set(body.metrics) if body.metrics else None
    price_omitted = bool(requested is None or (requested & PRICE_METRICS))
    only = None if requested is None else sorted(requested - PRICE_METRICS)

    # 先算**全部**步骤：`ok`/`errors` 必须覆盖**所有**步骤，不能被 `metrics` 过滤掉的那些漏掉
    # （"只看通过的"会得出"没问题"的错觉）。与 orchestrator 同一处理。
    all_steps = eng["worked_example"](spec, scope, None)
    if requested is None:
        steps = [s for s in all_steps if s["code"] not in PRICE_METRICS]
    else:
        wanted = set(only)
        steps = [s for s in all_steps if s["code"] in wanted]
    errors = [{"code": s["code"], "error": s["error"], "expr": s.get("expr")}
              for s in all_steps if "error" in s]

    payload = {
        "product_key": spec.key,
        "product_name": spec.name,
        "spec": picked,
        "total": body.total,
        "space_deduction": str(scope["space_deduction"]),
        "space_deduction_ratio": str(scope["space_deduction_ratio"]),
        "steps": steps,
    }
    if price_omitted:
        payload["price_metrics_omitted"] = sorted(PRICE_METRICS)
        payload["price_hint"] = (
            "价格类指标未在此接口计算：它们由完整价链（成本 → 进项税 → 退税让利 → "
            "印花税 → 销项税）与税务档案决定，请调用 /calculate 或 /calculate-internal。"
        )
        warnings.append("价格类指标未计算（见 price_hint）：本次只自证数量口径")
    # ── 加性汇总键：**与 orchestrator 逐项同构**（键名/类型/errors 元素形状都照同一份期望）
    payload["ok"] = not errors
    payload["errors"] = errors
    payload["warnings"] = warnings
    return payload


def _coerce(value: Any, options) -> Any:
    """把请求里的取值对齐到规格轴声明的类型（1.2 这类浮点要能与 Decimal 比）。

    与 orchestrator 的 `_coerce` 逐行一致：先按数值比较，再退回字符串比较。
    """
    for o in options:
        if isinstance(o, float):
            try:
                if float(value) == o:
                    return o
            except (TypeError, ValueError):
                continue
        elif o == value or str(o) == str(value):
            return o
    return value
