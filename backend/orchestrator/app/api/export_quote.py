"""出口报价工位 API（EXW / FCA / FOB / CFR / CIF）。

设计要点
--------
1. **两种视图**：`view=customer` 返回客户报价（自动剔除成本/税额/利润率列）；
   `view=internal` 返回内部核算明细，需要租户管理员权限。
   这是「对外展示不得暴露成本利润率」铁律的接口级落点。

2. **报价单不落库时也能算**：`/calculate` 是纯函数式接口，给参数就出结果，
   便于前端实时试算；落库由调用方决定（可复用 QuoteOrder 表）。

3. **法定税率来自税务档案**：请求里只需给 `rate_set_code`，
   征税率/销项税率/印花税率自动从档案取；显式传 `policy` 字段则本单覆盖。

4. **有效期默认 7 天**：返回 `valid_until`，前端可直接展示"报价有效期至"。

5. **退税率查询**：`/rebate-rate/lookup` 走可插拔 Provider（HTTP → 本地档案库），
   查不到明确报错，不猜 —— 猜错会让整张报价单系统性偏低。
"""
from __future__ import annotations

import json
import logging
from datetime import date
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError

from app.core.auth import AuthContext, get_auth_context
from app.deps.rbac import require_tenant_admin
from app.services.export_quote import (
    DEFAULT_VALIDITY_DAYS,
    EngineError,
    PricingError,
    QuoteRequest,
    RateSetError,
    RateSetRegistry,
    RebateRateNotFound,
    TermsError,
    build,
    build_customer_view,
    build_internal_view,
    policy_from_dict,
    product_keys,
)
from app.services.export_quote.engine import resolve_space_deduction
from app.services.export_quote.formulas import (
    PRICE_METRICS,
    describe_product,
    worked_example,
)
from app.services.export_quote.importers import (
    MAX_ROWS,
    ImportError_,
    build_template_csv,
    build_template_xlsx,
    parse_table,
    template_columns,
    template_headers,
)
from app.services.export_quote.numeric import DECIMAL
from app.services.export_quote.products import get as get_product
from app.services.export_quote.rates import build_default_provider, normalize_hs
from app.services.export_quote.report import quote_meta
from app.services.export_quote.terms import ladder_from_dict
from app.services.export_quote.verify import verify_all
from app.config.settings import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/export-quote", tags=["export-quote"])

# 税务档案注册表按进程缓存（文件只读，变更需重启或调 /rate-sets/reload）
_registry: Optional[RateSetRegistry] = None


def _get_registry(force: bool = False) -> RateSetRegistry:
    global _registry
    if _registry is None or force:
        _registry = RateSetRegistry.from_dir(settings.export_quote_rate_sets_dir or None)
    return _registry


# ─────────────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────────────
class OrderIn(BaseModel):
    name: Optional[str] = None
    total: float
    unit: str = "m"
    label: Optional[str] = None
    label_en: Optional[str] = None


class PolicyIn(BaseModel):
    """报价政策覆盖项；未给的字段从税务档案取默认值。"""

    input_vat_rate: Optional[float] = Field(
        default=None, description="进项票税点，如 0.10（供应商属性）"
    )
    output_vat_rate: Optional[float] = Field(
        default=None, description="销项税率；出口零税率填 0"
    )
    output_vat_mode: Optional[str] = Field(default=None, description="additive | inclusive")
    profit_mode: Optional[str] = Field(default=None, description="fixed | ratio")
    profit_value: Optional[float] = None
    give_ratio: Optional[float] = Field(default=None, description="让出可退进项增值税额的比例")
    refund_ratio: Optional[Any] = Field(
        default=None, description="可退税比例；'auto' = 出口退税率 ÷ 征税率"
    )
    rebate_rate: Optional[float] = Field(default=None, description="出口退税率（auto 模式使用）")
    levy_rate: Optional[float] = Field(default=None, description="征税率（auto 模式使用）")
    stamp_rate: Optional[float] = Field(default=None, description="印花税率")
    stamp_base: Optional[str] = Field(default=None, description="profit | cost | base_quote")
    extras: Optional[List[dict]] = None


