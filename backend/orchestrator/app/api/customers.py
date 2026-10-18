"""客户工位 API（WORKSTATION_DESIGN.md §10.1 / §10.3）

端点：
- GET    /api/v1/customers                 客户列表（分页 + 阶段/搜索过滤 + 可见范围）
- POST   /api/v1/customers                 新建客户
- GET    /api/v1/customers/{id}            客户详情（联系人 + 询盘 + 阶段日志）
- PATCH  /api/v1/customers/{id}            更新档案
- PATCH  /api/v1/customers/{id}/stage      变更阶段（won/lost 触发询盘二次确认流程）
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
from typing import Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, or_, exists
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import Customer
from app.db.workstation_links import Order
from app.db.workstation_models import (
    CustContact, CustInquiry, CustStageLog,
)
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import (
    validate_enum, INQUIRY_CHANNEL,
)
from kaas_common.workstation.customer_rules import (
    OPEN_ORDER_STATUSES,
    derive_customer_stage,
    validate_manual_stage,
)
from kaas_common.workstation.inquiry_rules import (
    build_inquiry_no,
    normalize_abbr,
)
from kaas_common.workstation.number_rules import NumberError, normalize_number

router = APIRouter(prefix="/api/v1", tags=["customers"])

DEFAULT_TENANT = "default"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _tenant_id(auth: AuthContext) -> str:
    return auth.tenant_id or DEFAULT_TENANT


def _can_see_all(auth: AuthContext) -> bool:
    """system_admin 看全部；企业管理员（Phase 6）同样看全部。"""
    from kaas_common.workstation.customer_rules import can_see_all
    return can_see_all(auth)


def _scope_filter(stmt, model, auth: AuthContext):
    """§10.3 + 三层组织：可见范围（**与其它工位同一套规则**）。

    可见 ⟺ 管理员 / `owner_scope='tenant'`（显式共享）/ `owner_id=我` /
           **`team_id=我的团队`（本团队）**。

    为什么必须加最后一条：原先这里**没有团队条件**，而单据侧的引用校验
    （`resolve_customer_for_doc` → 内核 `visible_to`）**有**团队条件 —— 于是
    "同事在本团队录入的客户"会出现"客户列表里看不见、开单时却选得到"的裂缝。
    两边都声称是同一套规则，就必须真的同一套。

    注意 `team_id IS NULL` 的行**不因团队规则改变可见性**（仍按前三条判定），
    所以这是**纯增量**条件：没有人会因此突然看不到数据。
    """
    if _can_see_all(auth):
        return stmt
    conds = [
        model.owner_id == str(auth.user_id),
        model.owner_scope == 'tenant',
    ]
    if hasattr(model, "team_id") and getattr(auth, "team_id", None) is not None:
        conds.append(model.team_id == auth.team_id)
    return stmt.where(or_(*conds))


def _check_write_access(row, auth: AuthContext):
    """写规则：成员只能改 owner_id=自己的数据；admin 全可改。"""
    if _can_see_all(auth):
        return
    if row.owner_id is not None and row.owner_id != str(auth.user_id):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_OWNER",
            "detail": "只能修改自己账号的数据",
        })


def _row_to_customer(c: Customer, has_open_order: bool = False) -> dict:
    from kaas_common.workstation.customer_serializers import row_to_customer
    return row_to_customer(
        c, display_stage=derive_customer_stage(c.stage, has_open_order),
    )


async def _open_order_customer_ids(db, tenant_id: str, customer_ids) -> set:
    """批量取「名下有开启中订单」的客户 id（列表/详情的唯一判定入口）。

    口径见 `kaas_common.workstation.customer_rules.OPEN_ORDER_STATUSES`：
    pending / confirmed / producing / shipped 算开启中；completed / cancelled 关闭。
    """
    ids = [cid for cid in customer_ids if cid is not None]
    if not ids:
        return set()
    rows = (await db.execute(
        select(Order.customer_id).where(
            Order.tenant_id == tenant_id,
            Order.customer_id.in_(ids),
            Order.status.in_(OPEN_ORDER_STATUSES),
        ).distinct()
    )).scalars().all()
    return {int(x) for x in rows if x is not None}


async def _has_open_order(db, tenant_id: str, customer_id: int) -> bool:
    return bool(await _open_order_customer_ids(db, tenant_id, [customer_id]))


def _row_to_inquiry(i: CustInquiry) -> dict:
    from kaas_common.workstation.customer_serializers import row_to_inquiry
    return row_to_inquiry(i)


async def _inquiry_has_quote(db, tenant_id: str, inquiry_id: int) -> bool:
    """询盘是否已被某张报价单引用（有 ⇒ 编号锁定，不能再改）。"""
    from app.db.workstation_links import QuoteOrder
    return (await db.execute(
        select(QuoteOrder.id).where(
            QuoteOrder.tenant_id == tenant_id,
            QuoteOrder.inquiry_id == inquiry_id,
        ).limit(1)
    )).scalar_one_or_none() is not None


def _parse_abbr(raw: Optional[str]) -> Optional[str]:
    """客户缩写：空 → None；非空但不合法（2-6 位字母数字）→ 422。"""
    if raw is None or str(raw).strip() == "":
        return None
    value = normalize_abbr(raw)
    if value is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_CUSTOMER_ABBR",
            "detail": "客户缩写需为 2-6 位字母/数字（用于询盘编号）",
        })
    return value


async def _next_inquiry_no(db, tenant_id: str, customer: Customer) -> str:
    """生成唯一询盘编号 `国家ISO2-客户缩写-yyyyMMddHHmmss`（同秒冲突加后缀）。"""
    for suffix in range(1, 21):
        candidate = build_inquiry_no(
            customer.country, customer.abbr,
            customer_name=customer.name, customer_id=customer.id,
            suffix=suffix,
        )
        exists = (await db.execute(
            select(CustInquiry.id).where(
                CustInquiry.tenant_id == tenant_id,
                CustInquiry.inquiry_no == candidate,
            ).limit(1)
        )).scalar_one_or_none()
        if exists is None:
            return candidate
    # 极端情况下 20 次同秒冲突：用微秒兜底，仍由唯一索引兜底
    return build_inquiry_no(
        customer.country, customer.abbr,
        customer_name=customer.name, customer_id=customer.id,
    ) + f"-{datetime.now(timezone.utc).strftime('%f')}"


async def _log_stage(db, tenant_id, customer_id, from_stage, to_stage, changed_by, reason):
    db.add(CustStageLog(
        tenant_id=tenant_id, customer_id=customer_id,
        from_stage=from_stage, to_stage=to_stage,
        changed_by=changed_by, reason=reason,
    ))


async def _get_customer_or_404(db, tenant_id, customer_id, auth) -> Customer:
    stmt = select(Customer).where(
        Customer.tenant_id == tenant_id, Customer.id == customer_id,
        # 软删除的客户一律视为不存在 —— is_deleted 原先只写不读，
        # 标记了删除却照样能查到（列表/详情/子资源全都还在）
        Customer.is_deleted.is_(False),
    )
    stmt = _scope_filter(stmt, Customer, auth)
    c = (await db.execute(stmt)).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "CUSTOMER_NOT_FOUND"})
    return c


# ── Schemas ──────────────────────────────────────────────────────────────────

class CustomerCreate(BaseModel):
    # 公司名与联系人**至少填一个**（2026-10-17 用户口径，与 Worker 对齐）：
    # 只有个人联系人的客户也要能建。
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[str] = None
    # 客户缩写（询盘编号用）：2-6 位字母/数字；可空
    abbr: Optional[str] = None
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    # 手动客户阶段（活跃 / 沉寂）；缺省活跃。「已下单」由开启中的订单推导，不可手写。
    stage: Optional[str] = "active"
    notes: Optional[str] = None
    owner_scope: Optional[str] = None  # private | tenant（§10.3）


class CustomerUpdate(BaseModel):
    company_name: Optional[str] = None
    abbr: Optional[str] = None
    country: Optional[str] = None
    address: Optional[str] = None
    default_port: Optional[str] = None
    credit_level: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: Optional[str] = None


class StageChange(BaseModel):
    stage: str
    reason: Optional[str] = None


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
    # 编号可改，但仅限「还没生成报价」时；改编号要走二次确认（前端弹窗）
    inquiry_no: Optional[str] = None
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
    stmt = select(Customer).where(
        Customer.tenant_id == tenant_id,
        Customer.is_deleted.is_(False),      # 软删除的客户不再出现在列表里
    )
    stmt = _scope_filter(stmt, Customer, auth)
    if q:
        stmt = stmt.where(Customer.name.ilike(f"%{q}%"))
    if stage:
        validate_enum("customer_stage", stage)
        # 「已下单」是推导值：库里没有这一列，用 EXISTS(开启中的订单) 过滤；
        # active / inactive 是手动列，且必须**没有**开启中的订单（否则展示为已下单）。
        open_cond = exists().where(
            Order.tenant_id == tenant_id,
            Order.customer_id == Customer.id,
            Order.status.in_(OPEN_ORDER_STATUSES),
        )
        if stage == "ordered":
            stmt = stmt.where(open_cond)
        elif stage == "inactive":
            stmt = stmt.where(
                Customer.stage.in_(("inactive", "lost")), ~open_cond,
            )
        else:  # active
            stmt = stmt.where(
                Customer.stage.notin_(("inactive", "lost")), ~open_cond,
            )

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = stmt.order_by(Customer.updated_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    open_ids = await _open_order_customer_ids(db, tenant_id, [c.id for c in rows])
    return {"items": [_row_to_customer(c, c.id in open_ids) for c in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("/customers", status_code=201)
async def create_customer(
    body: CustomerCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    company_name = (body.company_name or "").strip()
    contact_name = (body.contact_name or "").strip()
    if not company_name and not contact_name:
        raise HTTPException(status_code=422, detail={
            "error": "missing_identity",
            "code": "CUSTOMER_IDENTITY_REQUIRED",
            "detail": "公司名称和联系人至少填写一个",
        })
    # 客户阶段只有活跃/沉寂可手写；已下单由订单推导。
    stage = body.stage or "active"
    ok, msg = validate_manual_stage(stage)
    if not ok:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_enum", "code": "INVALID_CUSTOMER_STAGE",
            "detail": msg,
        })
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"
    c = Customer(
        tenant_id=tenant_id, name=company_name or contact_name,
        abbr=_parse_abbr(body.abbr),
        country=body.country, address=body.address,
        default_port=body.default_port, credit_level=body.credit_level,
        stage=stage, notes=body.notes,
        created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
        team_id=auth.team_id,
    )
    db.add(c)
    await db.flush()
    if contact_name:
        # 只有联系人时用联系人名做展示名，并落一条主联系人（与 Worker 同口径）
        db.add(CustContact(
            tenant_id=tenant_id, customer_id=c.id, name=contact_name,
            phone=(body.contact_phone or "").strip() or None,
            email=(body.contact_email or "").strip() or None,
            is_primary=True,
        ))
    await _log_stage(db, tenant_id, c.id, None, stage, str(auth.user_id), "新建客户")
    await db.commit()
    await db.refresh(c)
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

    has_open = await _has_open_order(db, tenant_id, customer_id)
    return {
        **_row_to_customer(c, has_open),
        "contacts": [{
            "id": ct.id, "name": ct.name, "position": ct.position,
            "phone": ct.phone, "email": ct.email, "whatsapp": ct.whatsapp,
            "is_primary": ct.is_primary,
        } for ct in contacts],
        "inquiries": [
            {**_row_to_inquiry(i),
             "inquiry_no_editable": not await _inquiry_has_quote(db, tenant_id, i.id)}
            for i in inquiries
        ],
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
    if "abbr" in data:
        data["abbr"] = _parse_abbr(data["abbr"])
    for k, v in data.items():
        # `company_name` 在库里叫 `name`（CustomerCreate 也是显式映射的）。
        # 直接 setattr(c, "company_name", v) 只会挂一个**未映射的实例属性**，
        # 不产生任何 UPDATE 列 —— 表现是「改名返回 200、刷新后还是旧名」。
        setattr(c, "name" if k == "company_name" else k, v)
    await db.commit()
    await db.refresh(c)  # server-onupdate 列（updated_at）commit 后已 expired
    return _row_to_customer(c, await _has_open_order(db, tenant_id, customer_id))


# ── 阶段变更（客户手动状态：活跃 / 沉寂）────────────────────────────────────

@router.delete("/customers/{customer_id}", status_code=204)
async def soft_delete_customer(
    customer_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """客户软删除：标记 is_deleted，保留历史单据引用不物理删除。

    有**开启中的订单**时拒绝删除（409）：否则订单还在跑、客户却从列表消失，
    后续对账/发货会找不到客户。用户 2026-10-18 确认此口径。
    """
    tenant_id = _tenant_id(auth)
    c = await _get_customer_or_404(db, tenant_id, customer_id, auth)
    _check_write_access(c, auth)
    open_orders = (await db.execute(
        select(Order.id, Order.order_no, Order.status).where(
            Order.tenant_id == tenant_id,
            Order.customer_id == customer_id,
            Order.status.in_(OPEN_ORDER_STATUSES),
        ).order_by(Order.id)
    )).all()
    if open_orders:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "OPEN_ORDERS_EXIST",
            "detail": f"客户名下有 {len(open_orders)} 张开启中的订单，请先关闭订单再删除",
            "open_orders": [
                {"id": row.id, "order_no": row.order_no, "status": row.status}
                for row in open_orders
            ],
        })
    from datetime import datetime, timezone
    c.is_deleted = True
    c.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return None


@router.patch("/customers/{customer_id}/stage")
async def change_stage(
    customer_id: int,
    body: StageChange,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """手动切换客户阶段（活跃 / 沉寂）。

    客户阶段与订单/询盘阶段是两层：这里**不再**联动关闭询盘，也不再接受
    lead/inquiry/quoted/won/lost；「已下单」由开启中的订单推导，不许手写。
    """
    tenant_id = _tenant_id(auth)
    target = body.stage
    ok, msg = validate_manual_stage(target)
    if not ok:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_enum", "code": "INVALID_CUSTOMER_STAGE",
            "detail": msg,
        })
    c = await _get_customer_or_404(db, tenant_id, customer_id, auth)
    _check_write_access(c, auth)

    from_stage = c.stage
    c.stage = target
    await _log_stage(db, tenant_id, customer_id, from_stage, target,
                     str(auth.user_id), body.reason)

    # 先提交再显式 refresh 后构造响应：UPDATE 后 updated_at 等 server-onupdate
    # 列会被标记 expired，commit 后直接读会在异步会话内惰性加载抛 MissingGreenlet
    await db.commit()
    await db.refresh(c)
    return {
        **_row_to_customer(c, await _has_open_order(db, tenant_id, customer_id)),
        "closed_inquiries": [],
    }


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


class ContactUpdate(BaseModel):
    name: Optional[str] = None
    position: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    whatsapp: Optional[str] = None
    wechat: Optional[str] = None
    is_primary: Optional[bool] = None


@router.patch("/customers/{customer_id}/contacts/{contact_id}")
async def update_contact(
    customer_id: int,
    contact_id: int,
    body: ContactUpdate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    await _get_customer_or_404(db, tenant_id, customer_id, auth)
    ct = (await db.execute(
        select(CustContact).where(
            CustContact.tenant_id == tenant_id,
            CustContact.customer_id == customer_id,
            CustContact.id == contact_id,
        )
    )).scalar_one_or_none()
    if ct is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "CONTACT_NOT_FOUND"})
    data = body.model_dump(exclude_unset=True)
    if data.get("is_primary"):
        await db.execute(
            update(CustContact)
            .where(
                CustContact.tenant_id == tenant_id,
                CustContact.customer_id == customer_id,
                CustContact.is_primary == True,  # noqa: E712
                CustContact.id != contact_id,
            )
            .values(is_primary=False)
        )
    for k, v in data.items():
        setattr(ct, k, v)
    await db.commit()
    await db.refresh(ct)
    return {"id": ct.id, "name": ct.name, "position": ct.position,
            "phone": ct.phone, "email": ct.email, "whatsapp": ct.whatsapp,
            "is_primary": ct.is_primary}


@router.delete("/customers/{customer_id}/contacts/{contact_id}", status_code=204)
async def delete_contact(
    customer_id: int,
    contact_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = _tenant_id(auth)
    await _get_customer_or_404(db, tenant_id, customer_id, auth)
    ct = (await db.execute(
        select(CustContact).where(
            CustContact.tenant_id == tenant_id,
            CustContact.customer_id == customer_id,
            CustContact.id == contact_id,
        )
    )).scalar_one_or_none()
    if ct is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "CONTACT_NOT_FOUND"})
    await db.delete(ct)
    await db.commit()
    return None


# ── 客户名下的单据聚合：已删除（2026-10-11 收口）──────────────────────────────
#
# 原 `GET /api/v1/customers/{customer_id}/documents` —— "报价 / 订单 / 单证 三个
# 平行列表"的旧形状，连同**仅供它使用**的 `_doc_scope_filter` / `_iso` /
# `_float_or_none` 一起删除了。
#
# 为什么删而不是留：业务已确认客户粒度看的是**包含关系树**（报价 → 报价单 /
# 订单 → 单证），端点 `GET /api/v1/customers/{customer_id}/records` 取代了它，
# 见 docs/CUSTOMER_DOCUMENTS_VIEW.md；前端也只按 /records 解析
# （frontend/src/lib/customer/customer-records.ts），旧形状没有任何调用方。
# 留着两套形状迟早漂移成"两个页面显示同一客户的不同单据集合"。
#
# 装配逻辑在共享内核 `kaas_common/workstation/customer_records.py`（两端共用一份）。


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
    inquiry_no = await _next_inquiry_no(db, tenant_id, c)
    inq = CustInquiry(
        tenant_id=tenant_id, customer_id=customer_id, channel=channel,
        inquiry_no=inquiry_no,
        lead_id=body.lead_id,
        category_id=body.category_id, product_name_raw=body.product_name_raw,
        quantity=body.quantity, quantity_unit=body.quantity_unit,
        application=body.application, notes=body.notes,
        status='open', created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
        team_id=auth.team_id,
    )
    db.add(inq)

    # 2026-10-18 口径：询盘/报价/订单是**单据阶段**，不再联动改写客户阶段
    # （客户阶段只有活跃 / 沉寂 / 已下单，且已下单只由「开启中的订单」推导）。

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
    """询盘状态流转（单据阶段）。

    2026-10-18 口径：询盘状态**只影响询盘自身**（以及线索池回写），
    不再联动改写客户阶段 —— 客户阶段与订单阶段是两层。
    """
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
    new_no = data.pop("inquiry_no", None)
    if new_no is not None and new_no != inq.inquiry_no:
        try:
            new_no = normalize_number(new_no)
        except NumberError as exc:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "INVALID_INQUIRY_NO",
                "detail": str(exc),
            })
        # 生成报价之后锁定（用户口径：生成报价单后询盘编号不能改）
        if await _inquiry_has_quote(db, tenant_id, inq.id):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "INQUIRY_NO_LOCKED",
                "detail": "该询盘已生成报价单，编号已锁定；如需改号请先处理关联报价",
            })
        taken = (await db.execute(
            select(CustInquiry.id).where(
                CustInquiry.tenant_id == tenant_id,
                CustInquiry.inquiry_no == new_no,
                CustInquiry.id != inq.id,
            ).limit(1)
        )).scalar_one_or_none()
        if taken is not None:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "INQUIRY_NO_TAKEN",
                "detail": f"询盘编号「{new_no}」已被占用，请换一个",
            })
        inq.inquiry_no = new_no
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

        if old_status != new_status and inq.lead_id is not None:
            # P5 状态同步：回写线索池 lead_candidates.inquiry_status（§7.2）
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
