"""报价工位（export-quote）与报价单（quotes / quote-profiles）— Python Worker 版。

**这是一次移植，不是重写。** 唯一真源是 dev 后端：

    backend/orchestrator/app/api/export_quote.py      → 算价 / 规格空间 / 税务档案 / 导入
    backend/orchestrator/app/api/quote_orders.py      → 报价单（/api/v1/quotes）
    backend/orchestrator/app/api/quote_profiles.py    → 客户税率档案
    backend/orchestrator/app/api/ws_common.py         → 取号 / 汇率锁定 / 可见范围
    backend/orchestrator/app/services/pricing_table.py → 客户定价数据 → 引擎的成本表

为什么单开一个模块而不是继续堆进 main.py
----------------------------------------
main.py 已 3000+ 行；本工位有 9 组接口 + 一整套「请求组装 + 客户定价桥」，
塞进去会让「下一个接口照哪份写」再次变模糊。chain.py 已经证明这条路可行：
独立模块 + main.py 末尾 `import xxx` 挂载，复用 main 的 app / 鉴权 / 连接封装。

与 dev 的三处结构性差异（线上环境的硬约束，不是偷懒）
--------------------------------------------------
1. **没有 SQLAlchemy** → 一律 raw asyncpg（`$1` 占位符）。jsonb 列必须经
   `dbjson.row_to_dict(row, "表名")` 解码：asyncpg 在 Workers 里把 jsonb 返回成
   **str**，不解析的话前端会拿到字符串而不是对象。
2. **没有 openpyxl** → xlsx 模板生成与 xlsx 上传都走不通（openpyxl 依赖 C 扩展，
   打不进 Pyodide 包）。所以模板只给 CSV、上传只收 CSV，且**显式报错并指路 CSV**，
   不做静默退化 —— 静默退化会让业务以为"传上去了"。
3. **报价引擎来自 `kaas_common.export_quote`**（`scripts/sync-shared.ps1` 镜像的
   那一份，纯标准库）。它与 dev 的 `app.services.export_quote` 同源，因此金额口径
   天然一致 —— 本模块**不重写任何计算**，只做「组装请求 / 落库 / 投影出参」。

⚠️ 保持同步的义务：dev 侧改了上面任一处语义，本文件必须跟着改。两处形状不一致时
前端不会报错，只会静默算出不一样的价或存下不一样的字段。
"""
from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from itertools import product as _cartesian
from typing import Any, List, Optional

from fastapi import Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from pydantic import BaseModel, Field

# 复用 main 的 app / 鉴权 / 连接封装 / 段号取号 / 汇率锁定 / 归属隔离。
# 这些**都已经在 main.py 里**且与 dev 的 ws_common 对齐，重写一遍就会有两份口径。
from main import (  # noqa: E402
    DEFAULT_TENANT,
    _can_see_all,
    _check_write_access,
    _compute_spec_hash,
    _doc_customer,
    _get_current_user,
    _lock_fx_rate,
    _next_doc_no,
    app,
    db as _db,
)
from dbjson import row_to_dict as _row_to_dict

# ── 报价引擎：**惰性**导入（启动 CPU 是这台 Worker 的硬约束）──────────────────
# 为什么不写成模块级 import：
#   · 引擎镜像共 15 个模块 / 5445 行 / 23 万字节。Worker 的启动 CPU 有硬限额，
#     超限会让 isolate 间歇 5xx（历史修过 ecf50ad）。模块级导入 = **每次冷启动**
#     都多解析一倍多的代码；惰性化之后这份代价只在真正调用报价接口时才付。
#   · 同时天然带上降级保护：`kaas_common` 是 scripts/sync-shared.ps1 复制进来的
#     **构建产物**（`backend/worker/.gitignore` 忽略了 `src/kaas_common/`，B
#     不进版本控制）。若部署链路漏了同步这一步，导入会失败 —— 而模块级失败会让
#     main.py 末尾的 `import quote_api` 直接抛异常、**整个 Worker 起不来**
#     （连 /health 与既有 130+ 接口一起挂）。所以引擎缺失时本工位统一回 503
#     并说清楚怎么修，而不是让一个工位拖垮整个 API。
_ENGINE_LOADED = False
_ENGINE_IMPORT_ERROR = ""

# 这两个值在**导入期**就会被求值（Pydantic 字段默认值），所以必须是模块级字面量、
# 不能走 __getattr__ 惰性取 —— 否则一次类定义就会把整个引擎拉回来，惰性形同虚设。
# 取值须与引擎保持一致：DEFAULT_VALIDITY_DAYS ← engine.py:33 / MAX_ROWS ← importers.py:34。
DEFAULT_VALIDITY_DAYS = 7
MAX_ROWS = 2000

# 需要补进本模块命名空间的引擎符号全集（与 dev 侧 app.services.export_quote 同源同名）。
# 用显式白名单而不是 `**引擎包.__dict__`：后者会把 `engine`/`models`/`report` 等
# 子模块名也灌进来，可能与本模块的局部名（甚至变量名）相撞，而且撞了不报错。
_ENGINE_SYMBOLS = (
    "EngineError", "ImportError_", "PricingError", "RateSetError",
    "RateSetRegistry", "TermsError", "build", "build_customer_view",
    "build_internal_view", "build_template_csv", "describe_product",
    "describe_pricing_key", "get_product", "ladder_from_dict",
    "make_request_from_config", "parse_table", "product_keys",
    "template_columns", "template_headers", "verify_all", "extend_product",
    "pricing_key_defined_values", "pricing_key_of", "pricing_key_value",
    "quote_meta", "default_terms_template",
)


def _ensure_engine_loaded() -> bool:
    """首次调用时导入引擎并注入本模块命名空间；返回是否可用。"""
    global _ENGINE_LOADED, _ENGINE_IMPORT_ERROR
    if _ENGINE_LOADED:
        return not _ENGINE_IMPORT_ERROR
    _ENGINE_LOADED = True
    try:
        from kaas_common.export_quote import (  # noqa: E402
            EngineError,
            ImportError_,
            PricingError,
            RateSetError,
            RateSetRegistry,
            TermsError,
            build,
            build_customer_view,
            build_internal_view,
            build_template_csv,
            describe_product,
            get_product,
            ladder_from_dict,
            make_request_from_config,
            parse_table,
            product_keys,
            template_columns,
            template_headers,
            verify_all,
        )
        # 这几个没进包的 __all__，按子模块取（与 dev 的 import 路径一致）。
        from kaas_common.export_quote.formulas import describe_pricing_key  # noqa: E402
        from kaas_common.export_quote.importers import MAX_ROWS as _MAX_ROWS  # noqa: E402
        from kaas_common.export_quote.models import (  # noqa: E402
            extend_product,
            pricing_key_defined_values,
            pricing_key_of,
            pricing_key_value,
        )
        from kaas_common.export_quote.report import quote_meta  # noqa: E402
        from kaas_common.export_quote.terms_template import (  # noqa: E402
            default_terms_template,
        )

        _local = locals()
        globals().update({name: _local[name] for name in _ENGINE_SYMBOLS})
        # 引擎侧同名常量若与上面的字面量不一致，说明两侧口径已经分叉 ——
        # 这里只记录，不改已经定型的模型默认值（改不了），但让它在 /health 之外可见。
        if _MAX_ROWS != MAX_ROWS:
            globals()["_ENGINE_CONST_DRIFT"] = "MAX_ROWS: 本地 %s / 引擎 %s" % (MAX_ROWS, _MAX_ROWS)
    except Exception as _exc:  # noqa: BLE001 - 任何导入失败都不该让 Worker 起不来
        _ENGINE_IMPORT_ERROR = "%s: %s" % (type(_exc).__name__, _exc)
        globals().update({name: None for name in _ENGINE_SYMBOLS})
        for _name in ("EngineError", "PricingError", "RateSetError", "TermsError", "ImportError_"):
            globals()[_name] = Exception
        return False
    return True


def __getattr__(name: str):
    """模块级惰性（PEP 562）：只有真正取用引擎符号时才付导入代价。"""
    if name in _ENGINE_SYMBOLS:
        _ensure_engine_loaded()
        return globals().get(name)
    raise AttributeError("module %r has no attribute %r" % (__name__, name))


def _require_engine() -> None:
    """引擎没打进包时明确 503（并说清楚怎么修），不假装能算。

    这里也是**唯一**触发引擎导入的入口：所有报价端点第一行都调它。
    """
    if not _ensure_engine_loaded():
        raise HTTPException(status_code=503, detail={
            "error": "engine_unavailable",
            "message": ("报价引擎未随 Worker 打包（kaas_common.export_quote 导入失败：%s）。"
                        "部署前请执行 `pwsh scripts/sync-shared.ps1`，"
                        "并确认 backend/worker/src/kaas_common/ 被打进了包。"
                        % _ENGINE_IMPORT_ERROR),
        })


# ═════════════════════════════════════════════════════════════════════════════
# 身份 / 权限
# ═════════════════════════════════════════════════════════════════════════════
# 线上是单租户（DEFAULT_TENANT），users 也还没有客户绑定列。dev 的
# AuthContext.tenant_id / customer_id_str 在这里用「可选键 + 回退」表达：
# 一旦给 users 加了这两列并让 _get_current_user select 出去，本模块无需改动。
def _tenant_of(user: dict) -> str:
    return str(user.get("tenant_id") or DEFAULT_TENANT)


def _customer_of(user: dict) -> str:
    """当前客户的 customer_id 字符串（对齐 dev 的 AuthContext.customer_id_str）。

    dev：`customer_code or str(customer_id) if customer_id else ""`，再由调用方
    回退到 tenant。线上 users 表暂无这两列 → 回退到租户（= 单租户下的"本租户"）。
    """
    code = user.get("customer_code")
    cid = user.get("customer_id")
    return str(code or (str(cid) if cid else "") or _tenant_of(user))


def _is_internal_admin(user: dict) -> bool:
    """内部核算视图的权限（对齐 dev `export_quote._require_admin`：internal + system_admin）。

    account_type 在真实 `_get_current_user` 里一定有（它已经 select 了这一列）；
    只有本地测试台的身份桩没有该字段 —— 那时退回「只看 role」，否则本地无法验证。
    （`role` 为 `admin` 时 dev 的 effective_role 也映射成 system_admin，故一并放行。）
    """
    if str(user.get("role") or "") not in ("system_admin", "admin"):
        return False
    account_type = user.get("account_type")
    return account_type is None or str(account_type) == "internal"


def _require_internal_admin(user: dict) -> None:
    if not _is_internal_admin(user):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "message": "内部核算视图需要租户管理员权限"})


def _scope_sql(user: dict, params: list, table_alias: str = "") -> str:
    """§10.3 + 三层组织 可见范围 → SQL 片段（参数追加进 params，返回以 " AND " 开头的片段）。

    与 main.py 的 `/api/v1/orders` 及 dev 的 `ws_common.scope_filter` 同语义：
    管理员看全部；其他人只看到「自己名下」+「owner_scope=tenant 的共享数据」
    +「**本团队**的数据」（2026-10-11 新增，规则真源 = kaas_common/workstation/scope.py）。
    """
    if _can_see_all(user):
        return ""
    params.append(str(user["id"]))
    p = f"${len(params)}"
    col = (lambda c: f"{table_alias}.{c}") if table_alias else (lambda c: c)
    cond = f"({col('owner_id')} = {p} OR {col('owner_scope')} = 'tenant'"
    if user.get("team_id") is not None:
        params.append(user["team_id"])
        cond += f" OR {col('team_id')} = ${len(params)}"
    return f" AND {cond})"