class CalculateIn(BaseModel):
    product_key: str = Field(description="产品模型 key，如 field_fence")
    rate_set_code: Optional[str] = Field(
        default=None, description="税务档案编号；空则按报价日取当期生效的一份"
    )
    fx_rate: float = Field(description="汇率：1 报价币 = ? 本币")
    fx_source: str = ""
    orders: List[OrderIn] = Field(description="订单量方案，至少一个")
    policy: Optional[PolicyIn] = None
    terms: Optional[dict] = Field(default=None, description="贸易术语阶梯配置")
    price_inputs: Optional[dict] = Field(default=None, description="当期价格输入（运费等）")
    variant_overrides: Optional[dict] = Field(
        default=None, description="变体数值覆盖，如 {'coating': {'普锌40g/㎡': {'raw_price': 4.6}}}"
    )
    # 显式规格行：只算给的那些，不再展开全量组合
    spec_rows: Optional[List[dict]] = Field(
        default=None,
        description="只算这些规格行（部分字段即可，变体包给取值名）；"
                    "不传则展开产品的全部组合",
    )
    constants_override: Optional[dict] = None
    validity_days: int = Field(default=DEFAULT_VALIDITY_DAYS, ge=1, le=365)
    quote_date: Optional[date] = None
    with_verification: bool = Field(default=False, description="是否附带三遍核验结果")
    currency: str = "CNY"
    quote_currency: str = "USD"


class RebateLookupIn(BaseModel):
    hs_code: str = Field(description="HS 编码，如 7314410000")
    rate_set_code: Optional[str] = None


class SpecRowsIn(BaseModel):
    """显式规格行：只算给的那些，不展开全量组合。"""

    rows: List[dict] = Field(
        description="每个元素是一条规格（部分字段即可，变体包给取值名），"
                    "如 {'wire': '全丝2.0', 'height_m': 1.2, 'mesh_mm': 100, "
                    "'coating': '普锌40g/㎡', 'wave': '无波款'}",
    )
    sheet: Optional[str] = Field(default=None, description="xlsx 的工作表名，默认第一张")


class ExplainIn(BaseModel):
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


# ─────────────────────────────────────────────────────────────────────────────
# 元数据
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/products", summary="已注册的产品模型")
async def list_products(auth: AuthContext = Depends(get_auth_context)):
    out = []
    for key in product_keys():
        spec = get_product(key)
        out.append(
            {
                "key": spec.key,
                "name": spec.name,
                "name_en": spec.name_en,
                "category_code": spec.category_code,
                "combo_count": spec.combo_count,
                "spec_summary": spec.summary(),
                "hs_codes": list(spec.hs_codes),
                "cost_basis": spec.cost_basis,
                "cost_unit": spec.cost_unit,
                "params": spec.params,
                "metric_count": len(spec.derived) + len(spec.piece_metrics)
                + len(spec.order_metrics),
                "invariant_count": len(spec.invariants),
            }
        )
    return {"products": out, "total": len(out)}


@router.get("/products/{product_key}/formulas", summary="产品的规格空间与计算逻辑")
async def get_product_formulas(
    product_key: str,
    with_columns: bool = False,
    auth: AuthContext = Depends(get_auth_context),
):
    """返回产品的完整「计算说明书」。

    含规格空间（哪些量在变、变出多少组合）、每条公式的表达式/单位/
    落定小数位/**业务口径说明**、体积扣减口径、关系式与可调参数。

    报价工位据此把「波弯款怎么加」「实际占用体积怎么扣」直接展示给业务，
    不需要回来问开发。
    """
    spec = _get_product_or_404(product_key)
    return describe_product(spec, with_columns=with_columns)


