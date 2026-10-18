"""税务档案 CRUD（TAX-02）

用户口径（2026-10-18 TAX-00）：
  · 团队级档案；团队管理员写、成员读；
  · 字段：进项票税点 / 销项税率 / 出口退税率 / 杂税（印花税含在杂税里）；
  · 档案只负责“填表”，不参与后端算价；
  · 停用 = 软删，历史报价单靠 `tax_snapshot` 复现。

设计要点：
  · `tax_values` 是 JSONB，写入按白名单校验，未知键 422（不静默丢）；
  · 税率用 0–1，前端百分比在提交前 /100；
  · `name` / `code` 团队内唯一，`code` 不填自动生成；
  · 生效日期只展示/排序，不做报价日期门禁。
"""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth_context
from app.db.session import get_db_session
from app.db.models import Team
from app.db.tax_models import TaxArchive

router = APIRouter(prefix="/api/v1", tags=["tax-archives"])

# 新档案只认这四项；印花税已含在 misc_fee_rate，不单列
TAX_KEYS = ("input_vat_rate", "output_vat_rate", "rebate_rate", "misc_fee_rate")


class TaxValuesIn(BaseModel):
    input_vat_rate: Optional[float] = None
    output_vat_rate: Optional[float] = None
    rebate_rate: Optional[float] = None
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


def _parse_date(value: Optional[str]) -> Optional[date]:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_DATE",
            "detail": f"日期格式不合法：{value}（应为 YYYY-MM-DD）",
        })


def _clean_tax_values(raw: Optional[TaxValuesIn]) -> dict:
    if raw is None:
        return {}
    values: dict = {}
    for key in TAX_KEYS:
        value = getattr(raw, key)
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


def _row_out(a: TaxArchive) -> dict:
    return {
        "id": a.id,
        "code": a.code,
        "name": a.name,
        "effective_from": a.effective_from.isoformat() if a.effective_from else None,
        "effective_to": a.effective_to.isoformat() if a.effective_to else None,
        "tax_values": a.tax_values or {},
        "source": a.source,
        "status": a.status,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


async def _require_team_admin(db: AsyncSession, auth: AuthContext) -> int:
    """团队管理员或平台管理员；返回写作用到的 team_id。"""
    from kaas_common.workstation.scope import is_admin_role
    from kaas_common.workstation.teams import is_team_admin

    if auth.team_id is None:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_REQUIRED",
            "detail": "税务档案是团队级资源，当前账号没有团队",
        })
    if not is_admin_role(auth.role):
        created_by = (await db.execute(
            select(Team.created_by).where(Team.id == auth.team_id)
        )).scalar_one_or_none()
        if not is_team_admin(created_by, auth.user_id, auth.role):
            raise HTTPException(status_code=403, detail={
                "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
                "detail": "仅团队管理员可修改税务档案",
            })
    return auth.team_id


def _scope(stmt, auth: AuthContext):
    tenant_id = auth.tenant_id or "default"
    stmt = stmt.where(TaxArchive.tenant_id == tenant_id)
    if auth.team_id is not None:
        stmt = stmt.where(TaxArchive.team_id == auth.team_id)
    return stmt


async def _archive_or_404(db, auth: AuthContext, archive_id: int) -> TaxArchive:
    row = (await db.execute(
        _scope(select(TaxArchive).where(TaxArchive.id == archive_id), auth)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TAX_ARCHIVE_NOT_FOUND",
        })
    return row


async def _check_unique(db, auth, team_id: int, name: Optional[str],
                        code: Optional[str], exclude_id: Optional[int] = None):
    tenant_id = auth.tenant_id or "default"
    for column, value, label, code_name in (
        (TaxArchive.name, name, "名称", "NAME_TAKEN"),
        (TaxArchive.code, code, "编码", "CODE_TAKEN"),
    ):
        if value in (None, ""):
            continue
        stmt = select(TaxArchive.id).where(
            TaxArchive.tenant_id == tenant_id,
            TaxArchive.team_id == team_id,
            column == value,
        )
        if exclude_id is not None:
            stmt = stmt.where(TaxArchive.id != exclude_id)
        if (await db.execute(stmt.limit(1))).scalar_one_or_none() is not None:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": code_name,
                "detail": f"税务档案{label}「{value}」在本团队已存在",
            })


