"""报价工位（export-quote）与报价单（quotes）— Python Worker 版。

**方案 B 收敛前的历史背景**：本模块曾对齐 orchestrator 业务壳的对应路由；业务壳已删，当前本文件即生产唯一实现，业务规则真源在共享内核 kaas_common/export_quote/：

    算价 / 规格空间 / 税务档案 / 导入   → 本模块（引擎调 kaas_common/export_quote）
    报价单（/api/v1/quotes）            → 本模块
    客户税率档案                        → 本模块
    取号 / 汇率锁定 / 可见范围          → ws_common 相关路由
    客户定价数据 → 引擎成本表           → 本模块

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
2. **没有 openpyxl** → 服务端不生成 xlsx 模板（openpyxl 依赖 C 扩展，打不进 Pyodide）。
   模板只给 CSV；Excel 模板由**前端浏览器**用 exceljs 现生成（`format=xlsx` 仍返回
   501，指路 `format=csv` 或页面下载）。**上传侧自 2026-10-21 起支持 .xlsx**：xlsx 是
   zip+XML，共享内核的纯 stdlib 读取器（`kaas_common/export_quote/xlsx.py`）能读，
   CSV 与 xlsx 共用同一个 `parse_table` 做字段映射（不存在第二套口径）；老 .xls
   （OLE2）仍显式拒绝并指路另存为 .xlsx/.csv。
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
from typing import Any, List, Literal, Optional

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
import inquiry_stage as _inquiry_stage
from kaas_common.workstation.number_rules import (  # noqa: E402
    NumberError,
    build_number,
    normalize_number,
)

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
    "EngineError", "ImportError_", "PricingError",
    "TermsError", "build", "build_customer_view",
    "build_internal_view", "build_template_csv", "describe_product",
    "describe_pricing_key", "get_product", "ladder_from_dict",
    "make_request_from_config", "product_keys",
    "template_columns", "template_headers", "verify_all", "extend_product",
    "pricing_key_defined_values", "pricing_key_of", "pricing_key_value",
    "quote_meta", "default_terms_template",
    # R-D 整单批量导入（2026-10-23）：多产品单表解析 + 并集列定义
    "order_template_columns", "order_template_headers", "parse_order_table",
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
            TermsError,
            build,
            build_customer_view,
            build_internal_view,
            build_template_csv,
            describe_product,
            get_product,
            ladder_from_dict,
            make_request_from_config,
            product_keys,
            template_columns,
            template_headers,
            verify_all,
        )
        # 这几个没进包的 __all__，按子模块取（与 dev 的 import 路径一致）。
        from kaas_common.export_quote.formulas import describe_pricing_key  # noqa: E402
        from kaas_common.export_quote.importers import MAX_ROWS as _MAX_ROWS  # noqa: E402
        # R-D 整单导入：新增函数没进包的 __all__，按子模块取（同 dev 的 import 路径）。
        from kaas_common.export_quote.importers import (  # noqa: E402
            order_template_columns,
            order_template_headers,
            parse_order_table,
        )
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
    except Exception as _exc:  # noqa: BLE001 - 有意兜底：任何引擎导入失败都不该让 Worker 起不来
        _ENGINE_IMPORT_ERROR = "%s: %s" % (type(_exc).__name__, _exc)
        globals().update({name: None for name in _ENGINE_SYMBOLS})
        for _name in ("EngineError", "PricingError", "TermsError", "ImportError_"):
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
    """内部核算视图的权限（对齐 dev `require_tenant_admin`：deps/rbac.py:24-37）。

    判定 = 租户管理员（`users.is_tenant_admin=TRUE`）**或**平台内部管理员
    （internal + system_admin/admin）。历史只认 internal+role，导致
    orchestrator 放行的"租户管理员"在 worker 上恒 403（PARITY-QUOTE-23）。
    account_type 在真实 `_get_current_user` 里一定有（它已经 select 了这一列）；
    只有本地测试台的身份桩没有该字段 —— 那时退回「只看 role」，否则本地无法验证。
    （`role` 为 `admin` 时 dev 的 effective_role 也映射成 system_admin，故一并放行。）
    """
    if user.get("is_tenant_admin"):
        return True
    if str(user.get("role") or "") not in ("system_admin", "admin"):
        return False
    account_type = user.get("account_type")
    return account_type is None or str(account_type) == "internal"


def _require_internal_admin(user: dict) -> None:
    if not _is_internal_admin(user):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "message": "内部核算视图需要租户管理员权限"})


async def _require_internal_admin_dep(user: dict = Depends(_get_current_user)) -> dict:
    """算价的鉴权**依赖**（PARITY-QUOTE-22）。

    为什么必须是依赖而不是 handler 内的第一行：orchestrator 的
    `Depends(require_tenant_admin)`（export_quote.py:1009/1025）在 body 解析之前执行
    ⇒ 非管理员发坏 body 得到 403 而不是 422。handler 内校验会让 body 先 422，
    前端会把"没权限"误报成"参数不对"。
    """
    _require_internal_admin(user)
    return user


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
# 真源是 backend/kaas_common/domain/enums.py（sync-shared 镜像）。线上只带本工位用到的三张表
# （整份复制过去只会多一处需要同步的副本）；值必须逐字一致，否则同一状态在
# dev 能存、线上 422。
# 2026-10-19（PARITY-QUOTE-2）：补 closed —— orchestrator 的 QUOTE_STATUS 含 closed
# （domain/enums.py:23）。同一询盘生成后续单证时，其余报价会被自动置 closed（见
# main.py 的 create_trade_doc）；列表/改单若不认这个值，历史报价就查不出来也改不了。
_QUOTE_STATUS = ("draft", "sent", "accepted", "rejected", "expired", "closed")
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
# 出口报价 · 元数据（产品 / 条款模板）
# ═════════════════════════════════════════════════════════════════════════════


def _product_or_404(product_key: str):
    _require_engine()
    try:
        return get_product(product_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={
            "error": "unknown_product", "message": str(exc)})


async def _quotable_specs(request: Request, user: dict) -> dict:
    """「可报价产品」集合：注册表 ∪ 团队可见 tenant_products，再去掉被停用的。

    与 `/export-quote/products` **同一口径**（R-D 整单导入复用）：模板/预览看到的
    必须和产品下拉是同一批产品，否则会出现「下拉能选、导入说未识别」或反过来。
    """
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
        except Exception:  # noqa: BLE001 - 有意兜底：单条坏定义跳过，不拖垮整个列表
            continue

    # 需求 16：被本团队停用的产品不出现在报价下拉（复用 tenant_workstation_products）
    disabled_rows = await _db.fetch(
        request,
        "SELECT product_key FROM tenant_workstation_products"
        " WHERE tenant_id=$1 AND workstation='quote' AND is_enabled=false"
        " AND (team_id IS NULL OR team_id=$2)",
        tenant, user.get("team_id"),
        table="tenant_workstation_products",
    )
    disabled = {r["product_key"] for r in disabled_rows}

    # ── 英文名（2026-10-24）：主英文名覆盖 spec.name_en，其余英文名进 aliases ──
    # 为什么在这里：报价行 `product_name = name_en || name`
    # （frontend/src/app/(app)/quotes/lib/line-to-item.ts），并随报价落到订单/单证快照。
    # 团队资料（`product_profiles.info` 的 name_en_list / name_en_primary）是用户唯一能改
    # 英文名的入口（系统产品没有 tenant_products 行）；此处不覆盖，改完的英文名就到不了
    # 对外单据。只改**展示名**，算价字段一律不动；没配英文名的产品原样返回（旧口径不变）。
    # 全量英文名（主名 + 别名）都要参与「产品列/产品名」解析（R-D 整单导入），
    # 所以除 name_en 外还要把其余名字写进 `name_en_aliases`（ProductSpec 可选字段）。
    # 归一化口径在共享内核 `kaas_common.export_quote.product_names`（与 ws_files 同一份）。
    from dataclasses import replace as _replace  # noqa: PLC0415
    from kaas_common.export_quote.product_names import (  # noqa: PLC0415
        name_en_list_from_info,
    )

    prof_sql = "SELECT product_key, info FROM product_profiles WHERE tenant_id=$1"
    prof_args: list = [tenant]
    if not is_admin_role(user.get("role")):
        # 与 `ws_files._team_scope_soft` 同口径：非管理员只看得到本团队的资料行
        # （无团队 ⇒ 谓词 = NULL ⇒ 没命中，回落注册表名，不泄露别家英文名）。
        prof_sql += " AND team_id=$2"
        prof_args.append(user.get("team_id"))
    prof_sql += " ORDER BY updated_at DESC"
    prof_rows = await _db.fetch(  # noqa: SLF001 - 同模块既有用法
        request, prof_sql, *prof_args, table="product_profiles")
    profiles: dict = {}
    for r in prof_rows:
        if not isinstance(r, dict):
            continue
        pkey = r.get("product_key")
        if not isinstance(pkey, str) or pkey in profiles:
            continue  # 同一 key 多行（管理员视角）⇒ 最近更新的生效
        info = r.get("info")
        if isinstance(info, str):
            try:
                info = json.loads(info)
            except (TypeError, ValueError):
                info = {}
        profiles[pkey] = info if isinstance(info, dict) else {}
    for pkey, spec in list(specs.items()):
        names = name_en_list_from_info(profiles.get(pkey))
        if not names:
            continue
        # 主名 = 对外单据上的英文名；其余 = 导入/搜索可匹配的别名（不含主名）。
        specs[pkey] = _replace(spec, name_en=names[0], name_en_aliases=names[1:])

    return {key: spec for key, spec in specs.items() if spec.key not in disabled}


@app.get("/api/v1/export-quote/products")
async def export_quote_products(request: Request, user: dict = Depends(_get_current_user)):
    """已注册的产品模型（前端产品下拉的唯一来源）。

    发现层合并（2026-10-17，与 dev 同口径）：Python 注册表 ∪ tenant_products
    中调用者可见的行（本团队行优先；历史 NULL 行仅管理员），同 key tenant 行覆盖
    Python 定义 —— 运行时新增的产品在下拉里可见、可选、可算价。
    """
    _require_engine()
    specs = await _quotable_specs(request, user)

    out = []
    for spec in specs.values():
        out.append({
            "key": spec.key,
            "name": spec.name,
            "name_en": spec.name_en,
            # 该产品的其它英文名（不含 name_en）；前端选择器/导入提示与导入解析共用
            "name_en_aliases": list(spec.name_en_aliases),
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

    **租户运行时产品也支持**（2026-10-21 修）：解析走 `_product_or_404_tenant`
    （注册表 ∪ `tenant_products` 团队可见行），否则 v2 报价工作台的规格选择器
    （`use-export-quote-calc.ts` 一律读本接口）选中租户产品就 404。
    """
    spec = await _product_or_404_tenant(request, user, product_key)
    if with_customer_options:
        wanted = None
        if customer_id and _can_see_all(user):
            wanted = customer_id
        spec = await _with_customer_options(request, user, spec, wanted)
    return describe_product(spec, with_columns=with_columns)