@router.get("/products/{product_key}/import-template",
            summary="批量导入模板的列定义（不下载文件）")
async def import_template_info(
    product_key: str,
    auth: AuthContext = Depends(get_auth_context),
):
    """只回报模板长什么样：有哪些列、哪些必填、单位、可选值。

    前端据此在页面上先讲清「该填什么」，并可拼出下载链接：
    `/api/v1/export-quote/import/template?product_key=…&format=xlsx`
    """
    spec = _get_product_or_404(product_key)
    cols = template_columns(spec)
    return {
        "product_key": spec.key,
        "product_name": spec.name,
        "columns": [c.to_dict() for c in cols],
        "headers": [c.header for c in cols],
        "required_headers": [c.header for c in cols if c.required],
        "max_rows": MAX_ROWS,
        "max_mb": IMPORT_MAX_MB,
        "sheets": ["规格表", "示例", "填写说明"],
        "data_sheet": "规格表",
        "download": {
            "xlsx": ("/api/v1/export-quote/import/template"
                     "?product_key=%s&format=xlsx" % spec.key),
            "csv": ("/api/v1/export-quote/import/template"
                    "?product_key=%s&format=csv" % spec.key),
        },
        "notes": [
            "模板表头与导出的报价表一致：导出 → 改 → 再导入，不用另对照列名。",
            "解析只读第一个工作表；示例行放在「示例」表里，不会被误算。",
            "列名括号里的就是该列单位，按单位填原值即可，不要自己换算。",
        ],
    }


@router.post("/products/{product_key}/explain", summary="按规格取值逐步代入计算逻辑")
async def explain_product(
    product_key: str,
    body: ExplainIn,
    auth: AuthContext = Depends(get_auth_context),
):
    """给定一组规格取值，按公式顺序逐步代入，产出可核对的计算过程。

    只做「把公式摊开算一遍」，不进价链、不查档案，因此不涉及成本与利润，
    普通登录用户即可调用 —— 客户/业务问「这个 29.9 立方怎么来的」时能当场自证。
    """
    spec = _get_product_or_404(product_key)

    # 用引擎把规格取值解析成完整作用域（含变体联动与常量），再交给渲染器
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
            raise HTTPException(
                status_code=400,
                detail={"error": "unknown_variant",
                        "message": f"{vg.label or vg.name} 没有取值 {want!r}；"
                                   f"可选: " + ", ".join(
                                       str(o.get('name')) for o in vg.options)},
            )
    missing = [a.label or a.name for a in spec.axes if a.name not in picked]
    if missing:
        raise HTTPException(
            status_code=400,
            detail={"error": "missing_axis",
                    "message": "缺少规格取值: " + ", ".join(missing)},
        )

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
    scope["space_deduction"] = resolve_space_deduction(spec, scope, DECIMAL)
    # 价格类量不在本接口范围内，给 0 占位以免公式求值失败
    scope.setdefault("terms_enabled", 0)
    scope.setdefault("main_price_incl", 0)
    scope.setdefault("unit_price", 0)
    scope.setdefault("fx_rate", 1)

    # 价格类量默认不在此接口计算：它们由完整价链 + 税务档案决定，
    # 在这里给 0 会让人误以为价格就是 0。数量口径才是本接口要自证的东西。
    requested = set(body.metrics) if body.metrics else None
    price_omitted = bool(
        requested is None or (requested & PRICE_METRICS)
    )
    only = None if requested is None else sorted(requested - PRICE_METRICS)

    steps = worked_example(spec, scope, only)
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
    """把请求里的取值对齐到规格轴声明的类型（1.2 这类浮点要能与 Decimal 比）。"""
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


def _get_product_or_404(product_key: str):
    try:
        return get_product(product_key)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error": "unknown_product", "message": str(exc)},
        )


