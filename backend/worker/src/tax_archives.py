"""税务档案 CRUD（Worker 对等 TAX-03）。

与 orchestrator `app/api/tax_archives.py` 同路径、同字段、同状态码：
  GET    /api/v1/tax-archives
  POST   /api/v1/tax-archives
  PATCH  /api/v1/tax-archives/{id}
  DELETE /api/v1/tax-archives/{id}   （软删 = status inactive）

只做档案维护；档案不参与算价。
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from main import (  # noqa: E402
    DEFAULT_TENANT,
    _get_current_user,
    _require_team_admin,
    app,
    db,
)
# 写路径的**纯校验唯一一份**在共享内核（P2 §9 #4 前置，2026-10-24）：
# 名称/编码归一、税率值范围、日期解析、状态机、PATCH 合并语义 —— 门面 TS 实现也只认这一份。
# 本文件只保留 DB/取号/唯一性/事务等 IO 侧逻辑（单表，无跨表事务）。
from kaas_common.workstation.tax_archive_rules import (  # noqa: E402
    clean_tax_values,
    ensure_archive_team,
    normalize_code,
    normalize_name,
    parse_effective_date,
    resolve_patch,
)


class TaxValuesIn(BaseModel):
    output_vat_rate: Optional[float] = None
    misc_fee_rate: Optional[float] = None


class TaxArchiveCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    code: Optional[str] = Field(default=None, max_length=40)
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    tax_values: TaxValuesIn
    source: Optional[str] = None


class TaxArchivePatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    code: Optional[str] = Field(default=None, max_length=40)
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    tax_values: Optional[TaxValuesIn] = None
    source: Optional[str] = None
    status: Optional[str] = None


class ProductTaxRateIn(BaseModel):
    product_key: str = Field(min_length=1, max_length=80)
    input_vat_rate: Optional[float] = None
    rebate_rate: Optional[float] = None


class ProductTaxRatePatch(BaseModel):
    input_vat_rate: Optional[float] = None
    rebate_rate: Optional[float] = None





def _row_out(row) -> dict:
    d = dict(row)
    if isinstance(d.get("tax_values"), str):
        try:
            d["tax_values"] = json.loads(d["tax_values"])
        except json.JSONDecodeError:
            d["tax_values"] = {}
    for key in ("effective_from", "effective_to", "created_at", "updated_at"):
        if d.get(key) is not None and hasattr(d[key], "isoformat"):
            d[key] = d[key].isoformat()
    return {
        "id": d["id"], "code": d.get("code"), "name": d["name"],
        "effective_from": d.get("effective_from"),
        "effective_to": d.get("effective_to"),
        "tax_values": d.get("tax_values") or {},
        "source": d.get("source"), "status": d.get("status"),
        "created_at": d.get("created_at"), "updated_at": d.get("updated_at"),
    }


async def _team_id(request: Request, user: dict, write: bool) -> Optional[int]:
    ticket_team = user.get("team_id")
    if write:
        if ticket_team is None:
            raise HTTPException(status_code=403, detail={
                "error": "forbidden", "code": "TEAM_REQUIRED",
                "detail": "税务档案是团队级资源，当前账号没有团队",
            })
        await _require_team_admin(request, user)
        return ticket_team
    return ticket_team


def _where(user: dict, include_inactive: bool) -> tuple[str, list]:
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    team_id = user.get("team_id")
    if team_id is not None:
        params.append(team_id)
        where.append(f"team_id = ${len(params)}")
    from kaas_common.workstation.scope import is_admin_role
    if not include_inactive or not is_admin_role(user.get("role")):
        where.append("status = 'active'")
    return " AND ".join(where), params


async def _archive_or_404(request: Request, user: dict, archive_id: int):
    team_id = user.get("team_id")
    sql = "SELECT * FROM tax_archives WHERE tenant_id=$1 AND id=$2"
    params: list = [DEFAULT_TENANT, archive_id]
    if team_id is not None:
        params.append(team_id)
        sql += f" AND team_id = ${len(params)}"
    row = await db.fetchrow(request, sql, *params, table="tax_archives")
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TAX_ARCHIVE_NOT_FOUND",
        })
    return row


async def _check_unique(request: Request, team_id: int, name: Optional[str],
                        code: Optional[str], exclude_id: Optional[int] = None):
    for column, value, label, error_code in (
        ("name", name, "名称", "NAME_TAKEN"),
        ("code", code, "编码", "CODE_TAKEN"),
    ):
        if value in (None, ""):
            continue
        params: list = [DEFAULT_TENANT, team_id, value]
        sql = ("SELECT 1 FROM tax_archives WHERE tenant_id=$1"
               f" AND team_id=$2 AND {column}=$3")
        if exclude_id is not None:
            params.append(exclude_id)
            sql += f" AND id<>${len(params)}"
        exists = await db.fetchval(request, sql + " LIMIT 1", *params)
        if exists:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": error_code,
                "detail": f"税务档案{label}「{value}」在本团队已存在",
            })


async def _next_code(request: Request, team_id: int) -> str:
    base = f"TAX-{datetime.now().strftime('%Y%m%d')}"
    for i in range(1, 100):
        candidate = f"{base}-{i}"
        exists = await db.fetchval(
            request,
            "SELECT 1 FROM tax_archives WHERE tenant_id=$1 AND team_id=$2"
            " AND code=$3 LIMIT 1",
            DEFAULT_TENANT, team_id, candidate,
        )
        if not exists:
            return candidate
    raise HTTPException(status_code=409, detail={
        "error": "conflict", "code": "CODE_GENERATION_FAILED",
        "detail": "自动生成档案编码失败，请手动填写编码",
    })


@app.get("/api/v1/tax-archives")
async def list_tax_archives(
    request: Request,
    include_inactive: bool = Query(False),
    user: dict = Depends(_get_current_user),
):
    where, params = _where(user, include_inactive)
    rows = await db.fetch(
        request,
        f"SELECT * FROM tax_archives WHERE {where}"
        " ORDER BY effective_from DESC NULLS LAST, updated_at DESC",
        *params, table="tax_archives",
    )
    return {"items": [_row_out(r) for r in rows], "total": len(rows)}


@app.post("/api/v1/tax-archives", status_code=201)
async def create_tax_archive(
    request: Request,
    body: TaxArchiveCreate,
    user: dict = Depends(_get_current_user),
):
    team_id = await _team_id(request, user, write=True)
    name = normalize_name(body.name)
    values = clean_tax_values(body.tax_values)
    # 注意顺序：日期解析在 _check_unique **之后**（迁移前如此，多错时先报 409 的优先级不变）
    code = normalize_code(body.code) or await _next_code(request, team_id)
    await _check_unique(request, team_id, name, code)
    row = await db.fetchrow(
        request,
        """INSERT INTO tax_archives
               (tenant_id, team_id, code, name, effective_from, effective_to,
                tax_values, source, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'active',$9)
           RETURNING *""",
        DEFAULT_TENANT, team_id, code, name,
        parse_effective_date(body.effective_from), parse_effective_date(body.effective_to),
        json.dumps(values), body.source, str(user["id"]),
        table="tax_archives",
    )
    return _row_out(row)


@app.patch("/api/v1/tax-archives/{archive_id}")
async def update_tax_archive(
    archive_id: int,
    request: Request,
    body: TaxArchivePatch,
    user: dict = Depends(_get_current_user),
):
    team_id = await _team_id(request, user, write=True)
    row = await _archive_or_404(request, user, archive_id)
    ensure_archive_team(row, team_id, "不能修改其他团队的税务档案")
    # 合并语义（只改显式给出的字段）与全部纯校验都在共享内核同一份里（顺序也照旧）
    fields = resolve_patch(body.model_dump(), row)
    await _check_unique(request, team_id, fields["name"], fields["code"],
                        exclude_id=archive_id)
    row = await db.fetchrow(
        request,
        """UPDATE tax_archives SET name=$3, code=$4, effective_from=$5,
               effective_to=$6, tax_values=$7::jsonb, source=$8, status=$9,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2 RETURNING *""",
        DEFAULT_TENANT, archive_id, fields["name"], fields["code"],
        fields["effective_from"], fields["effective_to"],
        json.dumps(fields["tax_values"]), fields["source"], fields["status"],
        table="tax_archives",
    )
    return _row_out(row)


@app.delete("/api/v1/tax-archives/{archive_id}")
async def delete_tax_archive(
    archive_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    team_id = await _team_id(request, user, write=True)
    row = await _archive_or_404(request, user, archive_id)
    ensure_archive_team(row, team_id, "不能停用其他团队的税务档案")
    await db.execute(
        request,
        "UPDATE tax_archives SET status='inactive', updated_at=now()"
        " WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, archive_id,
    )
    return {"id": archive_id, "status": "inactive"}


# ── 产品税率（进项税 / 出口退税率，按产品维护）────────────────────────────

def _rate_or_422(value: Optional[float], label: str) -> Optional[float]:
    if value is None:
        return None
    number = float(value)
    if not (0 <= number <= 1):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_TAX_RATE",
            "detail": f"{label} 必须在 0~1 之间（10% 请填 0.1）",
        })
    return number


def _product_tax_out(row) -> dict:
    d = dict(row)
    for key in ("created_at", "updated_at"):
        if d.get(key) is not None and hasattr(d[key], "isoformat"):
            d[key] = d[key].isoformat()
    return {
        "id": d["id"],
        "product_key": d["product_key"],
        "input_vat_rate": float(d["input_vat_rate"]) if d.get("input_vat_rate") is not None else None,
        "rebate_rate": float(d["rebate_rate"]) if d.get("rebate_rate") is not None else None,
        "status": d["status"],
        "created_at": d.get("created_at"),
        "updated_at": d.get("updated_at"),
    }


def _product_tax_where(user: dict) -> tuple[str, list]:
    where = ["tenant_id = $1", "status = 'active'"]
    params: list = [DEFAULT_TENANT]
    team_id = user.get("team_id")
    if team_id is not None:
        params.append(team_id)
        where.append(f"team_id = ${len(params)}")
    return " AND ".join(where), params


async def _product_tax_or_404(request: Request, user: dict, rate_id: int):
    where, params = _product_tax_where(user)
    params.append(rate_id)
    row = await db.fetchrow(
        request,
        f"SELECT * FROM product_tax_rates WHERE {where} AND id = ${len(params)}",
        *params, table="product_tax_rates",
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "PRODUCT_TAX_NOT_FOUND",
        })
    return row


@app.get("/api/v1/product-tax-rates")
async def list_product_tax_rates(
    request: Request,
    user: dict = Depends(_get_current_user),
):
    where, params = _product_tax_where(user)
    rows = await db.fetch(
        request,
        f"SELECT * FROM product_tax_rates WHERE {where} ORDER BY product_key ASC",
        *params, table="product_tax_rates",
    )
    return {"items": [_product_tax_out(r) for r in rows], "total": len(rows)}


@app.post("/api/v1/product-tax-rates", status_code=201)
async def create_product_tax_rate(
    request: Request,
    body: ProductTaxRateIn,
    user: dict = Depends(_get_current_user),
):
    team_id = await _team_id(request, user, write=True)
    product_key = body.product_key.strip()
    from kaas_common.export_quote.products import has as has_product
    if not has_product(product_key):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "UNKNOWN_PRODUCT",
            "detail": f"产品 {product_key} 不存在",
        })
    input_rate = _rate_or_422(body.input_vat_rate, "进项增值税率")
    rebate_rate = _rate_or_422(body.rebate_rate, "出口退税率")
    if input_rate is None and rebate_rate is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "TAX_VALUES_REQUIRED",
            "detail": "进项增值税率、出口退税率至少填一个",
        })
    existing = await db.fetchrow(
        request,
        "SELECT * FROM product_tax_rates WHERE tenant_id=$1 AND team_id=$2"
        " AND product_key=$3 LIMIT 1",
        DEFAULT_TENANT, team_id, product_key, table="product_tax_rates",
    )
    if existing is not None and existing.get("status") == "active":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "PRODUCT_TAX_EXISTS",
            "detail": f"产品 {product_key} 已配置税率，请直接修改",
        })
    if existing is not None:
        row = await db.fetchrow(
            request,
            """UPDATE product_tax_rates SET input_vat_rate=$3, rebate_rate=$4,
                   status='active', updated_at=now()
               WHERE tenant_id=$1 AND id=$2 RETURNING *""",
            DEFAULT_TENANT, existing["id"], input_rate, rebate_rate,
            table="product_tax_rates",
        )
        return _product_tax_out(row)
    row = await db.fetchrow(
        request,
        """INSERT INTO product_tax_rates
               (tenant_id, team_id, product_key, input_vat_rate, rebate_rate,
                status, created_by)
           VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *""",
        DEFAULT_TENANT, team_id, product_key, input_rate, rebate_rate,
        str(user["id"]), table="product_tax_rates",
    )
    return _product_tax_out(row)


@app.patch("/api/v1/product-tax-rates/{rate_id}")
async def update_product_tax_rate(
    rate_id: int,
    request: Request,
    body: ProductTaxRatePatch,
    user: dict = Depends(_get_current_user),
):
    await _team_id(request, user, write=True)
    row = await _product_tax_or_404(request, user, rate_id)
    input_rate = (float(row["input_vat_rate"]) if row.get("input_vat_rate") is not None
                  else None)
    rebate_rate = (float(row["rebate_rate"]) if row.get("rebate_rate") is not None
                   else None)
    if body.input_vat_rate is not None:
        input_rate = _rate_or_422(body.input_vat_rate, "进项增值税率")
    if body.rebate_rate is not None:
        rebate_rate = _rate_or_422(body.rebate_rate, "出口退税率")
    row = await db.fetchrow(
        request,
        """UPDATE product_tax_rates SET input_vat_rate=$3, rebate_rate=$4,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2 RETURNING *""",
        DEFAULT_TENANT, rate_id, input_rate, rebate_rate,
        table="product_tax_rates",
    )
    return _product_tax_out(row)


@app.delete("/api/v1/product-tax-rates/{rate_id}")
async def delete_product_tax_rate(
    rate_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    await _team_id(request, user, write=True)
    await _product_tax_or_404(request, user, rate_id)
    await db.execute(
        request,
        "UPDATE product_tax_rates SET status='inactive', updated_at=now()"
        " WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, rate_id,
    )
    return {"id": rate_id, "status": "inactive"}