def _identity_match(user: dict, body: Optional[dict], tenant: str, customer: str) -> None:
    """拒绝请求体里夹带的身份参数（对齐 dev `require_tenant_match`/`require_customer_match`）。

    身份永远来自 token，不来自前端 —— 否则改一个字段就能读别人的档案。
    内部账号（管理员）按 dev 口径不校验。
    """
    if body is None or _is_internal_admin(user):
        return
    want_tenant = body.get("tenant_id")
    if want_tenant and str(want_tenant) != tenant:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "message": "Tenant ID does not match your authorized tenant"})
    want_customer = body.get("customer_id")
    if want_customer and str(want_customer) != customer:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "message": "Customer ID does not match your authorized customer"})


# ═════════════════════════════════════════════════════════════════════════════
# 枚举白名单
# ═════════════════════════════════════════════════════════════════════════════
# 真源是 backend/orchestrator/app/domain/enums.py。线上只带本工位用到的三张表
# （整份复制过去只会多一处需要同步的副本）；值必须逐字一致，否则同一状态在
# dev 能存、线上 422。
_QUOTE_STATUS = ("draft", "sent", "accepted", "rejected", "expired")
_CURRENCY = ("USD", "CNY", "EUR", "GBP", "JPY", "AUD", "CAD", "HKD")
_OWNER_SCOPE = ("private", "tenant")

# 报价单状态机（§10.4）：draft → sent → accepted / rejected / expired
_QUOTE_NEXT = {
    "draft": ("sent", "expired"),
    "sent": ("accepted", "rejected", "expired"),
}
# 允许写行项的状态：签发之后是法律凭证，上游改动不得再影响它。
_QUOTE_EDITABLE_STATUS = ("draft",)

# 报价记录台账的来源标记（与 dev quote_orders.LEDGER_SOURCE_QUOTE_ISSUED 一致）
_LEDGER_SOURCE_QUOTE_ISSUED = "quote_issued"


def _validate_enum(field: str, value: Optional[str], allowed: tuple) -> Optional[str]:
    if value is None:
        return None
    if value not in allowed:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_enum_value", "code": "INVALID_ENUM", "field": field,
            "value": value, "allowed": list(allowed)})
    return value


def _iso(value: Any) -> Optional[str]:
    """date/datetime → ISO 字符串（dev 的 `.isoformat()`）；None 原样返回。"""
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _f(value: Any) -> Optional[float]:
    """NUMERIC → float（dev 侧是 `float(q.total_amount) if ... is not None else None`）。

    必须显式转：asyncpg 把 NUMERIC 返回成 Decimal，直接进 JSON 会失败。
    """
    return None if value is None else float(value)


# ═════════════════════════════════════════════════════════════════════════════
# 出口报价 · 元数据（产品 / 税务档案 / 条款模板）
# ═════════════════════════════════════════════════════════════════════════════
# 税务档案注册表按进程缓存（档案是只读的文件；变更需重新部署或调 reload）。
_EQ_REGISTRY: Optional[RateSetRegistry] = None


def _registry(force: bool = False) -> RateSetRegistry:
    _require_engine()
    global _EQ_REGISTRY
    if _EQ_REGISTRY is None or force:
        # 不传目录 → 引擎用包内的 rate_sets/（镜像里只有 .json，因为线上没有 PyYAML）
        _EQ_REGISTRY = RateSetRegistry.from_dir()
    return _EQ_REGISTRY


def _product_or_404(product_key: str):
    _require_engine()
    try:
        return get_product(product_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={
            "error": "unknown_product", "message": str(exc)})


@app.get("/api/v1/export-quote/products")
async def export_quote_products(request: Request, user: dict = Depends(_get_current_user)):
    """已注册的产品模型（前端产品下拉的唯一来源）。

    发现层合并（2026-10-17，与 dev 同口径）：Python 注册表 ∪ tenant_products
    中调用者可见的行（本团队行优先；历史 NULL 行仅管理员），同 key tenant 行覆盖
    Python 定义 —— 运行时新增的产品在下拉里可见、可选、可算价。
    """
    _require_engine()
    from kaas_common.workstation.product_scope import is_same_team
    from kaas_common.workstation.scope import is_admin_role
    from kaas_common.export_quote.tenant_products import spec_from_dict

    specs: dict = {}
    for key in product_keys():
        specs[key] = get_product(key)

    tenant = _tenant_of(user)
    rows = await _db.fetch(  # noqa: SLF001 - 同模块既有用法
        request,
        "SELECT product_key, spec, team_id FROM tenant_products"
        " WHERE tenant_id=$1 AND is_active",
        tenant,
        table="tenant_products",
    )
    best: dict = {}
    for r in rows:
        key = r["product_key"]
        row_team = r["team_id"]
        if row_team is not None and is_same_team(
            role=user.get("role"), viewer_team_id=user.get("team_id"),
            row_team_id=row_team,
        ):
            best[key] = r["spec"]
        elif row_team is None and is_admin_role(user.get("role")):
            best.setdefault(key, r["spec"])
    for key, spec_dict in best.items():
        try:
            specs[key] = spec_from_dict(spec_dict)
        except Exception:  # noqa: BLE001 - 单条坏定义不拖垮整个列表
            continue

    out = []
    for spec in specs.values():
        out.append({
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
            "metric_count": (len(spec.derived) + len(spec.piece_metrics)
                             + len(spec.order_metrics)),
            "invariant_count": len(spec.invariants),
        })
    return {"products": out, "total": len(out)}


@app.get("/api/v1/export-quote/products/{product_key}/formulas")
async def export_quote_product_formulas(
    product_key: str,
    request: Request,
    with_columns: bool = False,
    with_customer_options: bool = True,
    customer_id: str = "",
    user: dict = Depends(_get_current_user),
):
    """产品的「计算说明书」：规格空间 + 每条公式的口径 + 列定义。

    - `with_columns=true` 会一并带回**列定义**（key/label/decimals/internal）。
      多产品工作台必须用它：结果表只有表头文字，按中文名猜"哪一列是单卷外币价"
      会静默落错库。
    - `with_customer_options`（默认 true）把「客户自己在定价数据里加的档位」并进
      规格空间 —— 与算价接口用的是同一份有效定义，避免"下拉能选、一算就报错"
      或"算了但下拉里选不到"。
    - `customer_id` 只允许**管理员**指定（读别的客户的档位）；普通账号传了也会被
      强制回退到自己，防止越权读别家档位。
    """
    spec = _product_or_404(product_key)
    if with_customer_options:
        wanted = None
        if customer_id and _can_see_all(user):
            wanted = customer_id
        spec = await _with_customer_options(request, user, spec, wanted)
    return describe_product(spec, with_columns=with_columns)


@app.get("/api/v1/export-quote/rate-sets")
async def export_quote_rate_sets(user: dict = Depends(_get_current_user)):
    """可用税务档案（法定税率，纯引擎读取 —— 不查库、无租户维度）。"""
    try:
        reg = _registry()
    except Exception as exc:  # noqa: BLE001 - 线上自检：别用裸 500 把原因吞掉
        raise HTTPException(
            status_code=503,
            detail=f"rate_sets_unavailable: {type(exc).__name__}: {exc}",
        ) from exc
    out = []
    for rs in reg.all():
        out.append({
            "code": rs.code,
            "name": rs.name,
            "country": rs.country,
            "effective_from": _iso(rs.effective_from),
            "effective_to": _iso(rs.effective_to),
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
        })
    return {"rate_sets": out, "total": len(out)}


@app.get("/api/v1/export-quote/terms/template")
async def export_quote_terms_template(user: dict = Depends(_get_current_user)):
    """平台默认的出口费用结构（贸易术语阶梯 + 费用项）。

    返回的形状**就是**报价请求里 `terms` 的形状：界面原样回传、只填 value，
    因此「FOB 包含哪些费」这类业务知识留在后端，前端不写死。
    """
    _require_engine()
    return default_terms_template()


@app.post("/api/v1/export-quote/rate-sets/reload")
async def export_quote_rate_sets_reload(user: dict = Depends(_get_current_user)):
    """重新加载税务档案（管理员）。

    线上是只读文件系统 + 每 isolate 一份模块状态，本接口实际只清缓存；
    保留它是为了与 dev 的路由集合一致（前端与巡检脚本会打它）。
    """
    if not _is_internal_admin(user):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "message": "内部核算视图需要租户管理员权限"})
    reg = _registry(force=True)
    return {"reloaded": True, "codes": reg.codes}


# ═════════════════════════════════════════════════════════════════════════════
# 客户定价数据 → 引擎的成本表（dev: app/services/pricing_table.py 的搬运）
# ═════════════════════════════════════════════════════════════════════════════
_PRICING_SEPARATOR = ":"


def _pricing_prefix(product_key: str) -> str:
    return f"{product_key}{_PRICING_SEPARATOR}"


async def _pricing_key_items(request: Request, tenant: str, customer_id: Optional[str],
                             product_key: str) -> list:
    """某产品下的定价键成本记录（最新在前）。

    customer_id=None → 不限客户（管理员视角：看所有客户的配置）。

    这里刻意用 `left(spec_hash, length($2)) = $2` 而不是 `LIKE 'prefix%'`：
    产品 key 里带下划线（field_fence），LIKE 会把 `_` 当单字符通配符，
    不转义就会把 `fieldXfence:` 之类的键一起捞进来（dev 侧靠
    SQLAlchemy 的 `autoescape=True` 解决，raw SQL 没有那层保险）。
    """
    sql = (
        "SELECT id, customer_id, product_spec_json, spec_hash, amount, unit,"
        " effective_from, source, notes"
        " FROM customer_cost_items"
        " WHERE tenant_id=$1 AND left(spec_hash, length($2))=$2 AND status='active'"
    )
    params: list = [tenant, _pricing_prefix(product_key)]
    if customer_id is not None:
        params.append(customer_id)
        sql += f" AND customer_id=${len(params)}"
    sql += " ORDER BY id DESC"
    return await _db.fetch(request, sql, *params, table="customer_cost_items")


def _matrix_rows(product) -> list:
    """产品定价键的完整取值组合（笛卡尔积），顺序与界面列一致。"""
    dims = describe_pricing_key(product)
    if not dims:
        return []
    rows = []
    for combo in _cartesian(*[d["options"] for d in dims]):
        values = {d["field"]: opt["value"] for d, opt in zip(dims, combo)}
        rows.append({
            "values": values,
            "labels": [opt["label"] for opt in combo],
            "key": pricing_key_of(product, values),
        })
    return rows