@router.get("/rate-sets", summary="可用税务档案")
async def list_rate_sets(auth: AuthContext = Depends(get_auth_context)):
    reg = _get_registry()
    out = []
    for rs in reg.all():
        out.append(
            {
                "code": rs.code,
                "name": rs.name,
                "country": rs.country,
                "effective_from": rs.effective_from.isoformat() if rs.effective_from else None,
                "effective_to": rs.effective_to.isoformat() if rs.effective_to else None,
                "levy_rate": rs.levy_rate,
                "output_rate_default": rs.output_rate_default,
                "output_rate_export": rs.output_rate_export,
                "stamp_duty": {"rate": rs.stamp_duty.rate, "base": rs.stamp_duty.base},
                "summary": rs.stamp_duty.summary,
                "rebate_hs_count": len(rs.rebate_by_hs),
                "rebate_default": rs.rebate_default,
                "rebate_source": rs.rebate_source,
                "warnings": rs.warnings(),
                "source": rs.source,
                "notes": list(rs.notes),
            }
        )
    return {"rate_sets": out, "total": len(out)}


@router.post("/rate-sets/reload", summary="重新加载税务档案（管理员）")
async def reload_rate_sets(auth: AuthContext = Depends(require_tenant_admin)):
    reg = _get_registry(force=True)
    return {"reloaded": True, "codes": reg.codes}


# ─────────────────────────────────────────────────────────────────────────────
# 退税率查询
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/rebate-rate/lookup", summary="按 HS 编码查询出口退税率")
async def lookup_rebate_rate(
    body: RebateLookupIn, auth: AuthContext = Depends(get_auth_context)
):
    reg = _get_registry()
    try:
        rs = reg.resolve(body.rate_set_code)
    except RateSetError as exc:
        raise HTTPException(status_code=400, detail={"error": "rate_set_error", "message": str(exc)})

    provider = build_default_provider(
        rs,
        api_url=settings.rebate_rate_api_url,
        api_key=settings.rebate_rate_api_key,
        ttl_seconds=settings.rebate_rate_cache_ttl,
    )
    try:
        result = await provider.lookup(body.hs_code)
    except RebateRateNotFound as exc:
        return {
            "found": False,
            "hs_code": normalize_hs(body.hs_code),
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


# ─────────────────────────────────────────────────────────────────────────────
# 表格批量导入
# ─────────────────────────────────────────────────────────────────────────────
IMPORT_MAX_MB = 2


@router.get("/import/template", summary="下载批量导入模板（Excel / CSV）")
async def import_template(
    product_key: str = Query("field_fence", description="产品模型 key"),
    format: str = Query("xlsx", pattern="^(xlsx|csv)$",
                        description="xlsx（默认，带下拉与说明）或 csv"),
    examples: Optional[int] = Query(
        None, ge=0, le=50,
        description="示例行数；默认 Excel 3 行、CSV 0 行（CSV 一般给脚本生成用）"),
    include_spec: bool = Query(False, description="是否随附列定义（JSON）"),
    auth: AuthContext = Depends(get_auth_context),
):
    """给一份可直接填写的模板。

    表头就是导出报价表的那些列名（网高(m)／竖丝间距(cm)／丝径方案…），
    所以「导出 → 改 → 再导入」是同一个格式，不用额外对照。

    - **xlsx**：第 1 个表「规格表」用来填（可选值做了下拉框），
      另有「示例」与「填写说明」两个表 —— 解析只读第 1 个表，示例不会被误算。
    - **csv**：给脚本化批量生成用，默认只出表头，带 BOM，Excel 打开中文不乱码。
    """
    spec = _get_product_or_404(product_key)
    if examples is None:
        examples = 3 if format != "csv" else 0
    try:
        if format == "csv":
            body = ("\ufeff" + build_template_csv(spec, examples=examples)
                    ).encode("utf-8")
            media = "text/csv; charset=utf-8"
            ext = "csv"
        else:
            body = build_template_xlsx(spec, examples=examples)
            media = ("application/vnd.openxmlformats-officedocument"
                     ".spreadsheetml.sheet")
            ext = "xlsx"
    except ImportError_ as exc:
        raise HTTPException(status_code=400, detail={
            "error": "template_error", "message": str(exc)})

    headers = {
        "Content-Disposition":
            'attachment; filename="%s-import-template.%s"' % (spec.key, ext),
        # 便于前端直接展示「该填哪些列」，不必再解一次文件。
        # 值用 ensure_ascii=True：HTTP 头必须是 latin-1，中文直接放进去会崩。
        "X-Template-Columns": json.dumps(template_headers(spec)),
        "Access-Control-Expose-Headers": "X-Template-Columns, Content-Disposition",
    }
    if include_spec:
        headers["X-Template-Spec"] = json.dumps(
            [c.to_dict() for c in template_columns(spec)])
        headers["Access-Control-Expose-Headers"] = (
            "X-Template-Columns, X-Template-Spec, Content-Disposition")
    return Response(content=body, media_type=media, headers=headers)


async def _read_upload(file) -> bytes:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail={
            "error": "empty_file", "message": "上传的文件是空的"})
    limit = IMPORT_MAX_MB * 1024 * 1024
    if len(data) > limit:
        raise HTTPException(status_code=400, detail={
            "error": "file_too_large",
            "message": "文件过大（%.1f MB），上限 %d MB"
                       % (len(data) / 1048576, IMPORT_MAX_MB)})
    return data


