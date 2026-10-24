"""税务档案（tax_archives）写路径的**纯校验** —— orchestrator 与 Worker 共用。

为什么要有这一份（2026-10-24，P2 §9 #4 的前置项）
--------------------------------------------------
POST/PATCH/DELETE /api/v1/tax-archives 的校验原先写在 worker handler
（backend/worker/src/tax_archives.py:218/248/295）里。P3 要把这三条迁到门面直连 DB，
若校验留在 handler，门面必然再写第二份（ADR-008 禁止）⇒ 把**纯校验**收敛到这里，
handler 与门面 TS 实现都只认这一份。

边界（与 workstation/*_rules.py 同风格）
------------------------------------------
- **无 DB / 无 IO / 无隐式时间来源**：需要"当前时间"的（自动编码 TAX-yyyyMMdd-i）
  由调用方传入日期，本模块只做格式与校验；
- 唯一外部依赖是 fastapi.HTTPException（与 kaas_common/domain/enums.py 同做法），
  这样 422/409 的**信封（status + detail 里的 error/code/detail 文案）逐字不变** ——
  这些是对外契约（前端按 code 分支）；
- 单表语义：本模块不拼 SQL，事务/唯一性/取号等 DB 侧仍在 handler（单表，无跨表事务）。
"""
from __future__ import annotations

from datetime import date
from typing import Any, Mapping, Optional

from fastapi import HTTPException

__all__ = [
    "TAX_KEYS",
    "ARCHIVE_STATUSES",
    "PRODUCT_RATE_LABELS",
    "normalize_name",
    "normalize_code",
    "clean_tax_values",
    "parse_effective_date",
    "validate_status",
    "resolve_patch",
    "ensure_archive_team",
    "normalize_product_key",
    "ensure_known_product",
    "validate_tax_rate",
    "ensure_at_least_one_rate",
    "resolve_rate_patch",
]

# 档案里只允许这两类税（tax_models.py:TaxArchive.tax_values 的键白名单）：
# 销项增值税率 / 杂税综合系数。进项税与退税率按产品走（product_tax_rates）。
TAX_KEYS = ("output_vat_rate", "misc_fee_rate")

# 档案状态：active（启用）/ inactive（停用；DELETE = 软删到 inactive）。
ARCHIVE_STATUSES = ("active", "inactive")

# 产品税率两档的**报错用标签**（product_tax_rates：进项税 / 出口退税，按产品维护）：
# 422 文案里用的是中文标签，不是列名 —— 与迁移前逐字一致。
PRODUCT_RATE_LABELS = {"input_vat_rate": "进项增值税率", "rebate_rate": "出口退税率"}


def _get(raw: Any, key: str) -> Any:
    """同时接受 dict / pydantic 模型（迁移期 handler 传哪种都不改语义）。"""
    if raw is None:
        return None
    if isinstance(raw, Mapping):
        return raw.get(key)
    return getattr(raw, key, None)


def normalize_name(raw: Any) -> str:
    """档案名称归一：strip；空 → 422 NAME_REQUIRED（文案与迁移前逐字一致）。"""
    text = str(raw).strip() if raw is not None else ""
    if not text:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NAME_REQUIRED", "detail": "档案名称不能为空",
        })
    return text


def normalize_code(raw: Any) -> Optional[str]:
    """档案编码归一：strip；空（或纯空白）→ None（调用方决定"沿用旧值"还是"自动生成"）。"""
    if raw is None:
        return None
    return str(raw).strip() or None


def validate_status(status: Any) -> Optional[str]:
    """状态只能是 active / inactive，否则 422 INVALID_STATUS（逐字保留旧文案）。"""
    if status not in ARCHIVE_STATUSES:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_STATUS",
            "detail": "status 只能是 active / inactive",
        })
    return status


def parse_effective_date(value: Any) -> Optional[date]:
    """生效/失效日期：空 → None；非法 → 422 INVALID_DATE（文案逐字保留旧版）。"""
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_DATE",
            "detail": f"日期格式不合法：{value}（应为 YYYY-MM-DD）",
        })


def clean_tax_values(raw: Any) -> dict:
    """税率值归一 + 范围校验（0~1）：至少填一项，逐项必须在 [0,1]。

    错误码/文案与迁移前逐字一致：
    - 单项越界 → 422 INVALID_TAX_RATE（`{key} 必须在 0~1 之间（10% 请填 0.1）`）；
    - 一项都没填 → 422 TAX_VALUES_REQUIRED（`至少填写一个税率项`）。
    """
    if raw is None:
        return {}
    values: dict = {}
    for key in TAX_KEYS:
        value = _get(raw, key)
        if value is None:
            continue
        number = float(value)
        if not (0 <= number <= 1):
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "INVALID_TAX_RATE",
                "detail": f"{key} 必须在 0~1 之间（10% 请填 0.1）",
            })
        values[key] = number
    if not values:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "TAX_VALUES_REQUIRED",
            "detail": "至少填写一个税率项",
        })
    return values


