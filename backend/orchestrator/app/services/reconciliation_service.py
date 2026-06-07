"""
Kaas v2 · 电商对账 Service 层
──────────────────────────────
设计原则：
- 平台与物流商配置完全可扩展（不硬编码名称/类型）
- 对账逻辑可配置：支持多种匹配策略
- 差异计算原子化，支持逐笔追溯
"""

from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

import structlog
from fastapi import HTTPException
from sqlalchemy import select, desc, func, and_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    ReconciliationReport,
    ReconciliationDiff,
    EcommercePlatformConfig,
    LogisticsProviderConfig,
    PlatformOrderStaging,
    LogisticsBillStaging,
)
from app.core.auth import AuthContext
from app.schemas.reconciliation import (
    EcommercePlatformConfigCreate,
    LogisticsProviderConfigCreate,
    ReconciliationReportCreate,
    RunReconciliationRequest,
    ResolveDiffRequest,
)

logger = structlog.get_logger(__name__)


class ReconciliationService:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ═══════════════════════════════════════════════════════════
    # Dashboard
    # ═══════════════════════════════════════════════════════════

    async def get_dashboard_stats(self, tenant_id: str) -> dict:
        """对账仪表盘统计。"""
        # 总报告数
        total_reports_q = select(func.count()).where(ReconciliationReport.tenant_id == tenant_id)
        total_reports = (await self.db.execute(total_reports_q)).scalar_one()

        # 未解决差异数
        unresolved_q = select(func.count()).where(
            ReconciliationDiff.tenant_id == tenant_id,
            ReconciliationDiff.resolution_status == "open",
        )
        total_unresolved = (await self.db.execute(unresolved_q)).scalar_one()

        # 平台数
        platforms_q = select(func.count()).where(
            EcommercePlatformConfig.tenant_id == tenant_id,
            EcommercePlatformConfig.is_enabled == True,
        )
        total_platforms = (await self.db.execute(platforms_q)).scalar_one()

        # 物流商数
        logistics_q = select(func.count()).where(
            LogisticsProviderConfig.tenant_id == tenant_id,
            LogisticsProviderConfig.is_enabled == True,
        )
        total_logistics = (await self.db.execute(logistics_q)).scalar_one()

        # 最近报告
        recent_q = select(ReconciliationReport).where(
            ReconciliationReport.tenant_id == tenant_id,
        ).order_by(desc(ReconciliationReport.created_at)).limit(5)
        recent_result = await self.db.execute(recent_q)
        recent_reports = list(recent_result.scalars().all())

        last_report = recent_reports[0] if recent_reports else None

        return {
            "total_reports": total_reports,
            "last_report_date": last_report.created_at if last_report else None,
            "total_unresolved_diffs": total_unresolved,
            "total_platforms": total_platforms,
            "total_logistics_providers": total_logistics,
            "recent_reports": recent_reports,
        }

    # ═══════════════════════════════════════════════════════════
    # EcommercePlatformConfig
    # ═══════════════════════════════════════════════════════════

    async def create_platform_config(
        self,
        tenant_id: str,
        data: EcommercePlatformConfigCreate,
        auth: AuthContext,
    ) -> EcommercePlatformConfig:
        cfg = EcommercePlatformConfig(
            tenant_id=tenant_id,
            platform_name=data.platform_name,
            platform_display_name=data.platform_display_name,
            platform_type=data.platform_type,
            api_endpoint=data.api_endpoint,
            api_version=data.api_version,
            credentials_encrypted=data.credentials_encrypted,
            credentials_kms_key_id=data.credentials_kms_key_id,
            credentials_encryption_context=data.credentials_encryption_context,
            config_params=data.config_params,
            supported_fields=data.supported_fields,
            created_by=auth.user_id,
        )
        self.db.add(cfg)
        await self.db.commit()
        return cfg

    async def list_platform_configs(self, tenant_id: str) -> List[EcommercePlatformConfig]:
        q = select(EcommercePlatformConfig).where(
            EcommercePlatformConfig.tenant_id == tenant_id,
        ).order_by(desc(EcommercePlatformConfig.is_enabled))
        result = await self.db.execute(q)
        return list(result.scalars().all())

    # ═══════════════════════════════════════════════════════════
    # LogisticsProviderConfig
    # ═══════════════════════════════════════════════════════════

    async def create_logistics_config(
        self,
        tenant_id: str,
        data: LogisticsProviderConfigCreate,
        auth: AuthContext,
    ) -> LogisticsProviderConfig:
        cfg = LogisticsProviderConfig(
            tenant_id=tenant_id,
            provider_name=data.provider_name,
            provider_display_name=data.provider_display_name,
            provider_type=data.provider_type,
            api_endpoint=data.api_endpoint,
            api_version=data.api_version,
            credentials_encrypted=data.credentials_encrypted,
            credentials_kms_key_id=data.credentials_kms_key_id,
            credentials_encryption_context=data.credentials_encryption_context,
            config_params=data.config_params,
            supported_bill_formats=data.supported_bill_formats,
            created_by=auth.user_id,
        )
        self.db.add(cfg)
        await self.db.commit()
        return cfg

    async def list_logistics_configs(self, tenant_id: str) -> List[LogisticsProviderConfig]:
        q = select(LogisticsProviderConfig).where(
            LogisticsProviderConfig.tenant_id == tenant_id,
        ).order_by(desc(LogisticsProviderConfig.is_enabled))
        result = await self.db.execute(q)
        return list(result.scalars().all())

    # ═══════════════════════════════════════════════════════════
    # ReconciliationReport
    # ═══════════════════════════════════════════════════════════

    async def create_report(
        self,
        tenant_id: str,
        data: ReconciliationReportCreate,
        auth: AuthContext,
    ) -> ReconciliationReport:
        # 快照当前配置
        platform_q = select(EcommercePlatformConfig).where(
            EcommercePlatformConfig.tenant_id == tenant_id,
            EcommercePlatformConfig.id.in_(data.platform_ids),
        )
        platform_result = await self.db.execute(platform_q)
        platforms = list(platform_result.scalars().all())

        logistics_q = select(LogisticsProviderConfig).where(
            LogisticsProviderConfig.tenant_id == tenant_id,
            LogisticsProviderConfig.id.in_(data.logistics_provider_ids),
        )
        logistics_result = await self.db.execute(logistics_q)
        logistics = list(logistics_result.scalars().all())

        if len(platforms) != len(data.platform_ids):
            raise HTTPException(status_code=400, detail="Some platform configs not found")
        if len(logistics) != len(data.logistics_provider_ids):
            raise HTTPException(status_code=400, detail="Some logistics configs not found")

        platform_snapshot = [
            {"id": p.id, "name": p.platform_name, "display_name": p.platform_display_name}
            for p in platforms
        ]
        logistics_snapshot = [
            {"id": l.id, "name": l.provider_name, "display_name": l.provider_display_name}
            for l in logistics
        ]

        report = ReconciliationReport(
            tenant_id=tenant_id,
            report_name=data.report_name,
            report_period_start=data.report_period_start,
            report_period_end=data.report_period_end,
            platform_ids=data.platform_ids,
            platform_config_snapshot=platform_snapshot,
            logistics_provider_ids=data.logistics_provider_ids,
            logistics_config_snapshot=logistics_snapshot,
            total_platform_order_count=0,
            total_platform_amount=0,
            total_logistics_bill_count=0,
            total_logistics_amount=0,
            unmatched_platform_orders=0,
            unmatched_logistics_bills=0,
            status="pending",
            triggered_by_user_id=auth.user_id,
        )
        self.db.add(report)
        await self.db.commit()
        return report

    async def list_reports(
        self,
        tenant_id: str,
        status: Optional[str],
        page: int,
        page_size: int,
    ) -> dict:
        q = select(ReconciliationReport).where(ReconciliationReport.tenant_id == tenant_id)
        if status:
            q = q.where(ReconciliationReport.status == status)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.db.execute(count_q)).scalar_one()

        q = q.order_by(desc(ReconciliationReport.created_at)).offset((page - 1) * page_size).limit(page_size)
        result = await self.db.execute(q)
        return {"items": result.scalars().all(), "total": total}

    async def get_report(self, tenant_id: str, report_id: int) -> ReconciliationReport:
        q = select(ReconciliationReport).where(
            ReconciliationReport.tenant_id == tenant_id,
            ReconciliationReport.id == report_id,
        )
        result = await self.db.execute(q)
        report = result.scalar_one_or_none()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        return report

    # ═══════════════════════════════════════════════════════════
    # Run Reconciliation
    # ═══════════════════════════════════════════════════════════

    async def run_reconciliation(
        self,
        tenant_id: str,
        report_id: int,
        data: RunReconciliationRequest,
        auth: AuthContext,
    ) -> dict:
        """执行对账 — 核心逻辑。"""
        report = await self.get_report(tenant_id, report_id)

        if report.status == "running":
            raise HTTPException(status_code=409, detail="Report is already running")

        report.status = "running"
        await self.db.commit()

        try:
            # 1. 获取平台订单（从 staging 表）
            pos_q = select(PlatformOrderStaging).where(
                PlatformOrderStaging.tenant_id == tenant_id,
                PlatformOrderStaging.reconciliation_report_id == report_id,
            )
            pos_result = await self.db.execute(pos_q)
            platform_orders = list(pos_result.scalars().all())

            # 2. 获取物流账单（从 staging 表）
            lbs_q = select(LogisticsBillStaging).where(
                LogisticsBillStaging.tenant_id == tenant_id,
                LogisticsBillStaging.reconciliation_report_id == report_id,
            )
            lbs_result = await self.db.execute(lbs_q)
            logistics_bills = list(lbs_result.scalars().all())

            # 3. 匹配逻辑（可扩展：支持多种策略）
            diffs: List[dict] = []
            matched_platform_ids = set()
            matched_logistics_ids = set()

            if data.matching_strategy == "order_id_exact":
                # 精确匹配：平台订单号 = 物流账单中的 order_id
                logistics_by_order = {}
                for lb in logistics_bills:
                    if lb.order_id:
                        logistics_by_order[lb.order_id] = lb

                for po in platform_orders:
                    if po.platform_order_id in logistics_by_order:
                        lb = logistics_by_order[po.platform_order_id]
                        matched_platform_ids.add(po.id)
                        matched_logistics_ids.add(lb.id)
                        # 金额差异检查
                        if po.total_amount != lb.freight_fee:
                            diffs.append({
                                "diff_type": "amount_mismatch",
                                "platform_order_id": po.platform_order_id,
                                "platform_amount": po.total_amount,
                                "logistics_bill_id": lb.bill_no,
                                "logistics_freight_fee": lb.freight_fee,
                                "diff_amount": (po.total_amount or 0) - (lb.freight_fee or 0),
                            })
                    else:
                        diffs.append({
                            "diff_type": "missing_logistics",
                            "platform_order_id": po.platform_order_id,
                            "platform_amount": po.total_amount,
                        })

                for lb in logistics_bills:
                    if lb.id not in matched_logistics_ids:
                        diffs.append({
                            "diff_type": "missing_platform",
                            "logistics_bill_id": lb.bill_no,
                            "logistics_freight_fee": lb.freight_fee,
                        })

            else:
                # 其他策略：模糊匹配、人工匹配等
                raise HTTPException(status_code=400, detail=f"Matching strategy '{data.matching_strategy}' not implemented")

            # 4. 写入差异
            for d in diffs:
                diff = ReconciliationDiff(
                    tenant_id=tenant_id,
                    reconciliation_report_id=report_id,
                    diff_type=d["diff_type"],
                    platform_order_id=d.get("platform_order_id"),
                    platform_amount=d.get("platform_amount"),
                    logistics_bill_id=d.get("logistics_bill_id"),
                    logistics_freight_fee=d.get("logistics_freight_fee"),
                    diff_amount=d.get("diff_amount"),
                    diff_reason=d.get("diff_reason"),
                )
                self.db.add(diff)

            # 5. 更新报告汇总
            report.total_platform_order_count = len(platform_orders)
            report.total_platform_amount = sum((po.total_amount or 0) for po in platform_orders)
            report.total_logistics_bill_count = len(logistics_bills)
            report.total_logistics_amount = sum((lb.freight_fee or 0) for lb in logistics_bills)
            report.unmatched_platform_orders = len(platform_orders) - len(matched_platform_ids)
            report.unmatched_logistics_bills = len(logistics_bills) - len(matched_logistics_ids)
            report.diff_summary = {
                "total_diffs": len(diffs),
                "missing_platform": sum(1 for d in diffs if d["diff_type"] == "missing_platform"),
                "missing_logistics": sum(1 for d in diffs if d["diff_type"] == "missing_logistics"),
                "amount_mismatch": sum(1 for d in diffs if d["diff_type"] == "amount_mismatch"),
            }
            report.status = "completed"
            report.completed_at = datetime.now(timezone.utc)

            await self.db.commit()

            return {
                "report_id": report_id,
                "status": "completed",
                "summary": report.diff_summary,
                "message": "Reconciliation completed successfully",
            }

        except Exception as e:
            report.status = "failed"
            await self.db.commit()
            logger.error("reconciliation_failed", report_id=report_id, error=str(e))
            raise HTTPException(status_code=500, detail=f"Reconciliation failed: {str(e)}")

    # ═══════════════════════════════════════════════════════════
    # ReconciliationDiff
    # ═══════════════════════════════════════════════════════════

    async def list_diffs(
        self,
        tenant_id: str,
        report_id: int,
        diff_type: Optional[str],
        resolution_status: Optional[str],
        page: int,
        page_size: int,
    ) -> dict:
        q = select(ReconciliationDiff).where(
            ReconciliationDiff.tenant_id == tenant_id,
            ReconciliationDiff.reconciliation_report_id == report_id,
        )
        if diff_type:
            q = q.where(ReconciliationDiff.diff_type == diff_type)
        if resolution_status:
            q = q.where(ReconciliationDiff.resolution_status == resolution_status)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.db.execute(count_q)).scalar_one()

        q = q.order_by(desc(ReconciliationDiff.created_at)).offset((page - 1) * page_size).limit(page_size)
        result = await self.db.execute(q)
        return {"items": result.scalars().all(), "total": total}

    async def resolve_diff(
        self,
        tenant_id: str,
        diff_id: int,
        data: ResolveDiffRequest,
        auth: AuthContext,
    ) -> ReconciliationDiff:
        q = select(ReconciliationDiff).where(
            ReconciliationDiff.tenant_id == tenant_id,
            ReconciliationDiff.id == diff_id,
        )
        result = await self.db.execute(q)
        diff = result.scalar_one_or_none()
        if not diff:
            raise HTTPException(status_code=404, detail="Diff not found")

        diff.resolution_status = data.resolution_status
        diff.resolved_by_user_id = auth.user_id
        diff.resolved_at = datetime.now(timezone.utc)
        diff.resolution_notes = data.resolution_notes

        await self.db.commit()
        return diff
