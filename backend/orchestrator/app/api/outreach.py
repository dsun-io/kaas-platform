"""客户触达工位 API（最终设计 §六；P4）

流程（§6.2）：
    选客户 → 编辑邮件（可 AI 生成，可关）→ 选发件邮箱
      → 生成 outreach_messages → 异步逐封调 Resend
      → Webhook 回写 → 更新 outreach_status

端点：
- GET/POST   /api/v1/outreach/mailboxes            发件邮箱（表支持多行，第一版用 is_default）
- PATCH      /api/v1/outreach/mailboxes/{id}
- POST       /api/v1/outreach/mailboxes/{id}/test  发测试邮件（连通性）
- GET/POST   /api/v1/outreach/campaigns            活动（批量模板）
- POST       /api/v1/outreach/campaigns/{id}/send  生成消息并发送（原子抢占防重复）
- GET        /api/v1/outreach/messages             收件人独立列表（§6.7）
- POST       /api/v1/outreach/messages/{id}/retry  失败人工重发
- POST       /api/v1/outreach/generate             AI 生成邮件（可关，模板兜底）
- ALL        /api/v1/outreach/webhook              Inbound 路由预留，返回 501 未实现

状态机（§6.6）：pending → sending → sent → delivered → opened → replied
                              ↘ failed / bounced（failed 允许人工重发）
发送前原子抢占（§6.5）：UPDATE ... SET status='sending' WHERE status='pending'，
影响行数为 0 即跳过（幂等防重复）。发送节奏/每日限额字段已预留。
"""
import re
from datetime import date, datetime, timezone
from typing import List, Optional

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_models import (
    LeadCandidate, OutreachMailbox, OutreachCampaign, OutreachMessage,
)
from app.core.auth import AuthContext, get_auth_context
from app.services.ai_tasks import run_ai_task
from app.api.ws_common import tenant_id_of, check_write_access
from app.api.subs import require_outreach

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1/outreach", tags=["outreach"])

RESEND_API_URL = "https://api.resend.com/emails"
VAR_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")


# ── 模板渲染（§6.3：变量占位 + 渲染预览，避免变量为空）──────────────────────
def render_template(template: str, variables: dict) -> str:
    def _sub(m: re.Match) -> str:
        return str(variables.get(m.group(1)) or "")
    return VAR_RE.sub(_sub, template)


def _lead_variables(lead: LeadCandidate, mailbox: OutreachMailbox) -> dict:
    return {
        "name": lead.company_name or "",
        "company": lead.company_name or "",
        "city": lead.city or "",
        "country": lead.country or "",
        "region": lead.region or "",
        "opening_line": lead.opening_line or "",
        "sender_name": mailbox.name or "",
    }


# ── Schemas ──────────────────────────────────────────────────────────────────

class MailboxCreate(BaseModel):
    email: str
    name: Optional[str] = None
    api_key: Optional[str] = None       # 空则用环境变量 RESEND_API_KEY
    is_default: bool = False
    daily_limit: Optional[int] = None   # 预留：每日限额


class MailboxPatch(BaseModel):
    name: Optional[str] = None
    api_key: Optional[str] = None       # 传 "" 清除
    is_default: Optional[bool] = None
    daily_limit: Optional[int] = None
    enabled: Optional[bool] = None


class CampaignCreate(BaseModel):
    name: str
    subject_template: str
    body_template: str
    mailbox_id: Optional[int] = None    # 默认取 is_default 邮箱


class CampaignSend(BaseModel):
    lead_ids: List[int]                 # 选客户（从线索池读，§6.1）