async def _next_code(db, auth, team_id: int) -> str:
    tenant_id = auth.tenant_id or "default"
    base = f"TAX-{datetime.now().strftime('%Y%m%d')}"
    for i in range(1, 100):
        candidate = f"{base}-{i}"
        exists = (await db.execute(
            select(TaxArchive.id).where(
                TaxArchive.tenant_id == tenant_id,
                TaxArchive.team_id == team_id,
                TaxArchive.code == candidate,
            ).limit(1)
        )).scalar_one_or_none()
        if exists is None:
            return candidate
    raise HTTPException(status_code=409, detail={
        "error": "conflict", "code": "CODE_GENERATION_FAILED",
        "detail": "自动生成档案编码失败，请手动填写编码",
    })


@router.get("/tax-archives")
async def list_tax_archives(
    include_inactive: bool = Query(False),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    from kaas_common.workstation.scope import is_admin_role
    stmt = select(TaxArchive)
    stmt = _scope(stmt, auth)
    if not include_inactive or not is_admin_role(auth.role):
        stmt = stmt.where(TaxArchive.status == "active")
    stmt = stmt.order_by(
        TaxArchive.effective_from.desc().nulls_last(),
        TaxArchive.updated_at.desc(),
    )
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_out(a) for a in rows], "total": len(rows)}


@router.post("/tax-archives", status_code=201)
async def create_tax_archive(
    body: TaxArchiveCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    team_id = await _require_team_admin(db, auth)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NAME_REQUIRED", "detail": "档案名称不能为空",
        })
    values = _clean_tax_values(body.tax_values)
    code = (body.code or "").strip() or await _next_code(db, auth, team_id)
    await _check_unique(db, auth, team_id, name, code)
    archive = TaxArchive(
        tenant_id=auth.tenant_id or "default", team_id=team_id,
        code=code, name=name,
        effective_from=_parse_date(body.effective_from),
        effective_to=_parse_date(body.effective_to),
        tax_values=values, source=body.source,
        status="active", created_by=str(auth.user_id),
    )
    db.add(archive)
    await db.commit()
    await db.refresh(archive)
    return _row_out(archive)


@router.patch("/tax-archives/{archive_id}")
async def update_tax_archive(
    archive_id: int,
    body: TaxArchivePatch,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    team_id = await _require_team_admin(db, auth)
    archive = await _archive_or_404(db, auth, archive_id)
    if archive.team_id != team_id:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "不能修改其他团队的税务档案",
        })
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "NAME_REQUIRED", "detail": "档案名称不能为空",
            })
        archive.name = name
    if body.code is not None:
        archive.code = body.code.strip() or None
    if body.effective_from is not None:
        archive.effective_from = _parse_date(body.effective_from)
    if body.effective_to is not None:
        archive.effective_to = _parse_date(body.effective_to)
    if body.tax_values is not None:
        archive.tax_values = _clean_tax_values(body.tax_values)
    if body.source is not None:
        archive.source = body.source
    if body.status is not None:
        if body.status not in ("active", "inactive"):
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "INVALID_STATUS",
                "detail": "status 只能是 active / inactive",
            })
        archive.status = body.status
    await _check_unique(db, auth, team_id, archive.name, archive.code, exclude_id=archive.id)
    await db.commit()
    await db.refresh(archive)
    return _row_out(archive)


@router.delete("/tax-archives/{archive_id}")
async def delete_tax_archive(
    archive_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    team_id = await _require_team_admin(db, auth)
    archive = await _archive_or_404(db, auth, archive_id)
    if archive.team_id != team_id:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "不能停用其他团队的税务档案",
        })
    archive.status = "inactive"
    await db.commit()
    return {"id": archive.id, "status": archive.status}
