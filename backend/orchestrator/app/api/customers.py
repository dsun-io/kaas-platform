"""客户工位 API（WORKSTATION_DESIGN.md §10.1 / §10.3）

端点：
- GET    /api/v1/customers                 客户列表（分页 + 阶段/搜索过滤 + 可见范围）
- POST   /api/v1/customers                 新建客户
- GET    /api/v1/customers/{id}            客户详情（联系人 + 询盘 + 阶段日志）
- PATCH  /api/v1/customers/{id}            更新档案
- POST   /api/v1/customers/{id}/stage      变更阶段（won/lost 触发询盘二次确认流程）
- POST   /api/v1/customers/{id}/contacts   新建联系人
- GET    /api/v1/customers/{id}/inquiries  客户询盘列表（时间倒序）
- POST   /api/v1/customers/{id}/inquiries  新建询盘（lead 客户自动进 inquiry 阶段）
- GET    /api/v1/inquiries                 询盘列表（按客户归类，时间倒序，status 筛选）
- PATCH  /api/v1/inquiries/{id}            询盘状态流转（驱动客户 stage，§10.1）

联动规则（§10.1）：
- 询盘 open→won：询盘置 won，客户 stage 自动置 won，写 cust_stage_log
- 询盘 open→lost：仅关闭该询盘，客户 stage 不变
- 客户手动改 won/lost：若名下有 open 询盘，返回 409 + 询盘清单，
  前端二次确认后带 close_inquiry_ids / close_all_open 重试
"""
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import Customer
from app.db.workstation_models import (
    CustContact, CustInquiry, CustStageLog,
)
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import (
    validate_enum, CUSTOMER_STAGE, INQUIRY_STATUS, INQUIRY_CHANNEL,
)

router = APIRouter(prefix="/api/v1", tags=["customers"])

DEFAULT_TENANT = "default"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _tenant_id(auth: AuthContext) -> str:
    return auth.tenant_id or DEFAULT_TENANT


def _can_see_all(auth: AuthContext) -> bool:
    """system_admin 看全部；企业管理员（Phase 6）同样看全部。"""
    return auth.is_admin()


def _scope_filter(stmt, model, auth: AuthContext):
    """§10.3 可见范围：自己账号的数据 + owner 开放给全体的 tenant 基础数据。"""
    if _can_see_all(auth):
        return stmt
    return stmt.where(or_(
        model.owner_id == str(auth.user_id),
        model.owner_scope == 'tenant',
    ))


def _check_write_access(row, auth: AuthContext):
    """写规则：成员只能改 owner_id=自己的数据；admin 全可改。"""
    if _can_see_all(auth):
        return
    if row.owner_id is not None and row.owner_id != str(auth.user_id):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_OWNER",
            "detail": "只能修改自己账号的数据",
        })


def _row_to_customer(c: Customer) -> dict:
    return {
        "id": c.id, "company_name": c.name, "country": c.country,
        "address": c.address, "default_port": c.default_port,
        "credit_level": c.credit_level, "stage": c.stage, "notes": c.notes,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def _row_to_inquiry(i: CustInquiry) -> dict:
    return {
        "id": i.id, "customer_id": i.customer_id, "lead_id": i.lead_id,
        "channel": i.channel,
        "category_id": i.category_id, "product_name_raw": i.product_name_raw,
        "quantity": float(i.quantity) if i.quantity is not None else None,
        "quantity_unit": i.quantity_unit, "application": i.application,
        "status": i.status,
        "created_at": i.created_at.isoformat() if i.created_at else None,
    }


async def _log_stage(db, tenant_id, customer_id, from_stage, to_stage, changed_by, reason):
    db.add(CustStageLog(
        tenant_id=tenant_id, customer_id=customer_id,
        from_stage=from_stage, to_stage=to_stage,
        changed_by=changed_by, reason=reason,
    ))


async def _get_customer_or_404(db, tenant_id, customer_id, auth) -> Customer:
    stmt = select(Customer).where(
        Customer.tenant_id == tenant_id, Customer.id == customer_id,
    )
    stmt = _scope_filter(stmt, Customer, auth)
    c = (await db.execute(stmt)).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "CUSTOMER_NOT_FOUND"})
    return c


# ── Schemas ──────────────────────────────────────────────────────────────────

class CustomerCreate(BaseModel):
    company_name: str
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    stage: Optional[str] = "lead"
    notes: Optional[str] = None
    owner_scope: Optional[str] = None  # private | tenant（§10.3）


