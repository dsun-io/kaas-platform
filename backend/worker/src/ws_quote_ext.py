"""报价工位补充端点（Worker 镜像 · 生产对齐）。

为什么需要这个文件
-----------------
orchestrator 的 `app/api/export_quote.py` 有两条报价辅助路由，线上 Worker 的
`quote_api.py` 只搬了算价 / 规格空间 / 税务档案 / 批量导入，这两条一直没搬：

    1. `POST /api/v1/export-quote/rebate-rate/lookup`     —— 按 HS 编码查出口退税率
    2. `POST /api/v1/export-quote/products/{key}/explain` —— 逐条摊开计算过程

它们已登记在 `scripts/route-parity-allowlist.txt`（「待补」= 承认的缺口）：
前端或巡检脚本一调用，线上就是 404。本文件把缺口补齐，语义逐条对齐
orchestrator（真源 = `backend/orchestrator/app/api/export_quote.py` L279-372 / L449-482）。

对齐口径
-------
- **不重写任何计算**：税务档案与公式渲染都取自 `kaas_common.export_quote.*`
  （`scripts/sync-shared.ps1` 镜像的同一份引擎），本文件只做「组装请求 + 投影出参」。
- **引擎惰性导入 + 503 降级**：与 `quote_api.py` 走同一条路径（直接复用它的
  `_require_engine()`）。引擎是构建产物，漏同步时**不能**让模块级导入把整个
  Worker 拖死（连 /health 一起挂）—— 故一律在函数内导入，失败统一 503
  `engine_unavailable`，并说清楚怎么修。
- **错误体逐字同构**：`{"error": "rate_set_error" | "unknown_product" |
  "unknown_variant" | "missing_axis", ...}` 与 orchestrator 完全一致。
- **退税率只查本地档案库**：线上（Pyodide）没有 httpx，HTTP provider 必然不可用；
  查不到就明确回报 `found: false` + hint，**绝不猜** —— 猜错会让整张报价单
  系统性偏低，这是这条链上最贵的错误（见引擎 rates.py 顶部说明）。
"""
from __future__ import annotations

from typing import Any, List, Optional

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
# 本模块两条路由都**不查库**（与 dev 同：explain 只摊开公式、不读客户定价；
# rebate-rate 只读税务档案文件），所以不在这里绑定 main.db / DEFAULT_TENANT —— 
# 绑了也不用，只会让人以为这两条接口会碰数据库。

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
        from kaas_common.export_quote import RateSetError
        from kaas_common.export_quote.engine import resolve_space_deduction
        from kaas_common.export_quote.formulas import PRICE_METRICS, worked_example
        from kaas_common.export_quote.numeric import DECIMAL
        from kaas_common.export_quote.rates import (
            RebateRateNotFound,
            build_default_provider,
            normalize_hs,
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
        "RateSetError": RateSetError,
        "resolve_space_deduction": resolve_space_deduction,
        "PRICE_METRICS": PRICE_METRICS,
        "worked_example": worked_example,
        "DECIMAL": DECIMAL,
        "RebateRateNotFound": RebateRateNotFound,
        "build_default_provider": build_default_provider,
        "normalize_hs": normalize_hs,
    })
    return _ENGINE


# ── Schemas（与 orchestrator 的 RebateLookupIn / ExplainIn 逐字段一致）────────

class _RebateLookupIn(BaseModel):
    hs_code: str = Field(description="HS 编码，如 7314410000")
    rate_set_code: Optional[str] = None


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


# ── 退税率查询 ───────────────────────────────────────────────────────────────

@app.post("/api/v1/export-quote/rebate-rate/lookup")
async def export_quote_rebate_rate_lookup(
    body: _RebateLookupIn,
    user: dict = Depends(_get_current_user),
):
    """按 HS 编码查出口退税率（对齐 orchestrator `lookup_rebate_rate`）。

    两种结果都是**正常响应**（不抛 4xx）：查到 `found: true` + `source`/`cached`，
    查不到 `found: false` + `hint`。业务要的是「知道有没有」，不是「接口报错」。
    """
    import quote_api  # noqa: PLC0415

    eng = _ensure_engine()
    # 档案注册表按 isolate 缓存：复用 quote_api 的那一份，避免同一进程两套缓存
    # （两边解析出的档案若不同步，会出现「算价用 A 档、查退税率用 B 档」）。
    try:
        rs = quote_api._registry().resolve(body.rate_set_code)
    except eng["RateSetError"] as exc:
        raise HTTPException(status_code=400, detail={
            "error": "rate_set_error", "message": str(exc)})

    # 线上只挂本地档案库这一路：orchestrator 传的是 settings.rebate_rate_api_url
    # / api_key / cache_ttl，而线上既没有 app.config.settings，也没有 httpx
    # （Pyodide 装不了），HttpRebateProvider 必然直接报「未启用」再回落到本地库。
    # 因此这里不传 api_url —— 结果与「配了但用不了」完全一致，只是少一次无意义的
    # import 尝试。provider 默认 TTL 24h，与 dev 的 REBATE_RATE_CACHE_TTL 默认值相同。
    provider = eng["build_default_provider"](rs)
    try:
        result = await provider.lookup(body.hs_code)
    except eng["RebateRateNotFound"] as exc:
        return {
            "found": False,
            "hs_code": eng["normalize_hs"](body.hs_code),
            "rate_set_code": rs.code,
            "message": str(exc),
            "hint": "请按 HS 编码在税务总局退税率文库核实后填入，或在税务档案中补充该编码",
        }
    return {
        "found": True,
        "hs_code": result.hs_code,
        "rebate_rate": result.rebate_rate,
        "source": result.source,
        "cached": result.cached,
        "rate_set_code": rs.code,
    }


# ── 逐步代入（计算说明书）────────────────────────────────────────────────────

@app.post("/api/v1/export-quote/products/{product_key}/explain")
async def export_quote_explain_product(
    product_key: str,
    body: _ExplainIn,
    user: dict = Depends(_get_current_user),
):
    """给定一组规格取值，按公式顺序逐步代入，产出可核对的计算过程。

    只做「把公式摊开算一遍」：不进价链、不查税务档案，因此不涉及成本与利润，
    普通登录用户即可调用 —— 客户/业务问「这个 29.9 立方怎么来的」时能当场自证。

    与 orchestrator 一致，这里**不并入客户自定义档位**（dev 的该端点也不查库）：
    本接口是"照着产品定义自证口径"，取值以产品定义 + 请求给的为准。
    """
    import quote_api  # noqa: PLC0415

    eng = _ensure_engine()
    spec = quote_api._product_or_404(product_key)

    # 规格轴取值：对齐到轴声明的类型（1.2 这类浮点要能与 Decimal 比）
    picked: dict = {}
    for axis in spec.axes:
        if axis.name in body.spec:
            picked[axis.name] = _coerce(body.spec[axis.name], axis.options)
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

    steps = eng["worked_example"](spec, scope, only)
    if requested is None:
        steps = [s for s in steps if s["code"] not in PRICE_METRICS]

    payload = {
        "product_key": spec.key,
        "product_name": spec.name,
        "spec": picked,
        "total": body.total,
        "space_deduction": str(scope["space_deduction"]),
        "steps": steps,
    }
    if price_omitted:
        payload["price_metrics_omitted"] = sorted(PRICE_METRICS)
        payload["price_hint"] = (
            "价格类指标未在此接口计算：它们由完整价链（成本 → 进项税 → 退税让利 → "
            "印花税 → 销项税）与税务档案决定，请调用 /calculate 或 /calculate-internal。"
        )
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