def _parse_or_400(data: bytes, spec, filename: str = "", sheet: str | None = None):
    try:
        return parse_table(data, spec, filename=filename, sheet=sheet)
    except ImportError_ as exc:
        raise HTTPException(status_code=400, detail={
            "error": "parse_error", "message": str(exc)})


@router.post("/import/preview", summary="上传规格表并预览解析结果（不计算）")
async def import_preview(
    file: UploadFile = File(description="CSV 或 XLSX 规格表"),
    product_key: str = Form("field_fence"),
    sheet: Optional[str] = Form(default=None),
    auth: AuthContext = Depends(get_auth_context),
):
    """先看清楚解析成了什么，再决定要不要算。

    回报列映射（哪个表头落到了哪个字段）、可用行，以及逐行的
    「第几行 / 哪一列 / 什么值 / 期望什么」。坏行不会拖垮整表。
    """
    spec = _get_product_or_404(product_key)
    data = await _read_upload(file)
    parsed = _parse_or_400(data, spec, file.filename or "", sheet)
    payload = parsed.to_dict()
    payload["product_key"] = spec.key
    payload["product_name"] = spec.name
    payload["expected_columns"] = template_headers(spec)
    return payload


@router.post("/import/calculate", summary="上传规格表并一次性批量计算")
async def import_calculate(
    file: UploadFile = File(description="CSV 或 XLSX 规格表"),
    payload: str = Form(description="计算参数（CalculateIn 的 JSON 字符串）"),
    product_key: str = Form("field_fence"),
    sheet: Optional[str] = Form(default=None),
    view: str = Form("customer", description="customer | internal"),
    auth: AuthContext = Depends(get_auth_context),
):
    """把整张表的规格一次算完。

    解析出的规格行直接喂给引擎的逐行模式；坏行跳过并连同结果一起回报，
    不会因为表里有几行写错就整表算不出来。
    """
    if view not in ("customer", "internal"):
        raise HTTPException(status_code=400, detail={
            "error": "bad_view", "message": "view 只能是 customer 或 internal"})
    if view == "internal":
        _require_admin(auth)

    spec = _get_product_or_404(product_key)
    try:
        raw = json.loads(payload or "{}")
        if not isinstance(raw, dict):
            raise ValueError("payload 必须是一个 JSON 对象")
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail={
            "error": "bad_payload", "message": "payload 不是合法 JSON: %s" % exc})
    # product_key 走表单字段（与文件一起传更顺手），payload 里可省略
    raw.setdefault("product_key", product_key)
    try:
        body = CalculateIn(**raw)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_payload", "message": exc.errors()[:5]})

    data = await _read_upload(file)
    parsed = _parse_or_400(data, spec, file.filename or "", sheet)
    if not parsed.rows:
        raise HTTPException(status_code=400, detail={
            "error": "no_usable_rows",
            "message": "表里没有可计算的规格行；请先看 /import/preview 的问题清单",
            "issues": [i.to_dict() for i in parsed.issues]})

    body.product_key = product_key
    body.spec_rows = parsed.rows
    out = _run_calculation(body, auth, view)
    out["import"] = {
        "source_name": parsed.source_name,
        "total_data_rows": parsed.total_data_rows,
        "usable_rows": len(parsed.rows),
        "skipped_rows": parsed.total_data_rows - len(parsed.rows),
        "mapping": parsed.mapping,
        "ignored_columns": parsed.ignored_columns,
        "issues": [i.to_dict() for i in parsed.issues],
    }
    return out