class CustomerUpdate(BaseModel):
    company_name: Optional[str] = None
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: Optional[str] = None


class StageChange(BaseModel):
    stage: str
    reason: Optional[str] = None
    close_inquiry_ids: Optional[List[int]] = None  # 二次确认：勾选关闭的询盘
    close_all_open: bool = False                    # 二次确认：全部一并关闭


class ContactCreate(BaseModel):
    name: str
    position: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    whatsapp: Optional[str] = None
    wechat: Optional[str] = None
    is_primary: bool = False


class InquiryCreate(BaseModel):
    channel: Optional[str] = None
    lead_id: Optional[int] = None      # 线索池转化来源（§7.1）
    category_id: Optional[int] = None
    product_name_raw: Optional[str] = None
    quantity: Optional[float] = None
    quantity_unit: Optional[str] = None
    application: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: Optional[str] = None


class InquiryUpdate(BaseModel):
    status: Optional[str] = None
    channel: Optional[str] = None
    product_name_raw: Optional[str] = None
    quantity: Optional[float] = None
    quantity_unit: Optional[str] = None
    application: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: Optional[str] = None


# ── 客户 CRUD ────────────────────────────────────────────────────────────────

@router.get("/customers")
async def list_customers(
    q: Optional[str] = None,
    stage: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    stmt = select(Customer).where(Customer.tenant_id == tenant_id)
    stmt = _scope_filter(stmt, Customer, auth)
    if q:
        stmt = stmt.where(Customer.name.ilike(f"%{q}%"))
    if stage:
        validate_enum("customer_stage", stage)
        stmt = stmt.where(Customer.stage == stage)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = stmt.order_by(Customer.updated_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_customer(c) for c in rows], "total": total,
            "page": page, "page_size": page_size}


@router.post("/customers", status_code=201)
async def create_customer(
    body: CustomerCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    stage = validate_enum("customer_stage", body.stage or "lead")
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"
    c = Customer(
        tenant_id=tenant_id, name=body.company_name,
        country=body.country, address=body.address,
        default_port=body.default_port, credit_level=body.credit_level,
        stage=stage, notes=body.notes,
        created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
    )
    db.add(c)
    await db.flush()
    await _log_stage(db, tenant_id, c.id, None, stage, str(auth.user_id), "新建客户")
    await db.commit()
    return _row_to_customer(c)


@router.get("/customers/{customer_id}")
async def get_customer(
    customer_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    c = await _get_customer_or_404(db, tenant_id, customer_id, auth)

    contacts = (await db.execute(
        select(CustContact).where(
            CustContact.tenant_id == tenant_id,
            CustContact.customer_id == customer_id,
        ).order_by(CustContact.is_primary.desc(), CustContact.id)
    )).scalars().all()

    inquiries = (await db.execute(
        select(CustInquiry).where(
            CustInquiry.tenant_id == tenant_id,
            CustInquiry.customer_id == customer_id,
        ).order_by(CustInquiry.created_at.desc())
    )).scalars().all()

    stage_log = (await db.execute(
        select(CustStageLog).where(
            CustStageLog.tenant_id == tenant_id,
            CustStageLog.customer_id == customer_id,
        ).order_by(CustStageLog.created_at.desc()).limit(50)
    )).scalars().all()

    return {
        **_row_to_customer(c),
        "contacts": [{
            "id": ct.id, "name": ct.name, "position": ct.position,
            "phone": ct.phone, "email": ct.email, "whatsapp": ct.whatsapp,
            "is_primary": ct.is_primary,
        } for ct in contacts],
        "inquiries": [_row_to_inquiry(i) for i in inquiries],
        "stage_log": [{
            "id": s.id, "from_stage": s.from_stage, "to_stage": s.to_stage,
            "reason": s.reason,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        } for s in stage_log],
    }


@router.patch("/customers/{customer_id}")
async def update_customer(
    customer_id: int,
    body: CustomerUpdate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    c = await _get_customer_or_404(db, tenant_id, customer_id, auth)
    _check_write_access(c, auth)

    data = body.model_dump(exclude_unset=True)
    if "owner_scope" in data:
        validate_enum("owner_scope", data["owner_scope"])
    for k, v in data.items():
        setattr(c, k, v)
    await db.commit()
    await db.refresh(c)  # server-onupdate 列（updated_at）commit 后已 expired
    return _row_to_customer(c)


# ── 阶段变更（§10.1 二次确认）───────────────────────────────────────────────

@router.post("/customers/{customer_id}/stage")
async def change_stage(
    customer_id: int,
    body: StageChange,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    target = validate_enum("customer_stage", body.stage)
    c = await _get_customer_or_404(db, tenant_id, customer_id, auth)
    _check_write_access(c, auth)

    # 查名下 open 询盘
    open_inquiries = (await db.execute(
        select(CustInquiry).where(
            CustInquiry.tenant_id == tenant_id,
            CustInquiry.customer_id == customer_id,
            CustInquiry.status == 'open',
        )
    )).scalars().all()

    closing: List[CustInquiry] = []
    if target in ("won", "lost") and open_inquiries:
        if body.close_all_open:
            closing = list(open_inquiries)
        elif body.close_inquiry_ids:
            wanted = set(body.close_inquiry_ids)
            closing = [i for i in open_inquiries if i.id in wanted]
            if len(closing) != len(body.close_inquiry_ids):
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "OPEN_INQUIRIES_EXIST",
                    "detail": "存在不属于该客户的询盘",
                    "open_inquiries": [_row_to_inquiry(i) for i in open_inquiries],
                })
        else:
            # 首次请求：返回 409 + 询盘清单，前端弹窗二次确认后重试
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "OPEN_INQUIRIES_EXIST",
                "detail": f"客户名下有 {len(open_inquiries)} 条开启中的询盘，请确认是否一并关闭",
                "open_inquiries": [_row_to_inquiry(i) for i in open_inquiries],
            })

    from_stage = c.stage
    c.stage = target
    await _log_stage(db, tenant_id, customer_id, from_stage, target,
                     str(auth.user_id), body.reason)

    # 批量关闭询盘（与客户 stage 同步变更）
    for inq in closing:
        inq.status = target  # won | lost
        if inq.lead_id is not None:
            from app.jobs.lead_scan import sync_inquiry_status
            await sync_inquiry_status(db, tenant_id, inq)
        await _log_stage(db, tenant_id, customer_id, from_stage, target,
                         str(auth.user_id),
                         f"客户阶段变更联动关闭 inquiry#{inq.id}" + (f"：{body.reason}" if body.reason else ""))

    # 先提交再显式 refresh 后构造响应：UPDATE 后 updated_at 等 server-onupdate
    # 列会被标记 expired，commit 后直接读会在异步会话内惰性加载抛 MissingGreenlet
    await db.commit()
    await db.refresh(c)
    return {**_row_to_customer(c), "closed_inquiries": [i.id for i in closing]}