@app.get("/api/v1/export-quote/terms/template")
async def export_quote_terms_template(user: dict = Depends(_get_current_user)):
    """平台默认的出口费用结构（贸易术语阶梯 + 费用项）。

    返回的形状**就是**报价请求里 `terms` 的形状：界面原样回传、只填 value，
    因此「FOB 包含哪些费」这类业务知识留在后端，前端不写死。
    """
    _require_engine()
    return default_terms_template()


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
        " effective_from, source, notes, created_at"
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
        except (KeyError, TypeError):
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


async def _effective_product_raw(request: Request, user: dict, product_key: str):
    """有效规格空间（**裸**）：不并入客户自定义档位；产品不存在时返回 None。

    「产品不存在」在算价入口交给引擎按它自己的口径报（400 engine_error），
    在规格空间入口由调用方报 404 —— 同一个错误在不同入口状态码本来就不同。

    与 dev `export_quote._effective_product` 同口径（2026-10-17 对齐）：
    1. tenant_products 按团队谓词取行（本团队 > 历史 NULL 仅管理员），
       基线 + override 差异走 resolve_effective_product（hash 不符抛
       SpecUpstreamChanged，绝不静默套用）；2. 回退 Python 注册表。

    为什么拆出"裸"版本（2026-10-21）：`/formulas` 与 `/explain` 也要能解析租户
    运行时产品（否则"下拉能选、一算 404"），但它们各自还有自己的后处理
    （前者按 `customer_id` 并档位、后者完全不并档位）—— 合并进来会重复应用。
    算价入口继续用 `_effective_product`（= 裸版 + 客户档位）。
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
        except SpecUpstreamChanged as exc:
            # PARITY-QUOTE-24：上游产品定义已变更（override 的 base_spec_hash 对不上）——
            # 绝不静默回退注册表（那会用旧定义算出"看着正常"的旧价）。orchestrator
            # export_quote.py:812-818 报 409 让前端提示「人工复核这条差异后再合并」。
            raise HTTPException(status_code=409, detail={
                "error": "spec_upstream_changed", "code": "SPEC_UPSTREAM_CHANGED",
                "detail": str(exc),
            })
        if spec is not None:
            return spec
    try:
        product = get_product(product_key)
    except (KeyError, TypeError):
        return None
    return product


async def _effective_product(request: Request, user: dict, product_key: str):
    """算价/规格空间入口的有效定义 = 裸版 + 客户自定义档位（与 dev 同口径）。"""
    product = await _effective_product_raw(request, user, product_key)
    if product is None:
        return None
    return await _with_customer_options(request, user, product)


async def _product_or_404_tenant(request: Request, user: dict, product_key: str):
    """产品定义解析：Python 注册表 ∪ **租户运行时产品**（团队隔离 + is_active）。

    为什么需要它（2026-10-21 B 组验收 P1）：
    `/export-quote/products`（发现）与 `/calculate`（算价）早已并入了
    `tenant_products`，但 `/formulas` 与 `/explain` 历史上只走 `_product_or_404`
    （只查 Python 注册表）⇒ 编辑器里新建的租户产品"下拉里能选、一算 404"，
    与发现层注释"可见、可选、可算价"自相矛盾。

    这里统一复用 `_effective_product_raw`：它的团队谓词与发现列表
    （`quote_api.py:354-371`）**同一份**，不新造判据；仍未命中才回落到
    `_product_or_404` 的原文案 404（保留"已注册: a, b"的提示）。

    **失败降级**：租户解析是"增强"，不是这两条路由的命脉 ⇒ DB 不可用 / 请求没有
    绑定 Hyperdrive（不接库的调用方、部分单测）时**退回旧行为**（只查注册表），
    绝不把 `/formulas`、`/explain` 整体 500 掉 —— 与 `ws_products._validate_spec`
    "引擎缺失就不校验"、`_load_cost_table` "读不到就空表"同一口径。
    `HTTPException` 必须原样抛：503 引擎不可用 / 409 override 上游已变是**业务**错误。
    """
    _require_engine()
    try:
        spec = await _effective_product_raw(request, user, product_key)
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - 见 docstring：增强失效不得阻断既有能力
        spec = None
    if spec is not None:
        return spec
    return _product_or_404(product_key)   # 抛 404（unknown_product + 已注册清单）


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
    # 本单选用的包装（产品 packaging[].id）；缺省 = 默认包装/最早创建的包装
    packaging_id: Optional[str] = None
    # 本单成本口径：pretax（默认，税前价）| incl_tax（含税价，引擎按进项票税点还原）
    cost_basis: Optional[Literal["pretax", "incl_tax"]] = Field(
        default=None, description="成本口径 pretax|incl_tax；缺省=产品定义值")
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
    # 政策：请求显式给的值优先；未给时用平台默认（税务档案已不参与算价）
    base_cfg: dict = {
        "input_vat_rate": 0.10,
        "output_vat": {"rate": 0, "mode": "additive"},
        "profit": {"mode": "fixed", "value": 0.1},
        "misc_fee_rate": 0.03,
        "refund": {"refund_ratio": "auto", "give_ratio": 1},
        "stamp": {"rate": 0, "base": "profit"},
    }
    if body.policy is not None:
        p = body.policy.model_dump(exclude_none=True)
        if "output_vat_rate" in p or "output_vat_mode" in p:
            base_cfg["output_vat"] = {
                "rate": p.pop("output_vat_rate", 0),
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
        req = make_request_from_config(cfg)
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"error": "engine_error", "message": str(exc)})
    except PricingError as exc:
        raise HTTPException(status_code=400, detail={"error": "policy_error", "message": str(exc)})

    # 这四项 `make_request_from_config` 不认（它面向报价单配置，不是引擎入参全集）
    req.product = product
    req.cost_table = cost_table or {}
    req.packaging_id = body.packaging_id or ""
    req.cost_basis = (body.cost_basis or "").strip()
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
                                         user: dict = Depends(_require_internal_admin_dep)):
    """内部核算视图（含成本、利润、税额、退税推导）—— 需要租户管理员。"""
    product = await _effective_product(request, user, body.product_key)
    return _run_calculation(
        body, user, "internal",
        await _load_cost_table(request, user, body, product), product)


@app.post("/api/v1/export-quote/verify")
async def export_quote_verify(request: Request, body: _CalculateIn,
                              user: dict = Depends(_require_internal_admin_dep)):
    """对一次报价跑三遍核验（管理员）。"""
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
# 2026-10-21 C7：上传侧不再在这里按后缀/魔数"先拒后解析"。
# 文件类型分派收敛到共享内核 `kaas_common/export_quote/importers.read_table`：
#   .csv/.txt → csv；.xlsx/.xlsm（或 zip 魔数）→ 纯 stdlib xlsx 读取器；
#   .xls（OLE2）→ 明确 400 指路另存为 .xlsx/.csv。
# 这样 CSV 与 xlsx 共用同一份 parse_table（表头别名/单位/行映射），
# 也避免 worker 侧再维护一套"什么算表格"的判据（两套必然漂移）。


async def _read_upload(file: UploadFile) -> bytes:
    """读上传字节 + 空文件/大小上限（类型分派交给内核 importers）。"""
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


def _parse_order_or_400(data: bytes, specs, filename: str = "",
                        sheet: Optional[str] = None):
    """解析整单表（多产品）；整表级失败统一 400 `parse_error`（与单产品同一错误体）。"""
    try:
        return parse_order_table(data, specs, filename=filename, sheet=sheet)
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
    """模板下载。csv 出文件；xlsx 明确 501（Excel 模板由前端浏览器端生成）。"""
    if fmt == "xlsx":
        raise HTTPException(status_code=501, detail=(
            "线上不提供 xlsx 模板下载，请改用 format=csv，"
            "或直接在批量导入页面点「下载 Excel 模板」（由浏览器端生成）"))
    if fmt != "csv":
        raise HTTPException(status_code=422, detail={
            "error": "bad_format",
            "message": "format 只能是 csv（服务端不生成 xlsx 模板；Excel 模板请在页面下载）"})
    # dev：csv 默认 0 行示例（给脚本生成用），xlsx 默认 3 行
    rows = 0 if examples is None else examples
    body = ("\ufeff" + build_template_csv(spec, examples=rows)).encode("utf-8")
    return Response(content=body, media_type="text/csv; charset=utf-8",
                    headers=_template_headers(spec, include_spec))


@app.get("/api/v1/export-quote/products/{product_key}/import-template")
async def export_quote_import_template_info(
    product_key: str,
    request: Request,
    format: str = Query("", description="给了就下载文件（csv；xlsx 501），不给则返回列定义 JSON"),
    examples: Optional[int] = Query(None, ge=0, le=50),
    include_spec: bool = Query(False),
    user: dict = Depends(_get_current_user),
):
    """模板说明（有哪些列、哪些必填、单位、可选值）；带 `format` 时改为下载文件。

    为什么一个路由兼两职：前端只用这一个 URL（`useImportTemplateInfo` 不带
    `format`、下载时带 `format`），而 dev 侧拆成了 `/products/{key}/import-template`
    （说明）与 `/import/template`（文件）两个 —— 线上把 dev 的"文件"那一路
    也收敛到本路由（旧 `/import/template` 已于 2026-10-24 下线），使前端两类调用
    都能命中同一个后端语义。
    """
    spec = await _product_or_404_tenant(request, user, product_key)
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
            "xlsx": ("/api/v1/export-quote/products/%s/import-template"
                     "?format=xlsx" % spec.key),
            "csv": ("/api/v1/export-quote/products/%s/import-template"
                    "?format=csv" % spec.key),
        },
        "notes": [
            "模板表头与导出的报价表一致：导出 → 改 → 再导入，不用另对照列名。",
            "上传支持 .xlsx 与 CSV（UTF-8，可带 BOM）；Excel 模板请点「下载 Excel 模板」"
            "（浏览器端生成，带下拉与填写说明）。",
            "老的 .xls 请先在 Excel 里另存为 .xlsx（或 CSV UTF-8）再上传。",
            "列名括号里的就是该列单位，按单位填原值即可，不要自己换算。",
        ],
    }


@app.get("/api/v1/export-quote/import/order/template-info")
async def export_quote_import_order_template_info(
    request: Request,
    keys_query: str = Query(
        "", alias="product_keys",
        description="逗号分隔的产品 key；空 = 全部可报价产品"),
    user: dict = Depends(_get_current_user),
):
    """整单批量导入模板的列定义（6 个公共列 + 各产品模板列的并集）。

    前端据此：① 逐列说明「该填什么 / 适用哪些产品」；② 用 exceljs 现生成 xlsx 模板
    （线上 Worker 没有 openpyxl，服务端不产 xlsx —— 与单产品模板同一口径）。
    """
    _require_engine()
    specs = await _quotable_specs(request, user)
    wanted = [k.strip() for k in (keys_query or "").split(",") if k.strip()]
    if wanted:
        unknown = [k for k in wanted if k not in specs]
        if unknown:
            raise HTTPException(status_code=404, detail={
                "error": "unknown_product",
                "message": "未找到产品: %s；可选: %s" % (
                    "、".join(unknown), "、".join(specs)),
            })
        # 去重但保留调用方给的顺序（列顺序 = 按产品顺序并集）
        chosen = {key: specs[key] for key in dict.fromkeys(wanted)}
    else:
        chosen = specs

    cols = order_template_columns(list(chosen.values()))
    return {
        "product_keys": list(chosen),
        "headers": [c.header for c in cols],
        "columns": [c.to_dict() for c in cols],
        "max_rows": MAX_ROWS,
        "max_mb": _IMPORT_MAX_MB,
        "data_sheet": "整单表",
        "notes": [
            "一行 = 订单里的一个产品行；「产品」列填产品中文名 / 任一英文名，或 key。",
            "规格列 = 所选产品模板列的并集：某行的产品用不上的列留空即可。",
            "「成本口径」可留空（默认不含税）；「包装方式」留空 = 用产品默认包装；"
            "「本行利润率（%）」留空 = 继承整单默认。",
            "表头请逐字照用（导入器按列名识别，别加 *、别换单位）。",
        ],
    }


@app.post("/api/v1/export-quote/import/order/preview")
async def export_quote_import_order_preview(
    request: Request,
    file: UploadFile = File(description="整单表：.xlsx（首选）或 .csv"),
    sheet: Optional[str] = Form(default=None),
    user: dict = Depends(_get_current_user),
):
    """整单表预览：解析 + 行级校验，**不落库、不算价**（结果直接填工作台）。

    产品集合 = 可报价产品（注册表 ∪ 团队可见租户产品，与 `/export-quote/products` 同源）。
    坏行不阻断其它行：行仍返回、`row_errors` 说明原因（只用 error，warning 在 issues 里）。
    """
    _require_engine()
    specs = await _quotable_specs(request, user)
    data = await _read_upload(file)
    parsed = _parse_order_or_400(
        data, list(specs.values()), file.filename or "", sheet)
    return parsed.to_dict()


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
    # ── 多产品逐行计算上下文 + 手动干预（PARITY-QUOTE-6，逐字段对齐
    #    orchestrator quote_orders.py:71-93 QuoteItemIn 17 项）──
    # 行级报价政策覆盖（利润率/综合税费系数等），空则继承报价单共享政策
    policy_override: Optional[dict] = None
    # auto（公式自动）| manual（非标产品手动给价）| overridden（覆盖公式结果）
    price_source: str = "auto"
    # 手工成本覆盖（元/kg）；有值时保存并写入成本历史（需求 11）
    cost_override: Optional[Decimal] = None
    price_override: Optional[Decimal] = None
    weight_override: Optional[Decimal] = None
    volume_override: Optional[Decimal] = None
    image_url: Optional[str] = None
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
    # 海运费有效期（需求 7；报价单级）
    freight_valid_from: Optional[str] = None
    freight_valid_to: Optional[str] = None
    # 税务档案来源 + 当时实际税率（TAX-05）
    tax_archive_id: Optional[int] = None
    tax_archive_code: Optional[str] = None
    tax_archive_name: Optional[str] = None
    tax_snapshot: Optional[dict] = None
    items: List[_QuoteItemIn] = []


class _QuoteOrderPatch(BaseModel):
    # 报价单号：仅在还没有生成 PI/合同等后续单证时可改（前端二次确认）
    quote_no: Optional[str] = None
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
    freight_valid_from: Optional[str] = None
    freight_valid_to: Optional[str] = None
    # 税务档案来源 + 当时实际税率（TAX-05）
    tax_archive_id: Optional[int] = None
    tax_archive_code: Optional[str] = None
    tax_archive_name: Optional[str] = None
    tax_snapshot: Optional[dict] = None


class _BatchQuoteGroup(_QuoteOrderCreate):
    """批量报价的一组：一个询盘一张报价单。"""
    customer_id: int
    inquiry_id: int


class _BatchQuoteIn(BaseModel):
    groups: List[_BatchQuoteGroup]


class _QuoteItemsReplace(BaseModel):
    items: List[_QuoteItemIn]


_QUOTE_TRADE_TERM_FIELDS = (
    "customer_name", "notes", "incoterm", "payment_terms",
    "port_of_loading", "port_of_destination", "shipping_marks", "country_of_origin",
    "tax_archive_code", "tax_archive_name",
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
    d = dict(row)
    if isinstance(d.get("tax_snapshot"), str):
        try:
            d["tax_snapshot"] = json.loads(d["tax_snapshot"])
        except json.JSONDecodeError:
            d["tax_snapshot"] = None
    return row_to_quote(d, item_count)


def _quote_item_json(row, user: dict | None = None) -> dict:
    """行项 → 出参。spec_snapshot 必须经 dbjson 解码（jsonb 在 Workers 里是 str）。

    内外视图红线（UNCERTAIN #19）：成本分解只对平台员工（internal）透出，
    customer 账号在**接口层**就剥掉，不靠前端隐藏。
    """
    from kaas_common.workstation.quote_serializers import row_to_item
    d = _row_to_dict(row, "quote_order_items")
    # PARITY-QUOTE-6：policy_override / cost_breakdown 同为 JSONB。dbjson 的
    # quote_order_items 映射当前只登记了 spec_snapshot（该文件不在本任务写范围），
    # 这里就地解码这两个已知 jsonb 键 —— 否则前端拿到的是字符串、zod 直接报类型错。
    for _k in ("policy_override", "cost_breakdown"):
        _v = d.get(_k)
        if isinstance(_v, str) and _v:
            try:
                d[_k] = json.loads(_v)
            except ValueError:
                pass
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
        if row.spec_snapshot and row.cost_override is None:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "COST_REQUIRED",
                "detail": "报价行必须手动填写成本（可参考历史报价后点应用）",
            })
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
            # 逐行计算上下文/手动干预（PARITY-QUOTE-6）：orchestrator `_build_items`
            # 会把这 6 个覆盖字段一并落库，worker 之前整组丢弃 ⇒ 前端"覆盖价"
            # 在报价单上消失、打印/转单拿到的还是公式原价。
            "policy_override": row.policy_override,
            "price_source": row.price_source or "auto",
            "cost_override": row.cost_override,
            "price_override": row.price_override,
            "weight_override": row.weight_override,
            "volume_override": row.volume_override,
            "image_url": row.image_url,
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
                    qty, qty_unit, unit_price, currency, line_amount,
                    policy_override, price_source, cost_override, price_override,
                    weight_override, volume_override, image_url,
                    sort_order, cost_breakdown)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,
                       $11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)""",
            tenant, quote_order_id, it["sku_id"], it["product_name"],
            json.dumps(it["spec_snapshot"]) if it["spec_snapshot"] is not None else None,
            it["qty"], it["qty_unit"], it["unit_price"], it["currency"],
            it["line_amount"],
            json.dumps(it["policy_override"]) if it.get("policy_override") is not None else None,
            it.get("price_source") or "auto",
            it.get("cost_override"), it.get("price_override"),
            it.get("weight_override"), it.get("volume_override"),
            it.get("image_url"),
            it["sort_order"],
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