def resolve_patch(body: Mapping, row: Mapping) -> dict:
    """PATCH 的"只更新显式给出（非 None）的字段"合并语义 —— 纯函数，逐条对齐迁移前 handler。

    校验顺序刻意与旧实现一致（name → tax_values → effective_from → effective_to → status），
    这样多字段同时非法时**先报哪一个**也逐字不变。
    """
    if body.get("name") is not None:
        name = normalize_name(body.get("name"))
    else:
        name = row.get("name")
        if not name:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "NAME_REQUIRED", "detail": "档案名称不能为空",
            })

    code = normalize_code(body.get("code")) if body.get("code") is not None else row.get("code")

    if body.get("tax_values") is not None:
        values = clean_tax_values(body.get("tax_values"))
    else:
        values = row.get("tax_values") or {}

    effective_from = (parse_effective_date(body.get("effective_from"))
                      if body.get("effective_from") is not None else row.get("effective_from"))
    effective_to = (parse_effective_date(body.get("effective_to"))
                    if body.get("effective_to") is not None else row.get("effective_to"))
    source = body.get("source") if body.get("source") is not None else row.get("source")
    status = body.get("status") if body.get("status") is not None else row.get("status")
    validate_status(status)
    return {
        "name": name,
        "code": code,
        "effective_from": effective_from,
        "effective_to": effective_to,
        "tax_values": values,
        "source": source,
        "status": status,
    }


def ensure_archive_team(row: Mapping, team_id: Any, detail: str) -> None:
    """档案必须属于操作者的团队（PATCH/DELETE 用；detail 由调用方给，保持旧文案逐字不同）。"""
    if row.get("team_id") != team_id:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED", "detail": detail,
        })


# ── 产品税率（product_tax_rates）写路径的纯校验 ──────────────────────────────
# 与 tax_archives 同域（tax_archives.py 一并维护两张税表）；迁移前这些判定写在
# POST/PATCH handler 里，P3 门面直连前先收敛到这一份（ADR-008：不得出现第二份）。


def normalize_product_key(raw: Any) -> str:
    """产品键归一：strip（迁移前就是这个口径；空/未知都落到 ensure_known_product 的 422）。"""
    return str(raw).strip() if raw is not None else ""


def ensure_known_product(product_key: str) -> None:
    """产品必须在共享注册表里（kaas_common.export_quote.products.has）；否则 422 UNKNOWN_PRODUCT。

    惰性 import：注册表模块导入即注册三个产品，顶层 import 会与 export_quote 形成环。
    """
    from kaas_common.export_quote.products import has as has_product

    if not has_product(product_key):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "UNKNOWN_PRODUCT",
            "detail": f"产品 {product_key} 不存在",
        })


def validate_tax_rate(value: Any, label: str) -> Optional[float]:
    """单档税率：None → None；其余转 float 且必须在 [0,1]，否则 422 INVALID_TAX_RATE。

    label 用中文（"进项增值税率"/"出口退税率"），文案与迁移前逐字一致。
    """
    if value is None:
        return None
    number = float(value)
    if not (0 <= number <= 1):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_TAX_RATE",
            "detail": f"{label} 必须在 0~1 之间（10% 请填 0.1）",
        })
    return number


def ensure_at_least_one_rate(input_rate: Optional[float], rebate_rate: Optional[float]) -> None:
    """POST 专用：两档税率至少填一个（PATCH 允许两档都为空，故不在此校验）。"""
    if input_rate is None and rebate_rate is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "TAX_VALUES_REQUIRED",
            "detail": "进项增值税率、出口退税率至少填一个",
        })


def resolve_rate_patch(body: Mapping, row: Mapping) -> dict:
    """PATCH 的合并语义：只覆盖**显式给出（非 None）**的那一档，另一档沿用旧值。

    与迁移前 handler 逐条一致：旧值先 float(...)，新值走 validate_tax_rate（同样 0~1 校验）。
    """
    input_rate = float(row["input_vat_rate"]) if row.get("input_vat_rate") is not None else None
    rebate_rate = float(row["rebate_rate"]) if row.get("rebate_rate") is not None else None
    if body.get("input_vat_rate") is not None:
        input_rate = validate_tax_rate(
            body.get("input_vat_rate"), PRODUCT_RATE_LABELS["input_vat_rate"])
    if body.get("rebate_rate") is not None:
        rebate_rate = validate_tax_rate(
            body.get("rebate_rate"), PRODUCT_RATE_LABELS["rebate_rate"])
    return {"input_vat_rate": input_rate, "rebate_rate": rebate_rate}