async def _load_option_extensions(request: Request, tenant: str, customer_id: Optional[str],
                                  product) -> dict:
    """从客户定价数据反推「客户自己加的档位」（dev 同源实现）。

    定价数据就是档位的来源，不另建表：库里出现过一个产品定义没有的取值，
    就说明客户要用这个档位 —— 规格下拉里也就该多出这一项。这样"加档位"只有
    一步（录成本），不会出现"成本录了、选项忘了加"的裂缝。
    """
    fields = [d["field"] for d in (product.pricing_key or []) if d.get("field")]
    if not fields:
        return {}
    items = await _pricing_key_items(request, tenant, customer_id, product.key)
    defined = pricing_key_defined_values(product)
    out: dict = {}
    seen: dict = {}
    for item in items:
        payload = item.get("product_spec_json") or {}
        values = payload.get("values") if isinstance(payload, dict) else None
        if not isinstance(values, dict):
            continue
        labels = payload.get("labels") or {}
        for field in fields:
            if field not in values:
                continue
            raw = values[field]
            canonical = pricing_key_value(raw)
            if canonical in defined.get(field, set()):
                continue  # 产品定义里本来就有，不算新增
            if canonical in seen.setdefault(field, set()):
                continue
            seen[field].add(canonical)
            out.setdefault(field, []).append({
                "value": raw,
                "label": str(labels.get(field) or raw),
            })
    return out


async def _with_customer_options(request: Request, user: dict, product,
                                 customer_id: Optional[str] = None):
    """把「客户自己在定价数据里加的档位」并入产品定义。

    只在这里拼一次，同时喂给「规格空间接口」与「算价接口」—— 两边看到的选项
    必须**完全一致**，否则会出现"下拉里能选、一算就报错"。
    """
    if not product.pricing_key:
        return product
    cid = customer_id or _customer_of(user)
    exts = await _load_option_extensions(request, _tenant_of(user), cid, product)
    return extend_product(product, exts)


async def _load_cost_table(request: Request, user: dict, body: "_CalculateIn",
                           product=None) -> dict:
    """按「当前客户 + 产品定价键」把客户定价数据读成引擎用的成本表。

    读不到（产品没声明定价键 / 不存在 / 客户没配价）就返回空表 —— 引擎随即回退
    产品定义里的内联成本。这是"未配置不影响老报价"的关键。
    """
    _require_engine()
    if not body.product_key:
        return {}
    if product is None:
        try:
            product = get_product(body.product_key)
        except Exception:
            return {}  # 产品不存在时让引擎报它自己的错，这里不抢先
    if not product.pricing_key:
        return {}
    items = await _pricing_key_items(request, _tenant_of(user),
                                     _customer_of(user), product.key)
    table: dict = {}
    for item in items:
        spec_hash = item.get("spec_hash") or ""
        if not spec_hash.startswith(_pricing_prefix(product.key)):
            continue
        key = spec_hash.split(_PRICING_SEPARATOR, 1)[1]
        if key in table:
            continue  # 已有更新的版本（查询按 id 倒序）
        amount = item.get("amount")
        if amount is not None and float(amount) > 0:
            table[key] = float(amount)
    # 只保留产品当前仍存在的组合：产品改了档位之后，库里残留的旧键不该继续参与
    # 报价 —— 否则会出现"界面上没有、报价里却在用"的价。
    valid = {row["key"] for row in _matrix_rows(product)}
    if valid:
        table = {k: v for k, v in table.items() if k in valid}
    return table


async def _effective_product(request: Request, user: dict, product_key: str):
    """有效规格空间；产品不存在时返回 None。

    「产品不存在」在算价入口交给引擎按它自己的口径报（400 engine_error），
    在规格空间入口由调用方报 404 —— 同一个错误在不同入口状态码本来就不同。

    与 dev `export_quote._effective_product` 同口径（2026-10-17 对齐）：
    1. tenant_products 按团队谓词取行（本团队 > 历史 NULL 仅管理员），
       基线 + override 差异走 resolve_effective_product（hash 不符抛
       SpecUpstreamChanged，绝不静默套用）；2. 回退 Python 注册表。
    """
    _require_engine()
    if not product_key:
        return None
    from kaas_common.workstation.product_scope import is_same_team
    from kaas_common.workstation.scope import is_admin_role
    from kaas_common.export_quote.effective_spec import (
        SpecUpstreamChanged,
        resolve_effective_product,
    )

    tenant = _tenant_of(user)
    rows = await _db.fetch(  # noqa: SLF001 - 同模块既有用法
        request,
        "SELECT spec, override, team_id FROM tenant_products"
        " WHERE tenant_id=$1 AND product_key=$2 AND is_active",
        tenant, product_key,
        table="tenant_products",
    )
    # 与 dev _fetch_tenant_product 同优先级：本团队行 > 历史 NULL 行（仅管理员）
    picked = None
    for r in rows:
        if r["team_id"] is not None and is_same_team(
            role=user.get("role"), viewer_team_id=user.get("team_id"),
            row_team_id=r["team_id"],
        ):
            picked = r
            break
    if picked is None and is_admin_role(user.get("role")):
        for r in rows:
            if r["team_id"] is None:
                picked = r
                break
    if picked is not None:
        try:
            spec, _warnings = resolve_effective_product(
                picked["spec"], picked["override"])
        except SpecUpstreamChanged:
            return None  # 上游已变更：按"产品不可用"处理（dev 侧报 409）
        if spec is not None:
            return await _with_customer_options(request, user, spec)
    try:
        product = get_product(product_key)
    except Exception:
        return None
    return await _with_customer_options(request, user, product)


# ═════════════════════════════════════════════════════════════════════════════
# 报价计算
# ═════════════════════════════════════════════════════════════════════════════
class _OrderIn(BaseModel):
    name: Optional[str] = None
    total: float
    unit: str = "m"
    label: Optional[str] = None
    label_en: Optional[str] = None


class _PolicyIn(BaseModel):
    """报价政策覆盖项；未给的字段从税务档案取法定默认值。"""

    input_vat_rate: Optional[float] = Field(default=None, description="进项票税点，如 0.10")
    output_vat_rate: Optional[float] = Field(default=None, description="销项税率；出口零税率填 0")
    output_vat_mode: Optional[str] = Field(default=None, description="additive | inclusive")
    profit_mode: Optional[str] = Field(default=None, description="fixed | ratio | margin_on_price")
    profit_value: Optional[float] = None
    misc_fee_rate: Optional[float] = Field(
        default=None,
        description="综合税费系数（除销项增值税外的杂税总和，相对销项计征；售价加成模式使用）",
    )
    give_ratio: Optional[float] = Field(default=None, description="让出可退进项增值税额的比例")
    refund_ratio: Optional[Any] = Field(
        default=None, description="可退税比例；'auto' = 出口退税率 ÷ 进项票税点")
    rebate_rate: Optional[float] = Field(default=None, description="出口退税率（auto 模式使用）")
    stamp_rate: Optional[float] = Field(default=None, description="印花税率")
    stamp_base: Optional[str] = Field(default=None, description="profit | cost | base_quote")
    extras: Optional[List[dict]] = None


class _CalculateIn(BaseModel):
    product_key: str = Field(description="产品模型 key，如 field_fence")
    rate_set_code: Optional[str] = Field(default=None, description="税务档案编号；空则按报价日取当期生效的一份")
    fx_rate: float = Field(description="汇率：1 报价币 = ? 本币")
    fx_source: str = ""
    orders: List[_OrderIn] = Field(description="订单量方案，至少一个")
    policy: Optional[_PolicyIn] = None
    terms: Optional[dict] = Field(default=None, description="贸易术语阶梯配置")
    price_inputs: Optional[dict] = Field(default=None, description="当期价格输入（运费等）")
    variant_overrides: Optional[dict] = Field(default=None, description="变体数值覆盖")
    spec_rows: Optional[List[dict]] = Field(
        default=None, description="只算这些规格行；不传则展开产品的全部组合")
    constants_override: Optional[dict] = None
    validity_days: int = Field(default=DEFAULT_VALIDITY_DAYS, ge=1, le=365)
    quote_date: Optional[date] = None
    with_verification: bool = Field(default=False, description="是否附带三遍核验结果")
    currency: str = "CNY"
    quote_currency: str = "USD"


def _assemble_request(body: _CalculateIn, user: dict, cost_table: Optional[dict] = None,
                      product=None):
    """把接口请求组装成引擎的 QuoteRequest（逐行对齐 dev 的 `_assemble_request`）。

    为什么不用 `make_request_from_config` 一把梭：它读的是「报价单配置」形状
    （product/policy/fx/orders 分组），而接口请求是扁平字段；更关键的是它
    把 policy 直接喂给 `policy_from_dict`（缺省值全是 0），而本工位的缺省值必须
    是**税务档案的法定值**（进项 10%、销项取档案、利润 0.1、让利 0.8、印花取档案）。
    少这一层，税率会静默变成 0，整张报价单系统性偏低而金额看着正常。
    """
    try:
        rs = _registry().resolve(body.rate_set_code, body.quote_date)
    except RateSetError as exc:
        raise HTTPException(status_code=400, detail={"error": "rate_set_error", "message": str(exc)})

    # 政策：档案给法定默认，请求显式给的覆盖
    base_cfg: dict = {
        "input_vat_rate": 0.10,
        "output_vat": {"rate": rs.output_rate_export, "mode": "additive"},
        "profit": {"mode": "fixed", "value": 0.1},
        "misc_fee_rate": 0.03,
        "refund": {"refund_ratio": "auto", "give_ratio": 1},
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
        for k in ("give_ratio", "refund_ratio", "rebate_rate"):
            if k in p:
                base_cfg.setdefault("refund", {})[k] = p.pop(k)
        if "misc_fee_rate" in p:
            base_cfg["misc_fee_rate"] = p.pop("misc_fee_rate")
        for k in ("stamp_rate", "stamp_base"):
            if k in p:
                base_cfg.setdefault("stamp", {})[k.replace("stamp_", "")] = p.pop(k)
        base_cfg.update(p)

    # 术语：先按 dev 的口径把 TermsError 翻成 400 terms_error（引擎内部会把它
    # 包成 EngineError，那是"引擎错误"，错误码就对不上了）。
    if body.terms:
        try:
            ladder_from_dict(body.terms)
        except TermsError as exc:
            raise HTTPException(status_code=400, detail={"error": "terms_error", "message": str(exc)})

    # 订单量方案的默认名称/标签：dev 用 float.is_integer() 去掉小数尾巴
    # （30000.0 → "30000米"），与标签一起进结果表与单证，所以必须逐字一致。
    orders = []
    for o in body.orders:
        total = o.total
        name = o.name or f"o{int(total) if float(total).is_integer() else total}"
        default_label = f"{int(total)}米" if o.unit == "m" else f"{total} {o.unit}".strip()
        orders.append({
            "name": name,
            "label": o.label or default_label,
            "label_en": o.label_en or f"{total} {o.unit}".strip(),
            "total": total,
            "unit": o.unit,
        })

    cfg = {
        "product": {
            "model": body.product_key,
            "constants": body.constants_override or {},
            "variant_overrides": body.variant_overrides or {},
        },
        "policy": base_cfg,
        "fx": {"rate": body.fx_rate, "source": body.fx_source},
        "orders": orders,
        "terms": body.terms,
        "price_inputs": body.price_inputs or {},
        "validity_days": body.validity_days,
        "meta": {"base_currency": body.currency, "quote_currency": body.quote_currency},
        "tenant_id": _tenant_of(user),
    }
    try:
        req = make_request_from_config(cfg, rate_set=rs)
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"error": "engine_error", "message": str(exc)})
    except PricingError as exc:
        raise HTTPException(status_code=400, detail={"error": "policy_error", "message": str(exc)})

    # 这四项 `make_request_from_config` 不认（它面向报价单配置，不是引擎入参全集）
    req.product = product
    req.cost_table = cost_table or {}
    req.spec_rows = [dict(r) for r in body.spec_rows] if body.spec_rows else None
    req.quote_date = body.quote_date
    return req