# ── 联系人 ───────────────────────────────────────────────────────────────────

@router.post("/customers/{customer_id}/contacts", status_code=201)
async def create_contact(
    customer_id: int,
    body: ContactCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    await _get_customer_or_404(db, tenant_id, customer_id, auth)
    ct = CustContact(
        tenant_id=tenant_id, customer_id=customer_id, name=body.name,
        position=body.position, phone=body.phone, email=body.email,
        whatsapp=body.whatsapp, wechat=body.wechat, is_primary=body.is_primary,
    )
    db.add(ct)
    if body.is_primary:
        # 一个客户只保留一个主联系人
        await db.execute(
            update(CustContact)
            .where(
                CustContact.tenant_id == tenant_id,
                CustContact.customer_id == customer_id,
                CustContact.is_primary == True,  # noqa: E712
            )
            .values(is_primary=False)
        )
    await db.commit()
    return {"id": ct.id, "name": ct.name, "position": ct.position,
            "phone": ct.phone, "email": ct.email, "whatsapp": ct.whatsapp,
            "is_primary": ct.is_primary}


# ── 询盘 ─────────────────────────────────────────────────────────────────────

@router.get("/customers/{customer_id}/inquiries")
async def list_customer_inquiries(
    customer_id: int,
    status: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    await _get_customer_or_404(db, tenant_id, customer_id, auth)
    stmt = select(CustInquiry).where(
        CustInquiry.tenant_id == tenant_id,
        CustInquiry.customer_id == customer_id,
    )
    if status:
        validate_enum("inquiry_status", status)
        stmt = stmt.where(CustInquiry.status == status)
    stmt = stmt.order_by(CustInquiry.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_inquiry(i) for i in rows], "total": len(rows)}


@router.post("/customers/{customer_id}/inquiries", status_code=201)
async def create_inquiry(
    customer_id: int,
    body: InquiryCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    c = await _get_customer_or_404(db, tenant_id, customer_id, auth)
    _check_write_access(c, auth)

    channel = validate_enum("inquiry_channel", body.channel)
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"
    inq = CustInquiry(
        tenant_id=tenant_id, customer_id=customer_id, channel=channel,
        lead_id=body.lead_id,
        category_id=body.category_id, product_name_raw=body.product_name_raw,
        quantity=body.quantity, quantity_unit=body.quantity_unit,
        application=body.application, notes=body.notes,
        status='open', created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
    )
    db.add(inq)

    # 询盘驱动客户（§10.1）：lead 客户进 inquiry 阶段
    if c.stage == 'lead':
        await _log_stage(db, tenant_id, customer_id, 'lead', 'inquiry',
                         str(auth.user_id), f"新建询盘 inquiry 联动")
        c.stage = 'inquiry'

    await db.commit()
    return _row_to_inquiry(inq)


@router.get("/inquiries")
async def list_inquiries(
    status: Optional[str] = None,
    customer_id: Optional[int] = None,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """询盘列表：按客户归类、时间倒序（§10.1 列表规则）。"""
    tenant_id = _tenant_id(auth)
    stmt = select(CustInquiry, Customer.name).join(
        Customer, CustInquiry.customer_id == Customer.id,
    ).where(CustInquiry.tenant_id == tenant_id)
    stmt = _scope_filter(stmt, CustInquiry, auth)
    if status:
        validate_enum("inquiry_status", status)
        stmt = stmt.where(CustInquiry.status == status)
    if customer_id:
        stmt = stmt.where(CustInquiry.customer_id == customer_id)
    stmt = stmt.order_by(CustInquiry.customer_id, CustInquiry.created_at.desc())
    rows = (await db.execute(stmt)).all()
    return {"items": [{**_row_to_inquiry(i), "company_name": name} for i, name in rows],
            "total": len(rows)}


@router.patch("/inquiries/{inquiry_id}")
async def update_inquiry(
    inquiry_id: int,
    body: InquiryUpdate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """询盘状态流转，驱动客户 stage（§10.1）。"""
    tenant_id = _tenant_id(auth)
    stmt = select(CustInquiry).where(
        CustInquiry.tenant_id == tenant_id, CustInquiry.id == inquiry_id,
    )
    stmt = _scope_filter(stmt, CustInquiry, auth)
    inq = (await db.execute(stmt)).scalar_one_or_none()
    if inq is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "INQUIRY_NOT_FOUND"})
    _check_write_access(inq, auth)

    data = body.model_dump(exclude_unset=True)
    new_status = data.pop("status", None)
    if new_status is not None:
        validate_enum("inquiry_status", new_status)
        # 合法流转校验
        allowed_flows = {
            'open': ('quoted', 'won', 'lost'),
            'quoted': ('won', 'lost'),
            'won': (), 'lost': (),
        }
        if new_status != inq.status and new_status not in allowed_flows.get(inq.status, ()):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ILLEGAL_TRANSITION",
                "detail": f"询盘状态不允许从 {inq.status} 流转到 {new_status}",
            })
        old_status = inq.status
        inq.status = new_status

        # 联动客户 stage（§10.1）
        if old_status != new_status:
            c_stmt = select(Customer).where(
                Customer.tenant_id == tenant_id,
                Customer.id == inq.customer_id,
            )
            c = (await db.execute(c_stmt)).scalar_one_or_none()
            if c is not None:
                if new_status == 'won':
                    # open→won：客户 stage 自动置 won
                    if c.stage != 'won':
                        await _log_stage(db, tenant_id, c.id, c.stage, 'won',
                                         str(auth.user_id), f"inquiry#{inq.id} won 联动")
                        c.stage = 'won'
                elif new_status == 'quoted':
                    # open→quoted：客户 stage 至少到 quoted（不降级 won/lost）
                    if c.stage in ('lead', 'inquiry'):
                        await _log_stage(db, tenant_id, c.id, c.stage, 'quoted',
                                         str(auth.user_id), f"inquiry#{inq.id} quoted 联动")
                        c.stage = 'quoted'
                # new_status == 'lost'：客户 stage 不变（§10.1）

            # P5 状态同步：回写线索池 lead_candidates.inquiry_status（§7.2）
            if inq.lead_id is not None:
                from app.jobs.lead_scan import sync_inquiry_status
                await sync_inquiry_status(db, tenant_id, inq)

    if "channel" in data:
        validate_enum("inquiry_channel", data["channel"])
    if "owner_scope" in data:
        validate_enum("owner_scope", data["owner_scope"])
    for k, v in data.items():
        setattr(inq, k, v)

    await db.commit()
    return _row_to_inquiry(inq)