def _require_admin(auth: AuthContext) -> None:
    """内部视图含成本利润率，与大工位同一条铁律，必须管理员。"""
    if not auth.is_internal() or auth.effective_role != "system_admin":
        raise HTTPException(status_code=403, detail={
            "error": "forbidden",
            "message": "内部核算视图需要租户管理员权限"})


# ─────────────────────────────────────────────────────────────────────────────
# 报价计算
# ─────────────────────────────────────────────────────────────────────────────
def _assemble_request(body: CalculateIn, auth: AuthContext) -> QuoteRequest:
    reg = _get_registry()
    try:
        rs = reg.resolve(body.rate_set_code, body.quote_date)
    except RateSetError as exc:
        raise HTTPException(status_code=400, detail={"error": "rate_set_error", "message": str(exc)})

    # 政策：档案给法定默认，请求显式给的覆盖
    base_cfg: dict = {
        "input_vat_rate": 0.10,
        "output_vat": {"rate": rs.output_rate_export, "mode": "additive"},
        "profit": {"mode": "fixed", "value": 0.1},
        "refund": {"refund_ratio": "auto", "give_ratio": 0.8, "levy_rate": rs.levy_rate},
        "stamp": {"rate": rs.stamp_duty.rate, "base": rs.stamp_duty.base},
    }
    if body.policy is not None:
        p = body.policy.model_dump(exclude_none=True)
        if "output_vat_rate" in p or "output_vat_mode" in p:
            base_cfg["output_vat"] = {
                "rate": p.pop("output_vat_rate", rs.output_rate_export),
                "mode": p.pop("output_vat_mode", "additive"),
            }
        for k in ("profit_mode", "profit_value"):
            if k in p:
                base_cfg.setdefault("profit", {})[k.replace("profit_", "")] = p.pop(k)
        for k in ("give_ratio", "refund_ratio", "rebate_rate", "levy_rate"):
            if k in p:
                base_cfg.setdefault("refund", {})[k] = p.pop(k)
        for k in ("stamp_rate", "stamp_base"):
            if k in p:
                base_cfg.setdefault("stamp", {})[k.replace("stamp_", "")] = p.pop(k)
        base_cfg.update(p)

    try:
        policy = policy_from_dict(base_cfg)
    except PricingError as exc:
        raise HTTPException(status_code=400, detail={"error": "policy_error", "message": str(exc)})

    orders = []
    for o in body.orders:
        total = o.total
        name = o.name or f"o{int(total) if float(total).is_integer() else total}"
        default_label = f"{int(total)}米" if o.unit == "m" else f"{total} {o.unit}".strip()
        orders.append(
            {
                "name": name,
                "label": o.label or default_label,
                "label_en": o.label_en or f"{total} {o.unit}".strip(),
                "total": total,
                "unit": o.unit,
            }
        )

    try:
        terms = ladder_from_dict(body.terms) if body.terms else None
    except TermsError as exc:
        raise HTTPException(status_code=400, detail={"error": "terms_error", "message": str(exc)})

    from app.services.export_quote.models import OrderSpec

    return QuoteRequest(
        product_key=body.product_key,
        policy=policy,
        fx_rate=body.fx_rate,
        fx_source=body.fx_source,
        orders=[
            OrderSpec(
                name=o["name"], total=o["total"], unit=o["unit"],
                label=o["label"], label_en=o["label_en"],
            )
            for o in orders
        ],
        terms=terms,
        price_inputs=body.price_inputs or {},
        spec_rows=[dict(r) for r in body.spec_rows] if body.spec_rows else None,
        rate_set=rs,
        validity_days=body.validity_days,
        quote_date=body.quote_date,
        constants_override=body.constants_override or {},
        variant_overrides=body.variant_overrides or {},
        currency=body.currency,
        quote_currency=body.quote_currency,
        tenant_id=auth_tenant(auth),
    )