def _run_calculation(body: _CalculateIn, user: dict, view: str,
                     cost_table: Optional[dict] = None, product=None) -> dict:
    req = _assemble_request(body, user, cost_table, product)
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


@app.post("/api/v1/export-quote/calculate")
async def export_quote_calculate(request: Request, body: _CalculateIn,
                                 user: dict = Depends(_get_current_user)):
    """客户视图算价：只含规格、重量体积、外币价，不含成本/税额/利润推导。

    前端即便直接渲染这个响应也不会泄露成本利润率。
    """
    product = await _effective_product(request, user, body.product_key)
    return _run_calculation(
        body, user, "customer",
        await _load_cost_table(request, user, body, product), product)


@app.post("/api/v1/export-quote/calculate-internal")
async def export_quote_calculate_internal(request: Request, body: _CalculateIn,
                                         user: dict = Depends(_get_current_user)):
    """内部核算视图（含成本、利润、税额、退税推导）—— 需要租户管理员。"""
    _require_internal_admin(user)
    product = await _effective_product(request, user, body.product_key)
    return _run_calculation(
        body, user, "internal",
        await _load_cost_table(request, user, body, product), product)


@app.post("/api/v1/export-quote/verify")
async def export_quote_verify(request: Request, body: _CalculateIn,
                              user: dict = Depends(_get_current_user)):
    """对一次报价跑三遍核验（管理员）。"""
    _require_internal_admin(user)
    body.with_verification = True
    product = await _effective_product(request, user, body.product_key)
    req = _assemble_request(
        body, user, await _load_cost_table(request, user, body, product), product)
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


# ═════════════════════════════════════════════════════════════════════════════
# 表格批量导入
# ═════════════════════════════════════════════════════════════════════════════
_IMPORT_MAX_MB = 2
# xlsx/xls 的魔数：zip（xlsx 是 zip 包）与 OLE2（老 .xls）
_ZIP_MAGIC = b"PK"
_OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _is_spreadsheet(data: bytes, filename: str) -> bool:
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm", ".xls")):
        return True
    return data[:2] == _ZIP_MAGIC or data[:8] == _OLE2_MAGIC


def _reject_spreadsheet(data: bytes, filename: str) -> None:
    """xlsx/xls 一律拒掉并**指路 CSV**，不做静默退化。

    线上 Pyodide 里装不了 openpyxl（它依赖 C 扩展），所以 xlsx 既读不了也生成不了。
    如果放任下去，`parse_table` 只会抛一句"缺少 openpyxl"—— 那对业务没有可执行的
    信息（他不知道该怎么办）。这里明确说"另存为 CSV"，一次就能改对。
    """
    if _is_spreadsheet(data, filename):
        raise HTTPException(status_code=400, detail={
            "error": "xlsx_not_supported",
            "message": ("线上批量导入只支持 CSV：请在 Excel 里另存为"
                        "「CSV UTF-8（逗号分隔）」后重新上传"
                        "（xlsx 解析依赖 openpyxl，Worker 打不进 C 扩展）"),
        })


async def _read_upload(file: UploadFile) -> bytes:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail={
            "error": "empty_file", "message": "上传的文件是空的"})
    limit = _IMPORT_MAX_MB * 1024 * 1024
    if len(data) > limit:
        raise HTTPException(status_code=400, detail={
            "error": "file_too_large",
            "message": "文件过大（%.1f MB），上限 %d MB" % (len(data) / 1048576, _IMPORT_MAX_MB)})
    return data


def _parse_or_400(data: bytes, spec, filename: str = "", sheet: Optional[str] = None):
    try:
        return parse_table(data, spec, filename=filename, sheet=sheet)
    except ImportError_ as exc:
        raise HTTPException(status_code=400, detail={
            "error": "parse_error", "message": str(exc)})


def _template_headers(spec, include_spec: bool) -> dict:
    """模板响应的自定义头。

    `X-Template-Columns` 用 `ensure_ascii=True` 序列化是**必须的**：HTTP 头只能
    装 latin-1，中文列名（竖丝间距(cm)）直接放进去会让整个响应崩掉。
    """
    headers = {
        "Content-Disposition":
            'attachment; filename="%s-import-template.%s"' % (spec.key, "csv"),
        "X-Template-Columns": json.dumps(template_headers(spec)),
        "Access-Control-Expose-Headers": "X-Template-Columns, Content-Disposition",
    }
    if include_spec:
        headers["X-Template-Spec"] = json.dumps([c.to_dict() for c in template_columns(spec)])
        headers["Access-Control-Expose-Headers"] = (
            "X-Template-Columns, X-Template-Spec, Content-Disposition")
    return headers


def _template_response(spec, fmt: str, examples: Optional[int], include_spec: bool) -> Response:
    """模板下载。csv 出文件；xlsx 明确 501 —— 见 `_reject_spreadsheet` 的说明。"""
    if fmt == "xlsx":
        raise HTTPException(status_code=501, detail=(
            "线上仅支持 CSV 模板，请改用 format=csv"
            "（xlsx 模板依赖 openpyxl，Worker 打不进 C 扩展）"))
    if fmt != "csv":
        raise HTTPException(status_code=422, detail={
            "error": "bad_format", "message": "format 只能是 csv（线上不支持 xlsx）"})
    # dev：csv 默认 0 行示例（给脚本生成用），xlsx 默认 3 行
    rows = 0 if examples is None else examples
    body = ("\ufeff" + build_template_csv(spec, examples=rows)).encode("utf-8")
    return Response(content=body, media_type="text/csv; charset=utf-8",
                    headers=_template_headers(spec, include_spec))


@app.get("/api/v1/export-quote/import/template")
async def export_quote_import_template(
    product_key: str = Query("field_fence", description="产品模型 key"),
    format: str = Query("xlsx", description="xlsx（dev 默认，线上 501）或 csv"),
    examples: Optional[int] = Query(None, ge=0, le=50),
    include_spec: bool = Query(False, description="是否随附列定义（JSON 头）"),
    user: dict = Depends(_get_current_user),
):
    """下载批量导入模板（线上只支持 csv）。"""
    spec = _product_or_404(product_key)
    return _template_response(spec, format, examples, include_spec)


@app.get("/api/v1/export-quote/products/{product_key}/import-template")
async def export_quote_import_template_info(
    product_key: str,
    format: str = Query("", description="给了就下载文件（csv；xlsx 501），不给则返回列定义 JSON"),
    examples: Optional[int] = Query(None, ge=0, le=50),
    include_spec: bool = Query(False),
    user: dict = Depends(_get_current_user),
):
    """模板说明（有哪些列、哪些必填、单位、可选值）；带 `format` 时改为下载文件。

    为什么一个路由兼两职：前端只用这一个 URL（`useImportTemplateInfo` 不带
    `format`、下载时带 `format`），而 dev 侧拆成了 `/products/{key}/import-template`
    （说明）与 `/import/template`（文件）两个 —— 线上把 dev 的"文件"那一路
    也映射到这里，使前端两条调用都能命中同一个后端语义，不必改前端。
    """
    spec = _product_or_404(product_key)
    if format:
        return _template_response(spec, format, examples, include_spec)

    cols = template_columns(spec)
    return {
        "product_key": spec.key,
        "product_name": spec.name,
        "columns": [c.to_dict() for c in cols],
        "headers": [c.header for c in cols],
        "required_headers": [c.header for c in cols if c.required],
        "max_rows": MAX_ROWS,
        "max_mb": _IMPORT_MAX_MB,
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
            "线上只支持 CSV（UTF-8，可带 BOM）：在 Excel 里「另存为 CSV UTF-8」即可。",
            "列名括号里的就是该列单位，按单位填原值即可，不要自己换算。",
        ],
    }


@app.post("/api/v1/export-quote/import/preview")
async def export_quote_import_preview(
    request: Request,
    file: UploadFile = File(description="CSV 规格表"),
    product_key: str = Form("field_fence"),
    sheet: Optional[str] = Form(default=None),
    user: dict = Depends(_get_current_user),
):
    """先看清解析成了什么，再决定要不要算（只支持 CSV）。"""
    spec = _product_or_404(product_key)
    data = await _read_upload(file)
    _reject_spreadsheet(data, file.filename or "")
    parsed = _parse_or_400(data, spec, file.filename or "", sheet)
    payload = parsed.to_dict()
    payload["product_key"] = spec.key
    payload["product_name"] = spec.name
    payload["expected_columns"] = template_headers(spec)
    return payload


@app.post("/api/v1/export-quote/import/calculate")
async def export_quote_import_calculate(
    request: Request,
    file: UploadFile = File(description="CSV 规格表"),
    payload: str = Form(description="计算参数（_CalculateIn 的 JSON 字符串）"),
    product_key: str = Form("field_fence"),
    sheet: Optional[str] = Form(default=None),
    view: str = Form("customer", description="customer | internal"),
    user: dict = Depends(_get_current_user),
):
    """把整张表的规格一次算完（只支持 CSV）。坏行跳过并随结果一起回报。"""
    if view not in ("customer", "internal"):
        raise HTTPException(status_code=400, detail={
            "error": "bad_view", "message": "view 只能是 customer 或 internal"})
    if view == "internal":
        _require_internal_admin(user)

    spec = _product_or_404(product_key)
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
        body = _CalculateIn(**raw)
    except Exception as exc:
        # 用 pydantic 自己的 JSON 序列化再 loads：`exc.errors()` 的 ctx 里可能带
        # 原始异常对象，直接塞进 detail 会让 422 变成 500（FastAPI 编不出来）。
        try:
            detail = json.loads(exc.json())[:5]  # type: ignore[attr-defined]
        except Exception:
            detail = str(exc)
        raise HTTPException(status_code=422, detail={"error": "invalid_payload", "message": detail})

    data = await _read_upload(file)
    _reject_spreadsheet(data, file.filename or "")
    parsed = _parse_or_400(data, spec, file.filename or "", sheet)
    if not parsed.rows:
        raise HTTPException(status_code=400, detail={
            "error": "no_usable_rows",
            "message": "表里没有可计算的规格行；请先看 /import/preview 的问题清单",
            "issues": [i.to_dict() for i in parsed.issues]})

    body.product_key = product_key
    body.spec_rows = parsed.rows
    # dev 这里**不注入客户成本表**（保持与导入场景一致：表格给的是规格，不是价）
    out = _run_calculation(body, user, view)
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