async def _next_customer_no(conn, doc_type: str, table: str,
                            customer: dict) -> str:
    """编号：`类型-国家-客户-时间戳`（同秒冲突加后缀）。"""
    col = {"quote_orders": "quote_no", "trade_docs": "doc_no",
           "cust_inquiries": "inquiry_no"}.get(table, "doc_no")
    for suffix in range(1, 21):
        candidate = build_number(doc_type, customer, suffix=suffix)
        exists = await conn.fetchval(
            f"SELECT 1 FROM {table} WHERE tenant_id=$1 AND {col}=$2 LIMIT 1",
            DEFAULT_TENANT, candidate,
        )
        if not exists:
            return candidate
    return build_number(doc_type, customer) + "-X"


async def _resolve_or_create_inquiry(
    conn, tenant: str, customer: dict, user: dict,
    inquiry_id: Optional[int], items: list, owner_scope: str,
) -> int:
    """报价来源询盘：选了就校验并自动「未报价→已报价」；没选就自动建一条。"""
    if inquiry_id is not None:
        inq = await conn.fetchrow(
            "SELECT id, status, customer_id, stage FROM cust_inquiries"
            " WHERE tenant_id=$1 AND id=$2",
            tenant, inquiry_id,
        )
        if inq is None or str(inq["customer_id"]) != str(customer["id"]):
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "INQUIRY_NOT_FOUND",
                "detail": "所选询盘不存在或不属于该客户",
            })
        previous_status = inq["status"]
        if inq["status"] == "unquoted":
            await conn.execute(
                "UPDATE cust_inquiries SET status='quoted', updated_at=now()"
                " WHERE tenant_id=$1 AND id=$2",
                tenant, inquiry_id,
            )
        # 询盘阶段（TODO(TODO:F4)）：报价创建 → quotation（只前进，重复报价 no-op）
        await _inquiry_stage.advance(
            conn, tenant_id=tenant, inquiry_id=int(inquiry_id),
            target_stage=_inquiry_stage.STAGE_QUOTATION,
            source_event=_inquiry_stage.SOURCE_QUOTE_CREATED,
            actor_id=str(user["id"]),
            current_stage=inq.get("stage"), current_status=previous_status,
        )
        return int(inquiry_id)

    inquiry_no = await _next_customer_no(conn, "inquiry",
                                         "cust_inquiries", customer)
    product_name = (items[0].get("product_name") if items else None)
    row = await conn.fetchrow(
        """INSERT INTO cust_inquiries
               (tenant_id, customer_id, inquiry_no, channel, product_name_raw,
                status, created_by, owner_id, owner_scope, team_id)
           VALUES ($1,$2,$3,'quote',$4,'quoted',$5,$5,$6,$7)
           RETURNING id""",
        tenant, customer["id"], inquiry_no, product_name,
        str(user["id"]), owner_scope, customer.get("team_id"),
    )
    inquiry_id = int(row["id"])
    # 询盘阶段（TODO(TODO:F4)）：自动建询盘 + 报价 → quotation（新建行就是 inquiry，前进一档；
    # 已知 stage/status，直接传进来省一次 SELECT）
    await _inquiry_stage.advance(
        conn, tenant_id=tenant, inquiry_id=inquiry_id,
        target_stage=_inquiry_stage.STAGE_QUOTATION,
        source_event=_inquiry_stage.SOURCE_QUOTE_CREATED,
        actor_id=str(user["id"]),
        current_stage=_inquiry_stage.STAGE_INQUIRY,
        current_status="quoted",
    )
    return inquiry_id


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
        q["tenant_id"], str(q["customer_id"]), "other", json.dumps(snapshot), spec_hash,
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
    customer_id: Optional[int] = None,
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
    ids = [r["id"] for r in rows]
    locked: set = set()
    if ids:
        locked_docs = await _db.fetch(
            request,
            "SELECT DISTINCT quote_id FROM trade_docs"
            " WHERE tenant_id=$1 AND quote_id = ANY($2::bigint[])"
            " AND doc_type <> 'quotation'",
            tenant, ids,
        )
        locked.update(r["quote_id"] for r in locked_docs)
        locked_orders = await _db.fetch(
            request,
            "SELECT DISTINCT quote_id FROM orders"
            " WHERE tenant_id=$1 AND quote_id = ANY($2::bigint[])",
            tenant, ids,
        )
        locked.update(r["quote_id"] for r in locked_orders)
    return {
        "items": [
            {**_quote_json(r, counts.get(r["id"], 0)),
             "quote_no_editable": r["id"] not in locked}
            for r in rows
        ],
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

    # PARITY-QUOTE-5：错误优先级对齐 orchestrator（quote_orders.py:524-531 ——
    # 客户闸门在 `_build_items` **之前**）。否则「没选客户 + 某行缺成本」会先报
    # COST_REQUIRED，前端把"漏选客户"提示成"填成本"，用户改错地方。
    # 只需在这里判存在性：真闸门（存在/未软删/可见/团队）仍在事务内 `_doc_customer`。
    if body.customer_id is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CUSTOMER_REQUIRED",
            "field": "customer_id",
            "detail": ("单据必须归属业务客户：请从已有业务客户里选择"
                       "（没有 customer_id，客户页的「往来记录」里就查不到这张单）"),
        })

    items, total = _build_items(currency, body.items)
    rate, rate_date = await _lock_fx_rate(request, currency)

    async with _db.acquire(request) as conn:
        async with conn.transaction():
            # 客户闸门（必填）：复用 main 的**同一道**闸门（存在/未软删/可见/属本团队），
            # 不在这里另写一套校验 —— 另写必然与订单/单证两处漂移。
            customer = await _doc_customer(conn, body.customer_id, user, required=True)
            quote_no = await _next_customer_no(conn, "quotation", "quote_orders", customer)
            inquiry_id = await _resolve_or_create_inquiry(
                conn, tenant, customer, user, body.inquiry_id, items, owner_scope,
            )
            row = await conn.fetchrow(
                """INSERT INTO quote_orders
                       (tenant_id, quote_no, customer_id, customer_name, inquiry_id,
                        status, currency, total_amount, valid_until, notes,
                        fx_rate, fx_rate_date, created_by, owner_id, owner_scope,
                        incoterm, payment_terms, port_of_loading, port_of_destination,
                        shipping_marks, country_of_origin, freight_valid_from, freight_valid_to,
                        tax_archive_id, tax_archive_code, tax_archive_name, tax_snapshot,
                        team_id)
                   VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$12,$13,
                           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26)
                   RETURNING *""",
                tenant, quote_no, customer["id"],
                # 客户名快照：显式传入优先，否则按客户档案取（开单当时的名字）
                body.customer_name or customer.get("name"),
                inquiry_id,
                currency, total if items else None, _parse_dt(body.valid_until), body.notes,
                rate, rate_date, str(user["id"]), owner_scope,
                body.incoterm, body.payment_terms, body.port_of_loading,
                body.port_of_destination, body.shipping_marks, body.country_of_origin,
                _parse_dt(body.freight_valid_from).date() if body.freight_valid_from else None,
                _parse_dt(body.freight_valid_to).date() if body.freight_valid_to else None,
                body.tax_archive_id, body.tax_archive_code, body.tax_archive_name,
                json.dumps(body.tax_snapshot) if body.tax_snapshot is not None else None,
                # 单据与客户同团队（而不是"创建者的团队"）
                customer.get("team_id"),
            )
            if items:
                await _insert_quote_items(conn, tenant, row["id"], items)
            # 2026-10-18：客户阶段读时由「开启中的订单」推导，报价变化不再回写客户阶段。
            await _ensure_quotation_doc(conn, tenant, dict(row), items, request)
    return _quote_json(dict(row), len(items))


