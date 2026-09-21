"""询盘接入扫描（最终设计 §七；P5）

触达工位回写 outreach_status='replied' 后，定时任务/手动触发扫描
lead_candidates，为每条新建 cust_inquiries（lead_id 关联，不合并表），
并把询盘状态同步回 lead_candidates.inquiry_status：

| cust_inquiries | lead_candidates.inquiry_status |
|---|---|
| open | new |
| quoted | following |
| won | won |
| lost | lost |

幂等：lead_id 已有询盘记录则跳过（一个线索一条询盘，重复跟进在原询盘上流转）。
"""
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import async_session_factory
from app.db.workstation_models import (
    CustCustomer, CustInquiry, LeadCandidate,
)

logger = structlog.get_logger(__name__)

# cust_inquiries.status → lead_candidates.inquiry_status（§7.2）
INQUIRY_SYNC_MAP = {"open": "new", "quoted": "following", "won": "won", "lost": "lost"}


async def scan_replied_leads(db: AsyncSession, tenant_id: str, limit: int = 100) -> dict:
    """扫描 replied 且未建询盘的线索 → 建客户档案 + 询盘。返回处理统计。"""
    leads = (await db.execute(
        select(LeadCandidate).where(
            LeadCandidate.tenant_id == tenant_id,
            LeadCandidate.outreach_status == "replied",
            LeadCandidate.inquiry_status == "none",
        ).limit(limit)
    )).scalars().all()

    created, existing = 0, 0
    for lead in leads:
        # 幂等：lead_id 已有询盘 → 只同步状态
        inq = (await db.execute(
            select(CustInquiry).where(
                CustInquiry.tenant_id == tenant_id, CustInquiry.lead_id == lead.id)
        )).scalar_one_or_none()
        if inq is not None:
            lead.inquiry_status = INQUIRY_SYNC_MAP.get(inq.status, "new")
            existing += 1
            continue

        # 客户档案：同名客户复用（按租户+公司名匹配），否则新建
        customer = (await db.execute(
            select(CustCustomer).where(
                CustCustomer.tenant_id == tenant_id,
                CustCustomer.company_name == lead.company_name)
        )).scalar_one_or_none()
        if customer is None:
            customer = CustCustomer(
                tenant_id=tenant_id, company_name=lead.company_name,
                country=lead.country, address=lead.address,
                stage="inquiry",  # 直接进 inquiry 阶段（触达已回复）
                owner_id=lead.owner_id, owner_scope="tenant",
            )
            db.add(customer)
            await db.flush()

        inq = CustInquiry(
            tenant_id=tenant_id, customer_id=customer.id, lead_id=lead.id,
            channel="email", notes=f"来自线索池触达回复（lead#{lead.id}）",
            status="open",
            owner_id=lead.owner_id, owner_scope="tenant",
        )
        db.add(inq)
        lead.inquiry_status = "new"
        created += 1
        logger.info("inquiry_created_from_lead", lead_id=lead.id,
                    customer_id=customer.id, tenant_id=tenant_id)

    await db.commit()
    return {"scanned": len(leads), "created": created, "already_linked": existing}


async def sync_inquiry_status(db: AsyncSession, tenant_id: str, inquiry: CustInquiry):
    """询盘状态流转后回写线索池 inquiry_status（§7.2 状态同步）。"""
    if inquiry.lead_id is None:
        return
    mapped = INQUIRY_SYNC_MAP.get(inquiry.status)
    if mapped is None:
        return
    lead = (await db.execute(
        select(LeadCandidate).where(
            LeadCandidate.tenant_id == tenant_id, LeadCandidate.id == inquiry.lead_id)
    )).scalar_one_or_none()
    if lead is not None and lead.inquiry_status != mapped:
        lead.inquiry_status = mapped


async def scan_replied_leads_job():
    """APScheduler 定时任务入口：每 15 分钟扫 replied → 建询盘。"""
    try:
        async with async_session_factory() as db:
            # 各租户独立扫描；v1 以 default 租户为主（多租户调度后续按订阅表扩展）
            await scan_replied_leads(db, "default")
    except Exception as e:
        logger.error("lead_scan_job_failed", error=str(e))