def auth_tenant(auth: AuthContext) -> str:
    return auth.tenant_id or "default"


def _run_calculation(body: CalculateIn, auth: AuthContext, view: str) -> dict:
    req = _assemble_request(body, auth)
    try:
        result = build(req)
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"error": "engine_error", "message": str(exc)})
    except PricingError as exc:
        raise HTTPException(status_code=400, detail={"error": "pricing_error", "message": str(exc)})
    except TermsError as exc:
        raise HTTPException(status_code=400, detail={"error": "terms_error", "message": str(exc)})

    payload: dict = {
        "meta": quote_meta(result),
        "view": view,
        "customer": build_customer_view(result),
        "customer_en": build_customer_view(result, english=True),
    }
    if view == "internal":
        payload["internal"] = build_internal_view(result)
    if body.with_verification:
        payload["verification"] = verify_all(result).to_dict()
    if body.spec_rows:
        # 逐行模式下回报采用/跳过情况，便于用户知道哪几行没算
        payload["spec_rows"] = {
            "submitted": len(body.spec_rows),
            "computed": result.combo_count,
            "skipped": result.request.skipped_spec_rows,
        }
    return payload


@router.post("/calculate", summary="计算出口报价（客户视图）")
async def calculate_quote(body: CalculateIn, auth: AuthContext = Depends(get_auth_context)):
    """返回客户报价视图：只含规格、重量体积、外币价，不含成本与税额推导。

    这样即使前端直接用这个接口渲染客户页面，也不会泄露成本利润率。
    """
    return _run_calculation(body, auth, "customer")


@router.post("/calculate-internal", summary="计算出口报价（内部核算视图，管理员）")
async def calculate_quote_internal(
    body: CalculateIn, auth: AuthContext = Depends(require_tenant_admin)
):
    """返回含成本、利润、税额、退税推导的内部核算明细。

    需要租户管理员权限 —— 成本与利润率属内部数据，不得对客户暴露。
    """
    return _run_calculation(body, auth, "internal")


@router.post("/verify", summary="对一次报价跑三遍核验（管理员）")
async def verify_quote(body: CalculateIn, auth: AuthContext = Depends(require_tenant_admin)):
    body.with_verification = True
    req = _assemble_request(body, auth)
    try:
        result = build(req)
    except (EngineError, PricingError, TermsError) as exc:
        raise HTTPException(status_code=400, detail={"error": "engine_error", "message": str(exc)})
    rep = verify_all(result)
    return {
        "ok": rep.ok,
        "checks": rep.checks,
        "passes": rep.passes,
        "errors": [{"row": i.row, "field": i.field, "detail": i.detail} for i in rep.errors()],
        "warnings": [{"row": i.row, "field": i.field, "detail": i.detail} for i in rep.warnings()],
    }
