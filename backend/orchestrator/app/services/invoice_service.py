"""
Kaas v2 · 财务工位 — 智能开票 Service 层
─────────────────────────────────────────
设计原则：
- 抽象平台接口：任何开票平台只需实现 InvoicePlatformInterface
- 配置驱动：平台名称、参数全部来自 InvoicePlatformConfig
- 状态机严格校验，所有状态转换必须经过校验
- 审计日志与业务操作同一事务写入
"""

import hashlib
import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Optional, List

import structlog
from fastapi import HTTPException
from sqlalchemy import select, desc, func, and_, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import (
    InvoiceRequest,
    InvoiceRecord,
    CustomerInvoiceHeader,
    InvoicePlatformConfig,
    InvoiceTemplate,
    FinancialWorkstationSession,
    InvoiceAuditLog,
)
from app.core.auth import AuthContext
from app.core.auth_utils import require_internal
from app.schemas.invoice import (
    InvoiceRequestCreate,
    InvoiceConfirmRequest,
    InvoiceRejectRequest,
    CustomerHeaderCreate,
    PlatformConfigCreate,
    InvoiceTemplateCreate,
)

logger = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════════
# 抽象平台接口（可扩展性核心）
# ═══════════════════════════════════════════════════════════════

class InvoicePlatformInterface(ABC):
    """开票平台抽象接口 — 新增平台只需实现此类并注册。"""

    @abstractmethod
    async def issue(self, params: dict, config: InvoicePlatformConfig) -> dict:
        """开票，返回平台原始响应。"""
        pass

    @abstractmethod
    async def health_check(self, config: InvoicePlatformConfig) -> dict:
        """健康检查，返回 {"status": "ok|error", "response_time_ms": int}。"""
        pass

    @abstractmethod
    async def fetch_pdf(self, platform_request_id: str, config: InvoicePlatformConfig) -> bytes:
        """获取 PDF 文件内容。"""
        pass


# ── 平台注册表（可扩展：运行时注册新平台） ──
_PLATFORM_REGISTRY: dict[str, type[InvoicePlatformInterface]] = {}


def register_platform(name: str, cls: type[InvoicePlatformInterface]) -> None:
    """注册新的开票平台实现。"""
    _PLATFORM_REGISTRY[name] = cls
    logger.info("platform_registered", platform_name=name)


def get_platform(name: str) -> Optional[type[InvoicePlatformInterface]]:
    return _PLATFORM_REGISTRY.get(name)


# ═══════════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════════

def _hash_record(record_data: dict) -> str:
    """计算记录的 SHA-256 哈希。"""
    payload = json.dumps(record_data, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ── 状态机定义 ──
INVOICE_REQUEST_STATES = {
    "pending_extraction": {"to": ["extracted", "failed_extraction"]},
    "extracted": {"to": ["pending_confirmation", "rejected"]},
    "pending_confirmation": {"to": ["confirmed", "rejected"]},
    "confirmed": {"to": ["issuing", "failed_issue"]},
    "issuing": {"to": ["issued", "failed_issue"]},
    "issued": {"to": []},
    "failed_extraction": {"to": ["pending_extraction"]},
    "failed_issue": {"to": ["confirmed"]},
    "rejected": {"to": ["pending_extraction"]},
}


def _validate_state_transition(current: str, target: str) -> None:
    allowed = INVOICE_REQUEST_STATES.get(current, {}).get("to", [])
    if target not in allowed:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_state_transition",
                "message": f"Cannot transition from '{current}' to '{target}'",
                "allowed": allowed,
            },
        )


# ═══════════════════════════════════════════════════════════════
# InvoiceService
# ═══════════════════════════════════════════════════════════════