# ═════════════════════════════════════════════════════════════════════════════
# 客户税率档案（quote-profiles）
# ═════════════════════════════════════════════════════════════════════════════
# 允许存进档案的税率项 —— **白名单**，不是黑名单。
# tax_overrides 是 JSONB，数据库不拦任何键名；放行未知键的话，
# `input_vat_rates`（多个 s）这类打错的键会安静地存进去、界面上"保存成功"、
# 下次应用时什么都没带回 —— 用户看到的是"存了但没生效"，日志里一条错都没有。
# 刻意**不含**加工利润与让利比例：那是每单的商业决策，不是税率事实。
_ALLOWED_TAX_KEYS = {
    "input_vat_rate": "float",
    "output_vat_rate": "float",
    "rebate_rate": "float",
    "stamp_rate": "float",
    "stamp_base": "stamp_base",
}
_STAMP_BASES = {"profit", "cost", "base_quote"}

_QP_ACTIVE = "active"
_QP_INACTIVE = "inactive"


async def _qp_list(request: Request, tenant: str, product_key: str,
                   customer_id: Optional[str]) -> list:
    sql = ("SELECT * FROM customer_quote_profiles"
           " WHERE tenant_id=$1 AND product_key=$2 AND status='active'")
    params: list = [tenant, product_key]
    if customer_id is not None:
        params.append(customer_id)
        sql += f" AND customer_id=${len(params)}"
    # 新的在前：界面「默认选择最新创建的」直接取第一条，不用再排一次
    sql += " ORDER BY created_at DESC, id DESC"
    return await _db.fetch(request, sql, *params, table="customer_quote_profiles")


async def _qp_get(request: Request, profile_id: int, tenant: str,
                  customer_id: Optional[str] = None) -> Optional[dict]:
    sql = ("SELECT * FROM customer_quote_profiles"
           " WHERE id=$1 AND tenant_id=$2 AND status='active'")
    params: list = [profile_id, tenant]
    if customer_id is not None:
        params.append(customer_id)
        sql += f" AND customer_id=${len(params)}"
    return await _db.fetchrow(request, sql, *params, table="customer_quote_profiles")


async def _qp_find_by_name(request: Request, tenant: str, customer_id: str, product_key: str,
                           profile_name: str, exclude_id: Optional[int] = None) -> Optional[dict]:
    """查同名档案（拦截重名）。

    为什么拦：档案例唯一的用处就是"在下拉里认出是哪一份"。两份同名摆在一起，
    用户选哪个都一样 —— 那就等于没有档案。
    """
    sql = ("SELECT id FROM customer_quote_profiles"
           " WHERE tenant_id=$1 AND customer_id=$2 AND product_key=$3"
           " AND profile_name=$4 AND status='active'")
    params: list = [tenant, customer_id, product_key, profile_name]
    if exclude_id is not None:
        params.append(exclude_id)
        sql += f" AND id<>${len(params)}"
    return await _db.fetchrow(request, sql, *params)