class GenerateEmail(BaseModel):
    payload: dict = {}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _mask(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    return "****" if len(key) <= 8 else f"{key[:4]}****{key[-4:]}"


def _row_to_mailbox(m: OutreachMailbox) -> dict:
    return {
        "id": m.id, "email": m.email, "name": m.name, "provider": m.provider,
        "api_key_masked": _mask(m.api_key), "has_own_key": bool(m.api_key),
        "is_default": m.is_default, "daily_limit": m.daily_limit,
        "sent_today": m.sent_today, "last_sent_date": m.last_sent_date.isoformat() if m.last_sent_date else None,
        "enabled": m.enabled,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _row_to_campaign(c: OutreachCampaign) -> dict:
    return {
        "id": c.id, "name": c.name, "subject_template": c.subject_template,
        "body_template": c.body_template, "mailbox_id": c.mailbox_id,
        "status": c.status, "total_count": c.total_count,
        "sent_count": c.sent_count, "failed_count": c.failed_count,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


def _row_to_message(m: OutreachMessage) -> dict:
    return {
        "id": m.id, "campaign_id": m.campaign_id, "lead_id": m.lead_id,
        "to_email": m.to_email, "to_name": m.to_name,
        "subject": m.subject, "status": m.status, "error": m.error,
        "resend_message_id": m.resend_message_id,
        "sent_at": m.sent_at.isoformat() if m.sent_at else None,
        "opened_at": m.opened_at.isoformat() if m.opened_at else None,
        "replied_at": m.replied_at.isoformat() if m.replied_at else None,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


async def _get_mailbox_or_404(db, tenant_id, mailbox_id) -> OutreachMailbox:
    m = (await db.execute(
        select(OutreachMailbox).where(
            OutreachMailbox.tenant_id == tenant_id, OutreachMailbox.id == mailbox_id)
    )).scalar_one_or_none()
    if m is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "MAILBOX_NOT_FOUND"})
    return m


async def _get_campaign_or_404(db, tenant_id, campaign_id) -> OutreachCampaign:
    c = (await db.execute(
        select(OutreachCampaign).where(
            OutreachCampaign.tenant_id == tenant_id, OutreachCampaign.id == campaign_id)
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CAMPAIGN_NOT_FOUND"})
    return c


async def _resolve_api_key(mailbox: OutreachMailbox) -> Optional[str]:
    import os
    return mailbox.api_key or os.environ.get("RESEND_API_KEY")


async def _send_one(db, tenant_id: str, msg: OutreachMessage,
                    mailbox: OutreachMailbox) -> None:
    """经 Resend 发送单封；状态/计数/线索 outreach_status 同事务回写。"""
    api_key = await _resolve_api_key(mailbox)
    if not api_key:
        msg.status = "failed"
        msg.error = "未配置 Resend API Key（邮箱 api_key 或环境变量 RESEND_API_KEY）"
        return

    today = date.today()
    if mailbox.last_sent_date != today:  # 跨日重置每日计数
        mailbox.sent_today = 0
        mailbox.last_sent_date = today
    if mailbox.daily_limit is not None and mailbox.sent_today >= mailbox.daily_limit:
        msg.status = "failed"
        msg.error = f"超出每日限额 {mailbox.daily_limit}"
        return

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                RESEND_API_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "from": f"{mailbox.name or mailbox.email} <{mailbox.email}>",
                    "to": [msg.to_email],
                    "subject": msg.subject,
                    "text": msg.body_rendered,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        msg.status = "sent"
        msg.resend_message_id = data.get("id")
        msg.sent_at = datetime.now(timezone.utc)
        msg.error = None
        mailbox.sent_today += 1
        if msg.lead_id:
            await db.execute(
                update(LeadCandidate)
                .where(LeadCandidate.tenant_id == tenant_id,
                       LeadCandidate.id == msg.lead_id)
                .values(outreach_status="sent")
            )
    except Exception as e:
        msg.status = "failed"
        msg.error = str(e)[:500]
        logger.warning("outreach_send_failed", message_id=msg.id, error=str(e))


# ── 发件邮箱 ─────────────────────────────────────────────────────────────────

@router.get("/mailboxes")
async def list_mailboxes(
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    rows = (await db.execute(
        select(OutreachMailbox).where(OutreachMailbox.tenant_id == tenant_id)
        .order_by(OutreachMailbox.is_default.desc(), OutreachMailbox.created_at)
    )).scalars().all()
    return {"items": [_row_to_mailbox(m) for m in rows], "total": len(rows)}


@router.post("/mailboxes", status_code=201)
async def create_mailbox(
    body: MailboxCreate,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    existing = (await db.execute(
        select(OutreachMailbox).where(
            OutreachMailbox.tenant_id == tenant_id, OutreachMailbox.email == body.email)
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "DUPLICATE_MAILBOX",
            "detail": f"邮箱已存在（mailbox#{existing.id}）"})
    if body.is_default:  # 一个租户一个默认邮箱（先清旧默认再插新行，避免 autoflush 新行被一起刷掉）
        await db.execute(
            update(OutreachMailbox)
            .where(OutreachMailbox.tenant_id == tenant_id,
                   OutreachMailbox.is_default == True)  # noqa: E712
            .values(is_default=False)
        )
    m = OutreachMailbox(
        tenant_id=tenant_id, email=body.email, name=body.name,
        api_key=body.api_key, is_default=body.is_default,
        daily_limit=body.daily_limit,
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return _row_to_mailbox(m)


@router.patch("/mailboxes/{mailbox_id}")
async def update_mailbox(
    mailbox_id: int,
    body: MailboxPatch,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    m = await _get_mailbox_or_404(db, tenant_id, mailbox_id)
    if body.name is not None:
        m.name = body.name
    if body.api_key is not None:
        m.api_key = body.api_key or None
    if body.daily_limit is not None:
        m.daily_limit = body.daily_limit
    if body.enabled is not None:
        m.enabled = body.enabled
    if body.is_default:
        await db.execute(
            update(OutreachMailbox)
            .where(OutreachMailbox.tenant_id == tenant_id,
                   OutreachMailbox.is_default == True,  # noqa: E712
                   OutreachMailbox.id != m.id)
            .values(is_default=False)
        )
        m.is_default = True
    await db.commit()
    await db.refresh(m)
    return _row_to_mailbox(m)


@router.post("/mailboxes/{mailbox_id}/test")
async def test_mailbox(
    mailbox_id: int,
    to: str,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    """连通性测试：真实发送一封测试邮件。"""
    tenant_id = tenant_id_of(auth)
    m = await _get_mailbox_or_404(db, tenant_id, mailbox_id)
    api_key = await _resolve_api_key(m)
    if not api_key:
        raise HTTPException(status_code=400, detail={
            "error": "bad_request", "code": "NO_API_KEY",
            "detail": "未配置 Resend API Key"})
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                RESEND_API_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "from": f"{m.name or m.email} <{m.email}>",
                    "to": [to],
                    "subject": "[KaaS] Mailbox test",
                    "text": f"This is a connectivity test from KaaS outreach workstation.\nMailbox: {m.email}\nTime: {datetime.now(timezone.utc).isoformat()}",
                },
            )
            resp.raise_for_status()
            return {"ok": True, "resend_message_id": resp.json().get("id")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:500]}


# ── 活动 ─────────────────────────────────────────────────────────────────────

@router.get("/campaigns")
async def list_campaigns(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(OutreachCampaign).where(OutreachCampaign.tenant_id == tenant_id)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(OutreachCampaign.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_campaign(c) for c in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("/campaigns", status_code=201)
async def create_campaign(
    body: CampaignCreate,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    mailbox_id = body.mailbox_id
    if mailbox_id is None:
        default_mb = (await db.execute(
            select(OutreachMailbox).where(
                OutreachMailbox.tenant_id == tenant_id,
                OutreachMailbox.is_default == True,  # noqa: E712
                OutreachMailbox.enabled == True,  # noqa: E712
            )
        )).scalar_one_or_none()
        mailbox_id = default_mb.id if default_mb else None
    c = OutreachCampaign(
        tenant_id=tenant_id, name=body.name,
        subject_template=body.subject_template, body_template=body.body_template,
        mailbox_id=mailbox_id, created_by=str(auth.user_id),
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return _row_to_campaign(c)


# ── AI 生成邮件（可关，模板兜底）────────────────────────────────────────────

@router.post("/generate")
async def generate_email(
    body: GenerateEmail,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    return await run_ai_task(db, tenant_id_of(auth), "email_generation", body.payload)


# ── 发送 ─────────────────────────────────────────────────────────────────────

@router.post("/campaigns/{campaign_id}/send")
async def send_campaign(
    campaign_id: int,
    body: CampaignSend,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    """选客户 → 渲染 → 生成消息 → 逐封发送（原子抢占防重复，失败可重发）。

    发送节奏预留：当前逐封顺序发送；rate limit 字段在 mailboxes 表。
    """
    tenant_id = tenant_id_of(auth)
    c = await _get_campaign_or_404(db, tenant_id, campaign_id)
    if c.status == "sending":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "ALREADY_SENDING",
            "detail": "该活动正在发送中"})
    mailbox = None
    if c.mailbox_id:
        mailbox = await _get_mailbox_or_404(db, tenant_id, c.mailbox_id)
        if not mailbox.enabled:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "MAILBOX_DISABLED",
                "detail": "发件邮箱已停用"})
    else:
        # 第一版单邮箱：活动未指定发件邮箱时回退到租户默认邮箱
        mailbox = (await db.execute(
            select(OutreachMailbox).where(
                OutreachMailbox.tenant_id == tenant_id,
                OutreachMailbox.is_default == True,  # noqa: E712
                OutreachMailbox.enabled == True,     # noqa: E712
            )
        )).scalar_one_or_none()
        if mailbox is None:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "NO_DEFAULT_MAILBOX",
                "detail": "未配置默认发件邮箱（先 POST /outreach/mailboxes 并设 is_default）"})

    leads = (await db.execute(
        select(LeadCandidate).where(
            LeadCandidate.tenant_id == tenant_id,
            LeadCandidate.id.in_(body.lead_ids),
        )
    )).scalars().all()
    if not leads:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NO_LEADS",
            "detail": "未选中有效线索"})

    # 渲染预览：变量为空则替换为空串（避免 {{xxx}} 残留）
    messages = []
    for lead in leads:
        variables = _lead_variables(lead, mailbox)
        msg = OutreachMessage(
            tenant_id=tenant_id, campaign_id=c.id, lead_id=lead.id,
            to_email=lead.email or "",
            to_name=lead.company_name,
            subject=render_template(c.subject_template, variables),
            body_rendered=render_template(c.body_template, variables),
            status="pending",
        )
        if not msg.to_email:
            msg.status = "failed"
            msg.error = "线索无邮箱"
        messages.append(msg)
        db.add(msg)
    c.status = "sending"
    c.total_count = len(messages)
    await db.commit()

    sent, failed = 0, 0
    for msg in messages:
        if msg.status == "failed":
            failed += 1
            continue
        # 原子抢占：仅 pending 可抢，防重复发送/并发双发
        claimed = (await db.execute(
            update(OutreachMessage)
            .where(OutreachMessage.id == msg.id,
                   OutreachMessage.status == "pending")
            .values(status="sending")
            .returning(OutreachMessage.id)
        )).first()
        await db.commit()
        if claimed is None:
            continue
        await db.refresh(msg)
        await _send_one(db, tenant_id, msg, mailbox)
        await db.commit()
        if msg.status == "sent":
            sent += 1
        else:
            failed += 1

    await db.refresh(c)
    c.status = "sent"
    c.sent_count = sent
    c.failed_count = failed
    await db.commit()
    return {"campaign_id": c.id, "total": len(messages), "sent": sent, "failed": failed}


# ── 消息列表 / 重发 ──────────────────────────────────────────────────────────

@router.get("/messages")
async def list_messages(
    campaign_id: Optional[int] = None,
    lead_id: Optional[int] = None,
    status: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    """收件人独立列表（§6.7）：每行一个收件人。"""
    tenant_id = tenant_id_of(auth)
    stmt = select(OutreachMessage).where(OutreachMessage.tenant_id == tenant_id)
    if campaign_id:
        stmt = stmt.where(OutreachMessage.campaign_id == campaign_id)
    if lead_id:
        stmt = stmt.where(OutreachMessage.lead_id == lead_id)
    if status:
        stmt = stmt.where(OutreachMessage.status == status)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(OutreachMessage.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_message(m) for m in rows],
            "total": total, "page": page, "page_size": page_size}


@router.get("/messages/{message_id}")
async def get_message(
    message_id: int,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    """消息详情：完整正文 + 时间线（§6.7 展开看完整正文/历史触达）。"""
    tenant_id = tenant_id_of(auth)
    m = (await db.execute(
        select(OutreachMessage).where(
            OutreachMessage.tenant_id == tenant_id, OutreachMessage.id == message_id)
    )).scalar_one_or_none()
    if m is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "MESSAGE_NOT_FOUND"})
    return {**_row_to_message(m), "body_rendered": m.body_rendered}


@router.post("/messages/{message_id}/retry")
async def retry_message(
    message_id: int,
    auth: AuthContext = Depends(require_outreach),
    db: AsyncSession = Depends(get_db_session),
):
    """失败/退信人工重发（§6.5）：重置为 pending 后走发送流程。"""
    tenant_id = tenant_id_of(auth)
    m = (await db.execute(
        select(OutreachMessage).where(
            OutreachMessage.tenant_id == tenant_id, OutreachMessage.id == message_id)
    )).scalar_one_or_none()
    if m is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "MESSAGE_NOT_FOUND"})
    if m.status not in ("failed", "bounced"):
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "NOT_RETRYABLE",
            "detail": f"状态 {m.status} 不可重发（仅 failed/bounced）"})
    m.status = "pending"
    m.error = None
    if m.campaign_id:
        c = await _get_campaign_or_404(db, tenant_id, m.campaign_id)
        mailbox = await _get_mailbox_or_404(db, tenant_id, c.mailbox_id) if c.mailbox_id else None
        if mailbox:
            await _send_one(db, tenant_id, m, mailbox)
    await db.commit()
    await db.refresh(m)
    return _row_to_message(m)


# ── Inbound webhook 路由预留（§6.8：返回未实现）────────────────────────────

@router.post("/webhook")
async def inbound_webhook():
    """Inbound 邮件解析 webhook 预留。第一版返回 501 未实现（路由已就位）。"""
    raise HTTPException(status_code=501, detail={
        "error": "not_implemented", "code": "INBOUND_WEBHOOK_RESERVED",
        "detail": "Inbound webhook 路由预留，后续版本实现解析"})