class InvoiceService:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ── 审计日志 ──
    async def _audit(
        self,
        tenant_id: str,
        event_type: str,
        actor_id: Optional[int],
        resource_type: str,
        resource_id: str,
        action: str,
        changes: Optional[dict] = None,
        previous_hash: Optional[str] = None,
    ) -> InvoiceAuditLog:
        """写入审计日志，自动计算哈希链。"""
        record_data = {
            "tenant_id": tenant_id,
            "event_type": event_type,
            "actor_id": actor_id,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "action": action,
            "changes": changes,
            "previous_hash": previous_hash,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        current_hash = _hash_record(record_data)

        log = InvoiceAuditLog(
            tenant_id=tenant_id,
            event_type=event_type,
            actor_id=actor_id,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action,
            changes=changes,
            previous_hash=previous_hash,
            current_hash=current_hash,
        )
        self.db.add(log)
        return log

    # ═══════════════════════════════════════════════════════════
    # InvoiceRequest
    # ═══════════════════════════════════════════════════════════

    async def create_request(
        self,
        tenant_id: str,
        data: InvoiceRequestCreate,
        auth: AuthContext,
    ) -> InvoiceRequest:
        """创建开票请求。"""
        req = InvoiceRequest(
            tenant_id=tenant_id,
            wechat_message_id=data.wechat_message_id,
            from_wechat_user_id=data.from_wechat_user_id,
            from_wechat_username=data.from_wechat_username,
            wechat_conversation_id=data.wechat_conversation_id,
            raw_message_content=data.raw_message_content,
            message_type=data.message_type,
            attached_image_urls=data.attached_image_urls,
            voice_transcription=data.voice_transcription,
            status="pending_extraction",
        )
        self.db.add(req)
        await self.db.flush()

        await self._audit(
            tenant_id=tenant_id,
            event_type="invoice_request_created",
            actor_id=auth.user_id,
            resource_type="invoice_request",
            resource_id=str(req.id),
            action="create",
            changes={"wechat_message_id": data.wechat_message_id},
        )
        await self.db.commit()
        return req

    async def list_requests(
        self,
        tenant_id: str,
        status: Optional[str],
        customer_id: Optional[int],
        page: int,
        page_size: int,
    ) -> dict:
        """列出开票请求。"""
        q = select(InvoiceRequest).where(InvoiceRequest.tenant_id == tenant_id)
        if status:
            q = q.where(InvoiceRequest.status == status)
        if customer_id:
            q = q.where(InvoiceRequest.customer_id == customer_id)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.db.execute(count_q)).scalar_one()

        q = q.order_by(desc(InvoiceRequest.created_at)).offset((page - 1) * page_size).limit(page_size)
        result = await self.db.execute(q)
        items = result.scalars().all()
        return {"items": items, "total": total}

    async def get_request(self, tenant_id: str, request_id: int) -> InvoiceRequest:
        """获取开票请求详情。"""
        q = select(InvoiceRequest).where(
            InvoiceRequest.tenant_id == tenant_id,
            InvoiceRequest.id == request_id,
        )
        result = await self.db.execute(q)
        req = result.scalar_one_or_none()
        if not req:
            raise HTTPException(status_code=404, detail="Invoice request not found")
        return req

    async def confirm_request(
        self,
        tenant_id: str,
        request_id: int,
        data: InvoiceConfirmRequest,
        auth: AuthContext,
    ) -> InvoiceRequest:
        """确认开票请求 — 红蓝修复版。"""
        req = await self.get_request(tenant_id, request_id)

        # ── 1. 状态机校验 ──
        _validate_state_transition(req.status, "confirmed")

        # ── 2. 抬头校验 ──
        header_q = select(CustomerInvoiceHeader).where(
            CustomerInvoiceHeader.tenant_id == tenant_id,
            CustomerInvoiceHeader.id == data.customer_header_id,
            CustomerInvoiceHeader.status == "active",
        )
        header_result = await self.db.execute(header_q)
        header = header_result.scalar_one_or_none()
        if not header:
            raise HTTPException(status_code=400, detail="Customer header not found or inactive")

        # 红蓝修复：只有 verified 的抬头才能用于开票
        if header.verification_status != "verified":
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "header_not_verified",
                    "message": f"Header verification_status is '{header.verification_status}', must be 'verified'",
                },
            )

        # ── 3. 覆盖审批校验 ──
        if data.extracted_data_override:
            if not data.override_approved_by:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "override_approval_required", "message": "override_approved_by is required for data override"},
                )
            # 校验审批人是否有权限（简化：仅允许 internal 或同 customer 的管理员）
            require_internal(auth)

        # ── 4. 更新 ──
        req.matched_customer_header_id = data.customer_header_id
        req.merged_invoice_params = data.extracted_data_override or req.extracted_data
        req.extracted_data_override = data.extracted_data_override
        req.override_reason = data.override_reason
        req.override_approved_by = data.override_approved_by
        req.platform_config_id = data.platform_config_id
        req.status = "confirmed"
        req.confirmed_by_user_id = auth.user_id
        req.confirmation_timestamp = datetime.now(timezone.utc)
        req.confirmation_notes = data.notes

        self.db.add(req)
        await self._audit(
            tenant_id=tenant_id,
            event_type="invoice_request_confirmed",
            actor_id=auth.user_id,
            resource_type="invoice_request",
            resource_id=str(req.id),
            action="confirm",
            changes={
                "customer_header_id": data.customer_header_id,
                "override": bool(data.extracted_data_override),
            },
            previous_hash=req.trace_id,
        )
        await self.db.commit()
        return req

    async def reject_request(
        self,
        tenant_id: str,
        request_id: int,
        data: InvoiceRejectRequest,
        auth: AuthContext,
    ) -> InvoiceRequest:
        """拒绝开票请求。"""
        req = await self.get_request(tenant_id, request_id)
        _validate_state_transition(req.status, "rejected")

        req.status = "rejected"
        req.rejection_reason = data.rejection_reason
        req.confirmed_by_user_id = auth.user_id
        req.confirmation_timestamp = datetime.now(timezone.utc)

        await self._audit(
            tenant_id=tenant_id,
            event_type="invoice_request_rejected",
            actor_id=auth.user_id,
            resource_type="invoice_request",
            resource_id=str(req.id),
            action="reject",
            changes={"reason": data.rejection_reason},
            previous_hash=req.trace_id,
        )
        await self.db.commit()
        return req

    # ═══════════════════════════════════════════════════════════
    # CustomerInvoiceHeader
    # ═══════════════════════════════════════════════════════════

    async def create_header(
        self,
        tenant_id: str,
        data: CustomerHeaderCreate,
        auth: AuthContext,
    ) -> CustomerInvoiceHeader:
        """创建客户抬头 — 初始状态 pending，需后续校验。"""
        header = CustomerInvoiceHeader(
            tenant_id=tenant_id,
            customer_id=data.customer_id,
            company_name=data.company_name,
            uscc=data.uscc,
            tax_id=data.tax_id,
            registered_address=data.registered_address,
            registered_province=data.registered_province,
            registered_city=data.registered_city,
            phone_number=data.phone_number,
            bank_name=data.bank_name,
            is_primary=data.is_primary,
            verification_status="pending",
            status="active",
            created_by=auth.user_id,
        )
        self.db.add(header)
        await self.db.flush()

        await self._audit(
            tenant_id=tenant_id,
            event_type="header_created",
            actor_id=auth.user_id,
            resource_type="customer_header",
            resource_id=str(header.id),
            action="create",
            changes={"tax_id": data.tax_id, "company_name": data.company_name},
        )
        await self.db.commit()
        return header

    async def list_headers(
        self,
        tenant_id: str,
        customer_id: Optional[int],
        status: str,
        page: int,
        page_size: int,
    ) -> dict:
        """列出客户抬头。"""
        q = select(CustomerInvoiceHeader).where(
            CustomerInvoiceHeader.tenant_id == tenant_id,
        )
        if customer_id:
            q = q.where(CustomerInvoiceHeader.customer_id == customer_id)
        if status:
            q = q.where(CustomerInvoiceHeader.status == status)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.db.execute(count_q)).scalar_one()

        q = q.order_by(desc(CustomerInvoiceHeader.is_primary), desc(CustomerInvoiceHeader.created_at))
        q = q.offset((page - 1) * page_size).limit(page_size)
        result = await self.db.execute(q)
        return {"items": result.scalars().all(), "total": total}

    async def get_header(self, tenant_id: str, header_id: int) -> CustomerInvoiceHeader:
        q = select(CustomerInvoiceHeader).where(
            CustomerInvoiceHeader.tenant_id == tenant_id,
            CustomerInvoiceHeader.id == header_id,
        )
        result = await self.db.execute(q)
        header = result.scalar_one_or_none()
        if not header:
            raise HTTPException(status_code=404, detail="Customer header not found")
        return header

    async def verify_header(
        self,
        tenant_id: str,
        header_id: int,
        auth: AuthContext,
    ) -> dict:
        """触发税务校验（异步任务占位）。"""
        header = await self.get_header(tenant_id, header_id)
        header.verification_status = "pending"
        header.verification_checked_at = datetime.now(timezone.utc)

        await self._audit(
            tenant_id=tenant_id,
            event_type="header_verification_triggered",
            actor_id=auth.user_id,
            resource_type="customer_header",
            resource_id=str(header.id),
            action="verify",
            changes={"status": "pending"},
        )
        await self.db.commit()

        # TODO: 接入异步任务队列（Celery / RQ）执行实际税务校验
        return {
            "status": "pending",
            "message": "Verification task queued",
            "header_id": header_id,
        }

    # ═══════════════════════════════════════════════════════════
    # InvoicePlatformConfig
    # ═══════════════════════════════════════════════════════════

    async def create_platform_config(
        self,
        tenant_id: str,
        data: PlatformConfigCreate,
        auth: AuthContext,
    ) -> InvoicePlatformConfig:
        """创建开票平台配置 — 管理员权限。"""
        cfg = InvoicePlatformConfig(
            tenant_id=tenant_id,
            platform_name=data.platform_name,
            platform_display_name=data.platform_display_name,
            api_endpoint=data.api_endpoint,
            api_version=data.api_version,
            credentials_encrypted=data.credentials_encrypted,
            credentials_kms_key_id=data.credentials_kms_key_id,
            credentials_encryption_context=data.credentials_encryption_context,
            config_params=data.config_params,
            is_primary=data.is_primary,
            daily_quota=data.daily_quota,
            created_by=auth.user_id,
        )
        self.db.add(cfg)
        await self.db.flush()

        await self._audit(
            tenant_id=tenant_id,
            event_type="platform_config_created",
            actor_id=auth.user_id,
            resource_type="platform_config",
            resource_id=str(cfg.id),
            action="create",
            changes={"platform_name": data.platform_name},
        )
        await self.db.commit()
        return cfg

    async def list_platform_configs(self, tenant_id: str) -> List[InvoicePlatformConfig]:
        q = select(InvoicePlatformConfig).where(
            InvoicePlatformConfig.tenant_id == tenant_id,
        ).order_by(desc(InvoicePlatformConfig.is_primary))
        result = await self.db.execute(q)
        return list(result.scalars().all())

    async def health_check_platform(
        self,
        tenant_id: str,
        config_id: int,
    ) -> dict:
        """触发平台健康检查。"""
        cfg = await self._get_platform_config(tenant_id, config_id)

        # 获取平台实现
        platform_cls = get_platform(cfg.platform_name)
        if not platform_cls:
            raise HTTPException(
                status_code=400,
                detail={"error": "platform_not_implemented", "message": f"Platform '{cfg.platform_name}' has no registered implementation"},
            )

        platform = platform_cls()
        result = await platform.health_check(cfg)

        cfg.last_health_check_at = datetime.now(timezone.utc)
        cfg.health_check_status = result.get("status")
        cfg.health_check_error_msg = result.get("message")
        await self.db.commit()

        return {
            "status": result.get("status", "unknown"),
            "message": result.get("message", ""),
            "response_time_ms": result.get("response_time_ms", 0),
            "last_checked_at": cfg.last_health_check_at.isoformat(),
        }

    async def _get_platform_config(self, tenant_id: str, config_id: int) -> InvoicePlatformConfig:
        q = select(InvoicePlatformConfig).where(
            InvoicePlatformConfig.tenant_id == tenant_id,
            InvoicePlatformConfig.id == config_id,
        )
        result = await self.db.execute(q)
        cfg = result.scalar_one_or_none()
        if not cfg:
            raise HTTPException(status_code=404, detail="Platform config not found")
        return cfg

    # ═══════════════════════════════════════════════════════════
    # InvoiceTemplate
    # ═══════════════════════════════════════════════════════════

    async def create_template(
        self,
        tenant_id: str,
        data: InvoiceTemplateCreate,
        auth: AuthContext,
    ) -> InvoiceTemplate:
        tmpl = InvoiceTemplate(
            tenant_id=tenant_id,
            customer_id=data.customer_id,
            tax_code=data.tax_code,
            tax_code_name=data.tax_code_name,
            nickname=data.nickname,
            synonyms=data.synonyms,
            default_tax_rate=data.default_tax_rate,
            tax_rate_options=data.tax_rate_options,
            default_unit=data.default_unit,
            unit_options=data.unit_options,
            category=data.category,
            sub_category=data.sub_category,
            created_by=auth.user_id,
        )
        self.db.add(tmpl)
        await self.db.flush()

        await self._audit(
            tenant_id=tenant_id,
            event_type="template_created",
            actor_id=auth.user_id,
            resource_type="invoice_template",
            resource_id=str(tmpl.id),
            action="create",
            changes={"tax_code": data.tax_code},
        )
        await self.db.commit()
        return tmpl

    async def list_templates(
        self,
        tenant_id: str,
        category: Optional[str],
        q: Optional[str],
    ) -> List[InvoiceTemplate]:
        stmt = select(InvoiceTemplate).where(
            InvoiceTemplate.tenant_id == tenant_id,
            InvoiceTemplate.status == "active",
        )
        if category:
            stmt = stmt.where(InvoiceTemplate.category == category)
        if q:
            stmt = stmt.where(
                and_(
                    InvoiceTemplate.tenant_id == tenant_id,
                    InvoiceTemplate.status == "active",
                ).
                # 简单搜索：nickname / tax_code_name / synonyms
                # 更复杂的搜索应使用 PostgreSQL tsvector
                # 这里用 OR 条件简化
            )
            from sqlalchemy import or_
            stmt = stmt.where(
                or_(
                    InvoiceTemplate.nickname.ilike(f"%{q}%"),
                    InvoiceTemplate.tax_code_name.ilike(f"%{q}%"),
                )
            )

        stmt = stmt.order_by(desc(InvoiceTemplate.priority_score), desc(InvoiceTemplate.usage_count))
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    # ═══════════════════════════════════════════════════════════
    # FinancialWorkstationSession
    # ═══════════════════════════════════════════════════════════

    async def get_todo_list(
        self,
        tenant_id: str,
        status: str,
        auth: AuthContext,
    ) -> dict:
        """获取工位待办列表。"""
        q = select(InvoiceRequest).where(
            InvoiceRequest.tenant_id == tenant_id,
            InvoiceRequest.status == status,
        ).order_by(desc(InvoiceRequest.priority), desc(InvoiceRequest.created_at))

        result = await self.db.execute(q)
        items = result.scalars().all()

        # 懒检查超时
        now = datetime.now(timezone.utc)
        for item in items:
            # 这里简化处理，实际应查询 workstation_session 表
            pass

        return {"items": items, "total": len(items)}

    async def claim_workstation(
        self,
        tenant_id: str,
        invoice_request_id: int,
        auth: AuthContext,
    ) -> dict:
        """原子抢占工位 — 使用 SELECT FOR UPDATE SKIP LOCKED。"""
        # 使用原生 SQL 实现 SKIP LOCKED
        from sqlalchemy import text
        sql = text("""
            SELECT id FROM financial_workstation_sessions
            WHERE tenant_id = :tenant_id
              AND invoice_request_id = :invoice_request_id
              AND status = 'pending'
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        """)
        result = await self.db.execute(sql, {
            "tenant_id": tenant_id,
            "invoice_request_id": invoice_request_id,
        })
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="Workstation already claimed or not available")

        session_id = row[0]
        await self.db.execute(
            update(FinancialWorkstationSession).
            where(FinancialWorkstationSession.id == session_id).
            values(
                status="assigned",
                assigned_to_user_id=auth.user_id,
                assigned_at=datetime.now(timezone.utc),
                timeout_at=datetime.now(timezone.utc) + timedelta(minutes=30),
            )
        )

        # 获取关联的 invoice_request
        req = await self.get_request(tenant_id, invoice_request_id)

        await self._audit(
            tenant_id=tenant_id,
            event_type="workstation_claimed",
            actor_id=auth.user_id,
            resource_type="workstation_session",
            resource_id=str(session_id),
            action="claim",
            changes={"invoice_request_id": invoice_request_id},
        )
        await self.db.commit()

        return {
            "status": "claimed",
            "session_id": session_id,
            "invoice_request": req,
        }

    # ═══════════════════════════════════════════════════════════
    # AuditLog
    # ═══════════════════════════════════════════════════════════

    async def list_audit_logs(
        self,
        tenant_id: str,
        resource_type: Optional[str],
        resource_id: Optional[str],
        page: int,
        page_size: int,
    ) -> List[InvoiceAuditLog]:
        q = select(InvoiceAuditLog).where(InvoiceAuditLog.tenant_id == tenant_id)
        if resource_type:
            q = q.where(InvoiceAuditLog.resource_type == resource_type)
        if resource_id:
            q = q.where(InvoiceAuditLog.resource_id == resource_id)

        q = q.order_by(desc(InvoiceAuditLog.created_at))
        q = q.offset((page - 1) * page_size).limit(page_size)
        result = await self.db.execute(q)
        return list(result.scalars().all())