def _qp_serialize(row: dict) -> dict:
    """出参。产品显示名在这里解析，免得每个调用点都要自己补一遍。"""
    try:
        product_name = getattr(get_product(row["product_key"]), "name", "")
    except Exception:
        # 产品可能被下线，但档案还在 —— 显示名缺失不该让整张列表读不出来
        product_name = ""
    return {
        "id": row["id"],
        "customer_id": row["customer_id"],
        "product_key": row["product_key"],
        "product_name": product_name,
        "profile_name": row["profile_name"],
        "rate_set_code": row["rate_set_code"],
        "tax_overrides": row.get("tax_overrides") or {},
        "source": row.get("source"),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


def _qp_validate_product(product_key: str) -> str:
    _require_engine()
    key = (product_key or "").strip()
    if not key:
        raise HTTPException(status_code=422, detail="product_key is required")
    try:
        get_product(key)
    except Exception:
        raise HTTPException(status_code=404, detail=f"未知产品: {key}")
    return key


def _qp_clean_tax_overrides(raw: Any) -> dict:
    """按白名单清洗税率覆盖项；越界/打错一律 422，不静默丢弃。

    这里刻意"报错"而不是"忽略未知键"：用户把档案存下来就是为了以后能原样取回，
    悄悄丢掉一个键 = 以后取回的档案少一项，而界面不会说。
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="tax_overrides must be an object")

    unknown = sorted(set(raw) - set(_ALLOWED_TAX_KEYS))
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=("不支持的税率项: %s（可用: %s）"
                    % (", ".join(unknown), ", ".join(sorted(_ALLOWED_TAX_KEYS)))))

    cleaned: dict = {}
    for key, kind in _ALLOWED_TAX_KEYS.items():
        if key not in raw:
            continue
        value = raw[key]
        if value is None or value == "":
            # 空 = 不覆盖，用法定值。不要存 null —— 取回时会变成"这条档案里有个 null"
            continue
        if kind == "stamp_base":
            text = str(value)
            if text not in _STAMP_BASES:
                raise HTTPException(
                    status_code=422,
                    detail="stamp_base 只能是 %s" % ", ".join(sorted(_STAMP_BASES)))
            cleaned[key] = text
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"{key} 必须是数字")
        # 税率是比例，必须落在 0~1。放行 10 这种"按百分数填"的值会让整张报价
        # 差一个数量级，而且不会报错。
        if not (0 <= number <= 1):
            raise HTTPException(status_code=422, detail=f"{key} 必须在 0~1 之间（10% 请填 0.1）")
        cleaned[key] = number
    return cleaned


@app.get("/api/v1/export-quote/quote-profiles")
@app.get("/api/v1/quote-profiles")
async def list_quote_profiles(
    request: Request,
    product_key: str = Query(""),
    scope: str = Query("own"),
    user: dict = Depends(_get_current_user),
):
    """列出某产品下可用的客户税率档案。

    - 默认 `scope=own`：只返回当前客户自己的档案（界面下拉用这个）。
    - `scope=all`（需租户管理员）：返回本租户下**所有客户**的档案。
    """
    key = _qp_validate_product(product_key)
    scope = (scope or "own").strip()
    if scope not in ("own", "all"):
        raise HTTPException(status_code=422, detail="scope must be own or all")

    tenant = _tenant_of(user)
    if not tenant:
        raise HTTPException(status_code=401, detail="Missing tenant context")
    customer = _customer_of(user)

    if scope == "all":
        if not _is_internal_admin(user):
            raise HTTPException(status_code=403, detail={
                "error": "forbidden", "message": "Tenant admin required"})
        rows = await _qp_list(request, tenant, key, None)
        return {"scope": "all", "product_key": key,
                "profiles": [_qp_serialize(p) for p in rows]}

    rows = await _qp_list(request, tenant, key, customer)
    return {"scope": "own", "product_key": key,
            "profiles": [_qp_serialize(p) for p in rows]}


@app.post("/api/v1/export-quote/quote-profiles", status_code=201)
@app.post("/api/v1/quote-profiles", status_code=201)
async def create_quote_profile(request: Request, body: dict,
                               user: dict = Depends(_get_current_user)):
    """把当前这套税率存成一份命名档案。"""
    tenant = _tenant_of(user)
    if not tenant:
        raise HTTPException(status_code=401, detail="Missing tenant context")
    customer = _customer_of(user)
    _identity_match(user, body, tenant, customer)

    product_key = _qp_validate_product(body.get("product_key") or "")
    name = (body.get("profile_name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="profile_name is required")
    if len(name) > 60:
        raise HTTPException(status_code=422, detail="profile_name 过长（最多 60 字）")

    rate_set_code = (body.get("rate_set_code") or "").strip()
    if not rate_set_code:
        # 必须记住法定档案：两层在下拉里一起选，缺了它档案就不可复现
        raise HTTPException(status_code=422, detail="rate_set_code is required")

    tax_overrides = _qp_clean_tax_overrides(body.get("tax_overrides"))
    if not tax_overrides:
        raise HTTPException(
            status_code=422,
            detail="这份档案里没有任何税率项 —— 空的档案套用后什么都不会变，请至少填一项")

    if await _qp_find_by_name(request, tenant, customer, product_key, name):
        raise HTTPException(status_code=409, detail=f"已存在同名档案「{name}」，请换个名字")

    row = await _db.fetchrow(
        request,
        """INSERT INTO customer_quote_profiles
               (tenant_id, customer_id, product_key, profile_name, rate_set_code,
                tax_overrides, status, source, created_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'manual',$8)
           RETURNING *""",
        tenant, customer, product_key, name, rate_set_code,
        json.dumps(tax_overrides), _QP_ACTIVE,
        str(user["id"]) if user.get("id") is not None else None,
        table="customer_quote_profiles",
    )
    return _qp_serialize(row)


@app.patch("/api/v1/export-quote/quote-profiles/{profile_id}")
@app.patch("/api/v1/quote-profiles/{profile_id}")
async def patch_quote_profile(profile_id: int, request: Request, body: dict,
                              user: dict = Depends(_get_current_user)):
    """改名 / 改内容。只处理传进来的字段，未传的保持不动。"""
    tenant = _tenant_of(user)
    if not tenant:
        raise HTTPException(status_code=401, detail="Missing tenant context")
    customer = _customer_of(user)
    _identity_match(user, body, tenant, customer)

    row = await _qp_get(request, profile_id, tenant, customer_id=customer)
    if row is None:
        raise HTTPException(status_code=404, detail="档案不存在")

    sets: list = []
    params: list = [tenant, profile_id]

    new_name = body.get("profile_name")
    if new_name is not None:
        new_name = str(new_name).strip()
        if not new_name:
            raise HTTPException(status_code=422, detail="profile_name 不能为空")
        if await _qp_find_by_name(request, tenant, customer, row["product_key"],
                                  new_name, exclude_id=profile_id):
            raise HTTPException(status_code=409, detail=f"已存在同名档案「{new_name}」")
        params.append(new_name)
        sets.append(f"profile_name=${len(params)}")

    rate_set_code = body.get("rate_set_code")
    if rate_set_code is not None:
        rate_set_code = str(rate_set_code).strip()
        if not rate_set_code:
            raise HTTPException(status_code=422, detail="rate_set_code 不能为空")
        params.append(rate_set_code)
        sets.append(f"rate_set_code=${len(params)}")

    tax_overrides = None
    if "tax_overrides" in body:
        tax_overrides = _qp_clean_tax_overrides(body.get("tax_overrides"))
        if not tax_overrides:
            raise HTTPException(status_code=422, detail="至少保留一项税率，空的档案没有意义")
        params.append(json.dumps(tax_overrides))
        sets.append(f"tax_overrides=${len(params)}::jsonb")

    if not sets:
        return _qp_serialize(row)

    # updated_at 必须显式写：dev 侧的"自动刷新"来自 SQLAlchemy 的 onupdate，
    # 那是 ORM 层行为，数据库没有触发器 —— raw SQL 不写它就永远停在创建时间。
    # 用 NOW()（数据库时钟）而不是 Python 的 now()，让 created_at 与 updated_at 同源。
    sets.append("updated_at=NOW()")
    updated = await _db.fetchrow(
        request,
        "UPDATE customer_quote_profiles SET %s WHERE tenant_id=$1 AND id=$2 RETURNING *"
        % ", ".join(sets),
        *params,
        table="customer_quote_profiles",
    )
    return _qp_serialize(updated)


@app.delete("/api/v1/export-quote/quote-profiles/{profile_id}")
@app.delete("/api/v1/quote-profiles/{profile_id}")
async def delete_quote_profile(profile_id: int, request: Request,
                               user: dict = Depends(_get_current_user)):
    """停用（软删）。走"删除"而不是让用户改空 —— 用户想的就是从下拉里去掉它。

    行留在库里：档案一旦生成过报价单，删掉就无法回答"当时用的是哪套税率"。
    """
    tenant = _tenant_of(user)
    if not tenant:
        raise HTTPException(status_code=401, detail="Missing tenant context")
    customer = _customer_of(user)

    row = await _qp_get(request, profile_id, tenant, customer_id=customer)
    if row is None:
        raise HTTPException(status_code=404, detail="档案不存在")

    await _db.execute(
        request,
        "UPDATE customer_quote_profiles SET status=$3, updated_at=NOW()"
        " WHERE tenant_id=$1 AND id=$2",
        tenant, profile_id, _QP_INACTIVE,
    )
    return {"ok": True, "id": profile_id}


# ═════════════════════════════════════════════════════════════════════════════
# 报价单（/api/v1/quotes）
# ═════════════════════════════════════════════════════════════════════════════
# 一行 = 一个产品；一个询盘多种产品就是多行，不是多张报价单。
# 行小计 = 数量(卷数) × 单价(单卷外币价)，与单证 Amount 同源。
class _QuoteItemIn(BaseModel):
    sku_id: Optional[int] = None
    product_name: str
    spec_snapshot: Optional[dict] = None
    qty: Decimal
    qty_unit: str = "ROLLS"
    unit_price: Optional[Decimal] = None
    currency: Optional[str] = None
    line_amount: Optional[Decimal] = None
    sort_order: int = 0
    # 内部分解快照（成本/利润）——签发时从算价引擎 internal 视图带来；
    # 仅 internal 账号可读（出口剔除），customer 视角本字段不存在（UNCERTAIN #19）
    cost_breakdown: Optional[dict] = None


class _QuoteOrderCreate(BaseModel):
    # 业务客户外键（BIGINT）：报价是整棵"往来记录"树的根，**必须选已有客户**。
    # 类型上留 Optional 是为了让缺参走本模块的统一错误体（422 CUSTOMER_REQUIRED），
    # 而不是 pydantic 的字段级 422 —— 前端要能区分"没选客户"与"值不合法"。
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None
    inquiry_id: Optional[int] = None  # 询盘来源（一个询盘一张报价单）
    currency: str = "USD"
    valid_until: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: str = "private"
    # 贸易条款：报价谈定的条款要能一路传到订单与单证，否则信用证审单会出不符点
    incoterm: Optional[str] = None
    payment_terms: Optional[str] = None
    port_of_loading: Optional[str] = None
    port_of_destination: Optional[str] = None
    shipping_marks: Optional[str] = None
    country_of_origin: Optional[str] = None
    items: List[_QuoteItemIn] = []


class _QuoteOrderPatch(BaseModel):
    # 改单时也能换客户：历史报价的 customer_id 被清洗成 NULL 后要能人工认领回来
    # （认领时同样过客户闸门 —— 报价单与它的报价单一起改挂到新客户）
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None
    currency: Optional[str] = None
    valid_until: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    incoterm: Optional[str] = None
    payment_terms: Optional[str] = None
    port_of_loading: Optional[str] = None
    port_of_destination: Optional[str] = None
    shipping_marks: Optional[str] = None
    country_of_origin: Optional[str] = None


class _QuoteItemsReplace(BaseModel):
    items: List[_QuoteItemIn]


_QUOTE_TRADE_TERM_FIELDS = (
    "customer_name", "notes", "incoterm", "payment_terms",
    "port_of_loading", "port_of_destination", "shipping_marks", "country_of_origin",
)


def _parse_dt(value: Optional[str]):
    """ISO 字符串 → datetime（dev 用 `datetime.fromisoformat`）。

    唯一差异：非法输入由 dev 的 500 变成 422 —— 前端传坏日期时，
    "你的日期格式不对"比"服务器内部错误"更可执行。正常路径完全一致。
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_datetime", "message": f"不是合法的时间格式: {value}"})


def _quote_json(row: dict, item_count: int = 0) -> dict:
    """报价单头 → 出参（与 dev `_row_to_quote` 共用共享内核序列化）。"""
    from kaas_common.workstation.quote_serializers import row_to_quote
    return row_to_quote(dict(row), item_count)


def _quote_item_json(row, user: dict | None = None) -> dict:
    """行项 → 出参。spec_snapshot 必须经 dbjson 解码（jsonb 在 Workers 里是 str）。

    内外视图红线（UNCERTAIN #19）：成本分解只对平台员工（internal）透出，
    customer 账号在**接口层**就剥掉，不靠前端隐藏。
    """
    from kaas_common.workstation.quote_serializers import row_to_item
    d = _row_to_dict(row, "quote_order_items")
    out = row_to_item(d)
    if user is None or user.get("account_type") != "internal":
        out.pop("cost_breakdown", None)
    return out


def _build_items(currency: str, rows: List[_QuoteItemIn]):
    """行项 → 待插入的 dict 列表 + 单头合计。

    合计口径：**行小计优先取前端算好的 `line_amount`**（它等于 卷数 × 单卷外币价，
    与单证 Amount 同源）；只有没给时才用 数量 × 单价 补算。
    这样"报价工位汇总"和"单证 TOTAL"用的是同一批数字，不会差 1 分。
    """
    items: list = []
    total = Decimal("0")
    for row in rows:
        line = row.line_amount
        if line is None and row.unit_price is not None:
            line = row.qty * row.unit_price
        if line is not None:
            line = Decimal(line)
        items.append({
            "sku_id": row.sku_id,
            "product_name": row.product_name,
            "spec_snapshot": row.spec_snapshot,
            "qty": row.qty,
            "qty_unit": row.qty_unit or "ROLLS",
            "unit_price": row.unit_price,
            "currency": (_validate_enum("currency", row.currency, _CURRENCY)
                         if row.currency else currency),
            "line_amount": line,
            "sort_order": row.sort_order,
            "cost_breakdown": row.cost_breakdown,
        })
        if line is not None:
            total += line
    return items, total


async def _insert_quote_items(conn, tenant: str, quote_order_id: int, items: list) -> None:
    for it in items:
        await conn.execute(
            """INSERT INTO quote_order_items
                   (tenant_id, quote_order_id, sku_id, product_name, spec_snapshot,
                    qty, qty_unit, unit_price, currency, line_amount, sort_order,
                    cost_breakdown)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb)""",
            tenant, quote_order_id, it["sku_id"], it["product_name"],
            json.dumps(it["spec_snapshot"]) if it["spec_snapshot"] is not None else None,
            it["qty"], it["qty_unit"], it["unit_price"], it["currency"],
            it["line_amount"], it["sort_order"],
            json.dumps(it["cost_breakdown"]) if it.get("cost_breakdown") is not None else None,
        )


async def _items_of(conn, tenant: str, quote_id: int) -> list:
    return await conn.fetch(
        "SELECT * FROM quote_order_items WHERE tenant_id=$1 AND quote_order_id=$2"
        " ORDER BY sort_order, id",
        tenant, quote_id,
    )


# ── 报价单（trade_docs.doc_type='quotation'）：报价的必然产物（1:1）──────────
# 依据 docs/CUSTOMER_DOCUMENTS_VIEW.md §1.5：「报价一定伴随报价单」，
# 且它不该由用户"再去单证工位单独建一张"（设计文档 PLAN_CUSTOMER_RECORDS P2-1）。


def _json_text(value) -> Optional[str]:
    """spec_snapshot → JSON 文本（jsonb 参数）。

    为什么不能直接 json.dumps：asyncpg 在 Workers 里把 jsonb 返回成 **str**，
    库里取出来的行再 dumps 一次就是二次编码（渲染时看到的是一段转义文本）。
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value          # 已是 JSON 文本
    return json.dumps(value, ensure_ascii=False)


def _snapshot_value(value):
    """jsonb 列 → 对象（库里取出来可能是 JSON 文本；快照里必须是对象）。"""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _date_text(value) -> Optional[str]:
    """date/datetime → YYYY-MM-DD（单证上印的是日期，不带时间与时区尾巴）。"""
    text = _iso(value)
    return text[:10] if text else None


async def _insert_doc_items(conn, tenant: str, doc_id: int, items: list,
                            currency: str) -> None:
    """把报价行项写成单证行项（报价单的明细）。

    为什么单独抽出来：自动产出报价单时要写、报价行项被整批替换时还要重写 ——
    两处若各写一份 INSERT，字段口径迟早分叉（`trade_doc_items` 的列与
    `quote_order_items` 不同名，正是最容易漏的地方）。
    """
    for idx, it in enumerate(items or []):
        await conn.execute(
            "INSERT INTO trade_doc_items (tenant_id, trade_doc_id, product_name,"
            " spec_snapshot, qty, qty_unit, unit_price, currency, line_amount,"
            " sort_order, source)"
            " VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,'generated')",
            tenant, doc_id, it.get("product_name"),
            _json_text(it.get("spec_snapshot")),
            it.get("qty") if it.get("qty") is not None else 1,
            it.get("qty_unit"), it.get("unit_price"),
            it.get("currency") or currency or "USD",
            it.get("line_amount"), it.get("sort_order") or idx,
        )


async def _sync_quotation_doc_items(conn, tenant: str, quote_id: int, items: list,
                                    total, currency: str) -> None:
    """报价行项 / 合计变化 → 同步到它那张 **draft** 报价单。

    issued 的报价单是法律凭证（确认即冻结），一律不动：要改只能作废重开。
    """
    doc = await conn.fetchrow(
        "SELECT id FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
        " AND doc_type='quotation' AND status='draft' ORDER BY id LIMIT 1",
        tenant, quote_id,
    )
    if doc is None:
        return
    await conn.execute(
        "DELETE FROM trade_doc_items WHERE tenant_id=$1 AND trade_doc_id=$2",
        tenant, doc["id"])
    await _insert_doc_items(conn, tenant, doc["id"], items, currency)
    await conn.execute(
        "UPDATE trade_docs SET total_amount=$3, updated_at=now()"
        " WHERE tenant_id=$1 AND id=$2",
        tenant, doc["id"], total)


async def _ensure_quotation_doc(conn, tenant: str, q: dict, items: list,
                                request: Request) -> None:
    """保证这张报价有一张对应的报价单（`trade_docs`，`doc_type='quotation'`）。

    为什么必须自动产出：业务事实是"报价一定伴随报价单"，靠人工去单证工位补
    必然有漏，漏了客户页就会断层（报价下什么都没有，或被误当成"还没报价"）。
    为什么必须**同一事务**：报价与报价单要么都成功、要么都不存在 ——
    先提交报价再补单证，中间失败就会留下"查得到报价、查不到它的单"的半截状态。
    为什么 doc_no 直接用报价号：迁移 010 的历史回填规则就是 `doc_no == quote_no`
    （同号即同一张单），新数据沿用同一条规则，历史与新数据在客户页长得一样。

    幂等：同一报价只产出一次；顺带**认领**历史回填留下的"同号但未挂报价"的
    报价单（把 `quote_id` 补上），否则它在客户页里仍会落在 `direct` 分组。
    `request` 只用于"报价号被别的单证占了号"时另取一个新号（见下）。
    """
    if not q.get("id") or not q.get("customer_id"):
        # 客户是单证的归属依据（约束 ck_docs_has_customer 要求非空）。
        # 正常路径不可能为空（报价必填客户），这里只是不让异常数据把报价写入炸掉。
        return
    existing = await conn.fetchrow(
        "SELECT id, quote_id FROM trade_docs WHERE tenant_id=$1"
        " AND doc_type='quotation'"
        " AND (quote_id=$2 OR (quote_id IS NULL AND doc_no=$3))"
        " ORDER BY id LIMIT 1",
        tenant, q["id"], q.get("quote_no"),
    )
    if existing is not None:
        if existing["quote_id"] is None:
            await conn.execute(
                "UPDATE trade_docs SET quote_id=$3, updated_at=now()"
                " WHERE tenant_id=$1 AND id=$2",
                tenant, existing["id"], q["id"])
        return

    # 快照字段清单与 doc_payload.quote_snapshot 逐条一致（字段名就是已落库数据的契约）。
    # 这里用**内存里的行**拼，而不是再查一次库：报价刚在本事务里插入，
    # 另一条连接读不到未提交的数据（会拿到空快照）。
    snapshot = {
        "quote_no": q.get("quote_no"),
        "customer_id": q.get("customer_id"),
        "customer_name": q.get("customer_name"),
        "status": q.get("status"),
        "currency": q.get("currency"),
        "total_amount": _f(q.get("total_amount")),
        "incoterm": q.get("incoterm"),
        "payment_terms": q.get("payment_terms"),
        "port_of_loading": q.get("port_of_loading"),
        "port_of_destination": q.get("port_of_destination"),
        "shipping_marks": q.get("shipping_marks"),
        "country_of_origin": q.get("country_of_origin"),
        "items": [{
            "product_name": i.get("product_name"), "qty": _f(i.get("qty")),
            "qty_unit": i.get("qty_unit"), "unit_price": _f(i.get("unit_price")),
            "line_amount": _f(i.get("line_amount")),
            "spec_snapshot": _snapshot_value(i.get("spec_snapshot")),
        } for i in (items or [])],
    }
    payload = {
        "sources": {"quote": snapshot},
        # 确认报价单前的必填项（共享内核 rules.DOC_REQUIRED['quotation'] 里的
        # quote_no / quote_date）先存进 custom，用户不必再手填一遍
        "custom": {"quote_no": q.get("quote_no"),
                   "quote_date": _date_text(q.get("created_at"))},
    }

    async def _insert(doc_no):
        # doc_no 在 trade_docs 上是**全表唯一**（其他单据表是租户内唯一）：
        # 万一报价号已被别的单证占用，绝不能让"报价建不出来" —— 冲突就返回 None，
        # 由调用处换个号重试（客户页靠 quote_id 关联，不依赖单号相等）。
        return await conn.fetchrow(
            "INSERT INTO trade_docs (tenant_id, doc_no, doc_type, order_id, quote_id,"
            " customer_id, status, currency, total_amount, raw_payload, team_id)"
            " VALUES ($1,$2,'quotation',NULL,$3,$4,'draft',$5,$6,$7,$8)"
            " ON CONFLICT (doc_no) DO NOTHING RETURNING id",
            tenant, doc_no, q["id"], q.get("customer_id"),
            q.get("currency") or "USD", q.get("total_amount"),
            json.dumps(payload, ensure_ascii=False), q.get("team_id"),
        )

    doc = await _insert(q.get("quote_no"))
    if doc is None:
        doc = await _insert(await _next_doc_no(request, "quotation"))
    if doc is None:
        # 连新号都撞（理论上不可能）：宁可这张报价暂时没有报价单，
        # 也不能让整个报价写入失败 —— 用户重试或走单证工位补都能救回来。
        return
    # 行项也落一份：单证工作台的"确认"（共享内核 validate_confirm）读的是
    # `trade_doc_items`，只把行项冻在 raw_payload 里的话"看得见、签不了"，
    # 报价单会永远停在 draft。
    await _insert_doc_items(conn, tenant, doc["id"], items,
                            q.get("currency") or "USD")
    # 溯源：报价单的 `quote_id` 列在 INSERT 时已落（上面的 `_insert`），
    # 触发器 `trg_trade_docs_links` 会自动派生 `entity_links` 边 ——
    # 旧 `trade_doc_quote_refs` 已随迁移 202610110014 改名 `_legacy` 留档，不再写。


async def _item_count_map(request: Request, tenant: str, quote_ids: list) -> dict:
    """一次查出多张报价单的行数（列表页要显示"含 N 个产品"，不能 N+1 次查询）。"""
    if not quote_ids:
        return {}
    rows = await _db.fetch(
        request,
        "SELECT quote_order_id, COUNT(*) AS n FROM quote_order_items"
        " WHERE tenant_id=$1 AND quote_order_id = ANY($2::bigint[])"
        " GROUP BY quote_order_id",
        tenant, quote_ids,
    )
    return {r["quote_order_id"]: r["n"] for r in rows}


async def _record_quote_issued(conn, q: dict, user: dict) -> None:
    """报价单签发 → 向「报价记录」台账入账（**一张单一条**）。

    为什么只在此处写：台账只记业务节点（报价单签发 / 订单成交），算价试算不落账,
    否则台账会被垃圾流水淹没。

    为什么是整单一条：台账按客户 + 产品类目组织，而一张报价单可含多个类目，
    拆行会丢上下文；行项明细放进 product_spec 快照，条数不膨胀、明细仍可追溯。
    为什么用 other 类目：整单记录不属于单一产品类目，用既有档而不是新增枚举值。
    """
    if not q.get("customer_id"):
        # 台账按客户归属；没有客户无法入账。不阻断签发，只跳过。
        return

    items = await _items_of(conn, q["tenant_id"], q["id"])
    total = _f(q.get("total_amount"))
    snapshot = {
        "doc": "quotation",
        "quote_no": q.get("quote_no"),
        "customer_name": q.get("customer_name"),
        "currency": q.get("currency"),
        "total_amount": total,
        "fx_rate": _f(q.get("fx_rate")),
        "incoterm": q.get("incoterm"),
        "items": [
            {
                "product_name": i["product_name"],
                "qty": _f(i["qty"]),
                "qty_unit": i["qty_unit"],
                "unit_price": _f(i["unit_price"]),
                "line_amount": _f(i["line_amount"]),
            }
            for i in items
        ],
    }
    spec_hash = _compute_spec_hash(snapshot)

    # 幂等：同一张报价单只入账一次。状态机虽已限制 draft→sent 只能走一次，
    # 但重试/重复提交仍可能触发，而台账是 INSERT-only 的事实表，脏数据清不掉。
    exists = await conn.fetchval(
        "SELECT COUNT(*) FROM quotations"
        " WHERE tenant_id=$1 AND source=$2 AND spec_hash=$3",
        q["tenant_id"], _LEDGER_SOURCE_QUOTE_ISSUED, spec_hash,
    )
    if exists:
        return

    await conn.execute(
        # schema_version 必须显式给 1：dev 侧由 SQLAlchemy 的 `default=1` 在客户端补，
        # 而库里这一列是 NOT NULL **且没有数据库默认值**（实测 column_default 为 null）
        # —— raw SQL 不写它就报 NotNullViolation，签发直接 500。
        # （main.py 的 POST /api/v1/quotations 同一处也漏了，见交接说明。）
        """INSERT INTO quotations
               (schema_version, tenant_id, customer_id, product_category, product_spec,
                spec_hash, unit_price, currency, unit, discount, min_quantity, source,
                notes, created_by)
           VALUES (1,$1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)""",
        q["tenant_id"], q["customer_id"], "other", json.dumps(snapshot), spec_hash,
        total, q.get("currency") or "USD", "单", None, None,
        _LEDGER_SOURCE_QUOTE_ISSUED,
        "由报价单 %s 签发自动入账（整单一条）" % q.get("quote_no"),
        # created_by 列是 VARCHAR，而 user_id 是整数 —— 必须显式转字符串，
        # 否则 asyncpg 报 `expected str, got int`。（旧 quotes.py 同一处漏了转换，
        # 因前端零调用从未触发，属潜伏缺陷。）
        str(user["id"]) if user.get("id") is not None else None,
    )


async def _quote_or_404(conn, tenant: str, quote_id: int, user: dict) -> dict:
    params: list = [tenant, quote_id]
    row = await conn.fetchrow(
        "SELECT * FROM quote_orders WHERE tenant_id=$1 AND id=$2"
        + _scope_sql(user, params),
        *params,
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "QUOTE_NOT_FOUND"})
    return dict(row)


@app.get("/api/v1/quotes")
async def list_quote_orders(
    request: Request,
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    inquiry_id: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    user: dict = Depends(_get_current_user),
):
    """报价单列表（含行数；不返回行项明细，避免 N+1）。"""
    tenant = _tenant_of(user)
    where = ["tenant_id = $1"]
    params: list = [tenant]
    if status:
        _validate_enum("quote_status", status, _QUOTE_STATUS)
        params.append(status)
        where.append(f"status = ${len(params)}")
    if customer_id:
        params.append(customer_id)
        where.append(f"customer_id = ${len(params)}")
    if inquiry_id is not None:
        params.append(inquiry_id)
        where.append(f"inquiry_id = ${len(params)}")
    cond = " AND ".join(where) + _scope_sql(user, params)

    total = await _db.fetchval(request, f"SELECT COUNT(*) FROM quote_orders WHERE {cond}", *params)
    page_size = max(1, min(page_size, 200))
    rows = await _db.fetch(
        request,
        f"SELECT * FROM quote_orders WHERE {cond}"
        # 加 id 兜底排序：同一时刻创建的多张单若只按 created_at 排，
        # 翻页时顺序不稳定（同一行可能出现两次/漏掉）。
        f" ORDER BY created_at DESC, id DESC LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}",
        *params, page_size, (max(1, page) - 1) * page_size,
    )
    counts = await _item_count_map(request, tenant, [r["id"] for r in rows])
    return {
        "items": [_quote_json(r, counts.get(r["id"], 0)) for r in rows],
        "total": total, "page": page, "page_size": page_size,
    }


@app.post("/api/v1/quotes", status_code=201)
async def create_quote_order(request: Request, body: _QuoteOrderCreate,
                             user: dict = Depends(_get_current_user)):
    """新建报价单（可带多行 + 询盘来源；锁汇率快照）。

    **业务客户必填**（报价是客户往来记录树的唯一根入口）：
    校验存在 / 未软删 / 属本团队 → 否则 404 `CUSTOMER_NOT_FOUND`；
    没传 → 422 `CUSTOMER_REQUIRED`。同时写 `customer_name` 快照（前端按名字显示）
    并让报价的 `team_id` 与客户团队一致（管理员替别家团队报价时不会留在自己团队）。

    另外**同一事务**产出一张报价单（`trade_docs.doc_type='quotation'`）：
    "每个报价都有对应的报价单"是业务事实，不该依赖用户再去单证工位建一张。

    空单也允许创建（工作台"先建单、再逐行加产品"的自然用法），
    但合计留空而不是 0 —— 0 会被当成"报过价、价是 0"。
    """
    tenant = _tenant_of(user)
    currency = _validate_enum("currency", body.currency, _CURRENCY) or "USD"
    owner_scope = _validate_enum("owner_scope", body.owner_scope, _OWNER_SCOPE) or "private"

    items, total = _build_items(currency, body.items)
    quote_no = await _next_doc_no(request, "quotation")
    rate, rate_date = await _lock_fx_rate(request, currency)

    async with _db.acquire(request) as conn:
        async with conn.transaction():
            # 客户闸门（必填）：复用 main 的**同一道**闸门（存在/未软删/可见/属本团队），
            # 不在这里另写一套校验 —— 另写必然与订单/单证两处漂移。
            customer = await _doc_customer(conn, body.customer_id, user, required=True)
            row = await conn.fetchrow(
                """INSERT INTO quote_orders
                       (tenant_id, quote_no, customer_id, customer_name, inquiry_id,
                        status, currency, total_amount, valid_until, notes,
                        fx_rate, fx_rate_date, created_by, owner_id, owner_scope,
                        incoterm, payment_terms, port_of_loading, port_of_destination,
                        shipping_marks, country_of_origin, team_id)
                   VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$12,$13,
                           $14,$15,$16,$17,$18,$19,$20)
                   RETURNING *""",
                tenant, quote_no, customer["id"],
                # 客户名快照：显式传入优先，否则按客户档案取（开单当时的名字）
                body.customer_name or customer.get("name"),
                body.inquiry_id,
                currency, total if items else None, _parse_dt(body.valid_until), body.notes,
                rate, rate_date, str(user["id"]), owner_scope,
                body.incoterm, body.payment_terms, body.port_of_loading,
                body.port_of_destination, body.shipping_marks, body.country_of_origin,
                # 单据与客户同团队（而不是"创建者的团队"）
                customer.get("team_id"),
            )
            if items:
                await _insert_quote_items(conn, tenant, row["id"], items)
            # 2026-10-18：客户阶段读时由「开启中的订单」推导，报价变化不再回写客户阶段。
            await _ensure_quotation_doc(conn, tenant, dict(row), items, request)
    return _quote_json(dict(row), len(items))



@app.get("/api/v1/quotes/reference-price")
async def quote_reference_price(request: Request, customer_id: int,
                                product_name: str, spec: Optional[str] = None,
                                days: int = 180,
                                user: dict = Depends(_get_current_user)):
    """历史参考价（UNCERTAIN #19 · 实时报价的回落参考）——与 dev 同口径。

    聚合同客户+同产品近 N 天已落库报价行项的单价；spec 给 JSON 字符串时按
    spec_snapshot 语义相等精确匹配。可见范围与报价单列表同口径（_scope_sql）。
    """
    days = max(1, min(int(days or 180), 730))
    params: list = [_tenant_of(user), customer_id, product_name, days]
    spec_clause = ""
    if spec:
        try:
            json.loads(spec)  # 先验形状，非法给 422 而不是默默不匹配
        except json.JSONDecodeError:
            raise HTTPException(status_code=422, detail={
                "error": "validation_error", "message": "spec must be a JSON object"})
        params.append(spec)
        spec_clause = f" AND i.spec_snapshot = ${len(params)}::jsonb"
    tenant = params[0]
    row = await _db.fetchrow(
        request,
        "SELECT count(*) AS n,"
        " avg(i.unit_price) AS avg, min(i.unit_price) AS min, max(i.unit_price) AS max,"
        " percentile_cont(0.5) WITHIN GROUP (ORDER BY i.unit_price) AS median,"
        " max(q.created_at) AS last_at"
        " FROM quote_order_items i JOIN quote_orders q"
        "   ON q.tenant_id = i.tenant_id AND q.id = i.quote_order_id"
        " WHERE i.tenant_id=$1 AND q.customer_id=$2 AND i.product_name=$3"
        " AND i.unit_price IS NOT NULL"
        f" AND q.created_at >= now() - ($4 || ' days')::interval{spec_clause}"
        + _scope_sql(user, params, "q"),
        *params,
    )
    return {
        "customer_id": customer_id,
        "product_name": product_name,
        "days": days,
        "spec_matched": spec is not None,
        "count": row["n"] if row else 0,
        "avg": float(row["avg"]) if row and row["avg"] is not None else None,
        "min": float(row["min"]) if row and row["min"] is not None else None,
        "max": float(row["max"]) if row and row["max"] is not None else None,
        "median": float(row["median"]) if row and row["median"] is not None else None,
        "last_at": row["last_at"].isoformat() if row and row["last_at"] else None,
    }


@app.get("/api/v1/quotes/{quote_id}")
async def get_quote_order(quote_id: int, request: Request,
                          user: dict = Depends(_get_current_user)):
    """报价单详情（含行项）。"""
    tenant = _tenant_of(user)
    async with _db.acquire(request) as conn:
        q = await _quote_or_404(conn, tenant, quote_id, user)
        items = await _items_of(conn, tenant, q["id"])
    payload = _quote_json(q, len(items))
    payload["items"] = [_quote_item_json(i, user) for i in items]
    return payload


@app.patch("/api/v1/quotes/{quote_id}")
async def update_quote_order(quote_id: int, request: Request, body: _QuoteOrderPatch,
                             user: dict = Depends(_get_current_user)):
    """改单头 / 状态流转（draft→sent 时向台账补一条）。"""
    tenant = _tenant_of(user)
    sets: list = []
    params: list = [tenant, quote_id]

    # ⚠️ 枚举/日期校验刻意放在**取到单子之后**（在事务里），与 dev 的顺序一致：
    # 先 404（单子不属于你/不存在）、再 403（不是你的单）、最后才是 422（值非法）。
    # 顺序反过来的话，"改一张不存在的单"会先报"币种非法"，排查时会被带偏。
    for field in _QUOTE_TRADE_TERM_FIELDS:
        value = getattr(body, field)
        if value is not None:
            params.append(value)
            sets.append(f"{field}=${len(params)}")

    async with _db.acquire(request) as conn:
        async with conn.transaction():
            q = await _quote_or_404(conn, tenant, quote_id, user)
            _check_write_access(user, q)

            # 换客户（含历史报价的"人工认领"）：走与新建同一道客户闸门。
            # 客户变了，报价单（trade_docs，doc_type='quotation'）也必须跟着改挂 ——
            # 否则客户页里报价在一个客户下、它的报价单却留在旧客户下（甚至消失）。
            if body.customer_id is not None:
                customer = await _doc_customer(conn, body.customer_id, user, required=True)
                params.append(customer["id"])
                sets.append(f"customer_id=${len(params)}")
                params.append(customer.get("team_id"))
                sets.append(f"team_id=${len(params)}")
                if body.customer_name is None:
                    params.append(customer.get("name"))
                    sets.append(f"customer_name=${len(params)}")

            if body.status is not None and body.status != q["status"]:
                _validate_enum("quote_status", body.status, _QUOTE_STATUS)
                allowed = _QUOTE_NEXT.get(q["status"], ())
                if body.status not in allowed:
                    raise HTTPException(status_code=400, detail={
                        "error": "invalid_transition", "code": "INVALID_STATUS_TRANSITION",
                        "detail": (f"{q['status']} → {body.status} 不是合法流转"
                                   f"（允许：{allowed}）"),
                    })
                params.append(body.status)
                sets.append(f"status=${len(params)}")

            if body.currency is not None:
                params.append(_validate_enum("currency", body.currency, _CURRENCY) or "USD")
                sets.append(f"currency=${len(params)}")
            if body.valid_until is not None:
                params.append(_parse_dt(body.valid_until))
                sets.append(f"valid_until=${len(params)}")

            if sets:
                updated = dict(await conn.fetchrow(
                    "UPDATE quote_orders SET %s WHERE tenant_id=$1 AND id=$2 RETURNING *"
                    % ", ".join(sets),
                    *params,
                ))
            else:
                updated = q

            if body.customer_id is not None:
                await conn.execute(
                    "UPDATE trade_docs SET customer_id=$3, team_id=$4, updated_at=now()"
                    " WHERE tenant_id=$1 AND quote_id=$2 AND doc_type='quotation'",
                    tenant, quote_id, updated["customer_id"], updated.get("team_id"))
            # 签发与入账必须**同一个事务**：先 commit 再入账的话，入账失败会留下
            # "状态已 sent、台账里没有"的不一致 —— 而用户看到的是一次 500，
            # 会以为签发失败又去点一次。
            if body.status == "sent":
                await _record_quote_issued(conn, updated, user)
                # 签发即视为报价正式成立：确保报价单存在（本功能上线前建的报价
                # 没有对应的报价单 —— 这里补齐，而不是让它永远缺一张）
                await _ensure_quotation_doc(conn, tenant, updated,
                                            await _items_of(conn, tenant, quote_id),
                                            request)
    # dev 这里返回 `_row_to_quote(q)`（item_count 用默认值 0，不回填行数）——
    # 逐字照抄，避免"两边形状不同"；界面在成功后会重新拉列表/详情。
    return _quote_json(updated)


@app.put("/api/v1/quotes/{quote_id}/items")
async def replace_quote_items(quote_id: int, request: Request, body: _QuoteItemsReplace,
                              user: dict = Depends(_get_current_user)):
    """行项**整批替换**：工作台"保存"的语义（整单一次提交，不留半截脏行）。

    为什么是替换而不是逐行增删改：多产品工作台里行的增删改是**一次编辑动作**，
    逐行接口会让"改到一半失败"留下前后不一致的报价单（部分新、部分旧），
    而报价单是要拿出去报价的。
    """
    tenant = _tenant_of(user)
    async with _db.acquire(request) as conn:
        async with conn.transaction():
            q = await _quote_or_404(conn, tenant, quote_id, user)
            _check_write_access(user, q)

            if q["status"] not in _QUOTE_EDITABLE_STATUS:
                raise HTTPException(status_code=409, detail={
                    "error": "not_editable", "code": "QUOTE_NOT_EDITABLE",
                    "detail": (f"报价单已处于 {q['status']}，签发后不可再改行项"
                               "（要改请另开一张，历史单据必须可追溯）"),
                })

            await conn.execute(
                "DELETE FROM quote_order_items WHERE tenant_id=$1 AND quote_order_id=$2",
                tenant, quote_id)

            items, total = _build_items(q["currency"], body.items)
            if items:
                await _insert_quote_items(conn, tenant, quote_id, items)
            # 空行集合 → 合计留空（不是 0）
            await conn.execute(
                "UPDATE quote_orders SET total_amount=$3 WHERE tenant_id=$1 AND id=$2",
                tenant, quote_id, total if items else None)
            # 报价单的行项/合计跟着报价走：工作台的真实流程是"先建空报价 → 再逐行
            # 加产品"，不同步的话自动产出的报价单会永远停在 0 行 —— 打印是空的，
            # 确认时也会卡在"至少一行商品明细"（共享内核 validate_items）。
            # 只同步 draft：issued 的报价单是法律凭证，要改只能作废重开。
            await _sync_quotation_doc_items(
                conn, tenant, quote_id, items, total if items else None, q["currency"])

            rows = await _items_of(conn, tenant, quote_id)
    return {
        "id": quote_id,
        "total_amount": float(total) if items else None,
        "items": [_quote_item_json(i, user) for i in rows],
    }