@app.post("/api/v1/quotes/batch", status_code=201)
async def create_quote_batch(request: Request, body: _BatchQuoteIn,
                             user: dict = Depends(_get_current_user)):
    """批量报价：逐组复用单笔建单，单组失败不拖垮整批（最多 200 组）。"""
    if not body.groups:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "EMPTY_BATCH", "detail": "批量报价至少需要一组"})
    if len(body.groups) > 200:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BATCH_TOO_LARGE",
            "detail": f"单批最多 200 行，当前 {len(body.groups)} 行"})
    created: list[dict] = []
    failed: list[dict] = []
    for group in body.groups:
        try:
            q = await create_quote_order(request, group, user)
            created.append({
                "inquiry_id": group.inquiry_id,
                "customer_id": str(group.customer_id),
                "quote_id": q.get("id"),
                "quote_no": q.get("quote_no"),
            })
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            failed.append({
                "inquiry_id": group.inquiry_id,
                "customer_id": str(group.customer_id),
                "code": detail.get("code") or f"HTTP_{exc.status_code}",
                "detail": detail.get("detail") or str(exc.detail),
            })
        except Exception as exc:  # noqa: BLE001 - 有意兜底：单组失败如实进 failed，不拖垮整批
            failed.append({
                "inquiry_id": group.inquiry_id,
                "customer_id": str(group.customer_id),
                "code": "BATCH_GROUP_FAILED",
                "detail": f"{type(exc).__name__}: {exc}",
            })
    return {"created": created, "failed": failed,
            "total": len(created) + len(failed)}


@app.get("/api/v1/quotes/reference-price")
async def quote_reference_price(request: Request, customer_id: int,
                                product_name: str, spec: Optional[str] = None,
                                # PARITY-QUOTE-3：orchestrator 是 Query(180, ge=1, le=730)
                                # （quote_orders.py:639）⇒ 越界 422；静默钳位会让
                                # "取 0 天"这类坏参数看起来像成功。
                                days: int = Query(180, ge=1, le=730),
                                user: dict = Depends(_get_current_user)):
    """历史参考价（UNCERTAIN #19 · 实时报价的回落参考）——与 dev 同口径。

    聚合同客户+同产品近 N 天已落库报价行项的单价；spec 给 JSON 字符串时按
    spec_snapshot 语义相等精确匹配。可见范围与报价单列表同口径（_scope_sql）。
    """
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


@app.get("/api/v1/quotes/cost-reference")
async def quote_cost_reference(
    request: Request,
    product_key: str,
    spec: str,
    user: dict = Depends(_get_current_user),
):
    """成本参考价 —— 直接从历史报价行项提取（与 orchestrator 同路径/同口径）。

    历史报价就是成本历史：`quote_order_items.cost_override + spec_snapshot`
    （含完整产品参数）。同产品+同规格取最近一次，否则近 30 天中位数。
    """
    try:
        specs = json.loads(spec)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_SPEC",
            "detail": "spec 必须是 JSON 对象",
        })
    if not isinstance(specs, dict):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_SPEC",
            "detail": "spec 必须是 JSON 对象",
        })

    params: list = [_tenant_of(user), product_key, json.dumps(specs)]
    same = await _db.fetchrow(
        request,
        "SELECT i.cost_override, i.spec_snapshot, q.quote_no, q.created_at"
        " FROM quote_order_items i JOIN quote_orders q"
        "   ON q.tenant_id = i.tenant_id AND q.id = i.quote_order_id"
        " WHERE i.tenant_id=$1 AND i.spec_snapshot->>'product_key'=$2"
        "   AND i.cost_override IS NOT NULL"
        "   AND i.spec_snapshot->'specs' = $3::jsonb"
        + _scope_sql(user, params, "q")
        + " ORDER BY q.created_at DESC, i.id DESC LIMIT 1",
        *params,
    )
    if same:
        snapshot = same["spec_snapshot"] if isinstance(same["spec_snapshot"], dict) else {}
        return {"reference": {
            "cost": float(same["cost_override"]),
            "cost_unit": snapshot.get("cost_unit") or "",
            "source": "latest",
            "sample_count": 1,
            "as_of": same["created_at"].isoformat() if same["created_at"] else None,
            "quote_no": same["quote_no"],
            "spec_snapshot": snapshot,
        }}

    params = [_tenant_of(user), product_key]
    rows = await _db.fetch(
        request,
        "SELECT i.cost_override, i.spec_snapshot, q.quote_no, q.created_at"
        " FROM quote_order_items i JOIN quote_orders q"
        "   ON q.tenant_id = i.tenant_id AND q.id = i.quote_order_id"
        " WHERE i.tenant_id=$1 AND i.spec_snapshot->>'product_key'=$2"
        "   AND i.cost_override IS NOT NULL"
        "   AND q.created_at >= now() - interval '30 days'"
        + _scope_sql(user, params, "q")
        + " ORDER BY q.created_at DESC, i.id DESC",
        *params,
    )
    if not rows:
        return {"reference": None}
    costs = sorted(float(r["cost_override"]) for r in rows)
    n = len(costs)
    median = costs[n // 2] if n % 2 else (costs[n // 2 - 1] + costs[n // 2]) / 2
    latest = rows[0]
    snapshot = latest["spec_snapshot"] if isinstance(latest["spec_snapshot"], dict) else {}
    return {"reference": {
        "cost": median,
        "cost_unit": snapshot.get("cost_unit") or "",
        "source": "median_30d",
        "sample_count": n,
        "as_of": latest["created_at"].isoformat() if latest["created_at"] else None,
        "quote_no": latest["quote_no"],
        "spec_snapshot": snapshot,
    }}


@app.get("/api/v1/quotes/{quote_id}")
async def get_quote_order(quote_id: int, request: Request,
                          user: dict = Depends(_get_current_user)):
    """报价单详情（含行项）。"""
    tenant = _tenant_of(user)
    async with _db.acquire(request) as conn:
        q = await _quote_or_404(conn, tenant, quote_id, user)
        items = await _items_of(conn, tenant, q["id"])
    payload = _quote_json(q, len(items))
    locked = await _db.fetchval(
        request,
        "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
        " AND doc_type <> 'quotation' LIMIT 1",
        tenant, quote_id,
    )
    if not locked:
        locked = await _db.fetchval(
            request,
            "SELECT 1 FROM orders WHERE tenant_id=$1 AND quote_id=$2 LIMIT 1",
            tenant, quote_id,
        )
    payload["quote_no_editable"] = not bool(locked)
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

    if body.tax_archive_id is not None:
        params.append(body.tax_archive_id)
        sets.append(f"tax_archive_id=${len(params)}")
    if body.tax_snapshot is not None:
        params.append(json.dumps(body.tax_snapshot))
        sets.append(f"tax_snapshot=${len(params)}::jsonb")

    async with _db.acquire(request) as conn:
        async with conn.transaction():
            q = await _quote_or_404(conn, tenant, quote_id, user)
            _check_write_access(user, q)

            if body.quote_no is not None and body.quote_no != q["quote_no"]:
                try:
                    new_no = normalize_number(body.quote_no)
                except NumberError as exc:
                    raise HTTPException(status_code=422, detail={
                        "error": "validation", "code": "INVALID_QUOTE_NO",
                        "detail": str(exc),
                    })
                downstream = await conn.fetchval(
                    "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
                    " AND doc_type <> 'quotation' LIMIT 1",
                    tenant, quote_id,
                )
                if not downstream:
                    downstream = await conn.fetchval(
                        "SELECT 1 FROM orders WHERE tenant_id=$1 AND quote_id=$2 LIMIT 1",
                        tenant, quote_id,
                    )
                if downstream:
                    raise HTTPException(status_code=409, detail={
                        "error": "conflict", "code": "QUOTE_NO_LOCKED",
                        "detail": "该报价已生成 PI/合同等后续单证（或已转订单），报价单号已锁定",
                    })
                taken = await conn.fetchval(
                    "SELECT 1 FROM quote_orders WHERE tenant_id=$1 AND quote_no=$2"
                    " AND id<>$3 LIMIT 1",
                    tenant, new_no, quote_id,
                )
                if taken:
                    raise HTTPException(status_code=409, detail={
                        "error": "conflict", "code": "QUOTE_NO_TAKEN",
                        "detail": f"报价单号「{new_no}」已被占用，请换一个",
                    })
                q = {**q, "quote_no": new_no}
                params.append(new_no)
                sets.append(f"quote_no=${len(params)}")

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
            if body.freight_valid_from is not None:
                params.append(_parse_dt(body.freight_valid_from).date() if body.freight_valid_from else None)
                sets.append(f"freight_valid_from=${len(params)}")
            if body.freight_valid_to is not None:
                params.append(_parse_dt(body.freight_valid_to).date() if body.freight_valid_to else None)
                sets.append(f"freight_valid_to=${len(params)}")
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


@app.get("/api/v1/export-quote/products/{product_key}/spec")
async def export_quote_product_spec(
    request: Request,
    product_key: str,
    user: dict = Depends(_get_current_user),
):
    """产品的原始定义（与 orchestrator 同路径；产品工位「自定义」用它做底稿）。"""
    from kaas_common.export_quote.tenant_products import spec_to_dict

    spec = await _effective_product(request, user, product_key)
    if spec is None:
        raise HTTPException(status_code=404, detail={
            "error": "unknown_product", "message": f"未知产品 {product_key}"})
    return {"product_key": product_key, "spec": spec_to_dict(spec)}
