"""UN Comtrade API collector service"""
import httpx
import structlog
from typing import List, Dict, Optional
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import IntelTradeStat, IntelAdapterRun

logger = structlog.get_logger()

# HS codes for wire mesh products (from design doc)
WIRE_MESH_HS_CODES = [
    "7314.20",  # knotted netting (勾花网/牛栏网)
    "7314.31",  # welded mesh, zinc plated
    "7314.39",  # welded mesh, other
    "7314.41",  # other mesh, zinc plated
    "7314.42",  # other mesh, plastic coated
    "7314.49",  # other mesh
    "7314.50",  # expanded metal (钢板网)
    "7313.00",  # barbed wire (刺绳)
    "7326.20",  # barbed tape/razor wire (刀片刺绳)
    "7308.90",  # fence structures
    "3926.90",  # plastic netting
    "7217.20",  # galvanized wire (upstream)
]

COMTRADE_API_BASE = "https://comtradeapi.un.org/public/v1/preview/C/A/HS"


class ComtradeCollector:
    """Collect trade statistics from UN Comtrade API"""

    def __init__(self, db: AsyncSession, tenant_id: str):
        self.db = db
        self.tenant_id = tenant_id
        self.client = httpx.AsyncClient(timeout=30.0)

    async def fetch_trade_data(
        self,
        reporter_country: str,
        period: str,  # YYYY-MM format
        trade_flow: str = "import",  # import | export
        partner_country: str = "all",
        hs_codes: Optional[List[str]] = None,
    ) -> List[Dict]:
        """
        Fetch trade data from UN Comtrade API

        Args:
            reporter_country: e.g., "USA", "CHN", "842" (ISO3 or M49 code)
            period: e.g., "2024-01" (monthly)
            trade_flow: "import" or "export"
            partner_country: "all" or specific country code
            hs_codes: list of HS codes to query (default: wire mesh products)
        """
        if hs_codes is None:
            hs_codes = WIRE_MESH_HS_CODES

        all_data = []

        for hs_code in hs_codes:
            try:
                params = {
                    "reporterCode": reporter_country,
                    "period": period.replace("-", ""),
                    "flowCode": trade_flow,
                    "partnerCode": partner_country,
                    "cmdCode": hs_code.replace(".", ""),
                    "maxRecords": 500,
                }

                response = await self.client.get(COMTRADE_API_BASE, params=params)

                if response.status_code == 200:
                    data = response.json()
                    records = data.get("data", [])
                    all_data.extend(records)
                    logger.info(
                        "comtrade_fetch_success",
                        hs_code=hs_code,
                        records=len(records),
                    )
                else:
                    logger.warning(
                        "comtrade_fetch_failed",
                        hs_code=hs_code,
                        status=response.status_code,
                    )

            except Exception as e:
                logger.error("comtrade_fetch_error", hs_code=hs_code, error=str(e))

        return all_data

    async def save_to_database(
        self,
        data: List[Dict],
        source_channel: str = "un_comtrade",
    ) -> int:
        """Save fetched data to intel_trade_stats table"""
        inserted = 0

        for record in data:
            try:
                trade_stat = IntelTradeStat(
                    tenant_id=self.tenant_id,
                    hs_code=record.get("cmdCode", ""),
                    period=self._format_period(record.get("period", "")),
                    reporter_country=record.get("reporterDesc", ""),
                    partner_country=record.get("partnerDesc", ""),
                    trade_flow=record.get("flowDesc", "").lower(),
                    qty=record.get("qty"),
                    qty_unit=record.get("qtyUnitAbbr"),
                    value_usd=record.get("primaryValue"),
                    source_channel=source_channel,
                    raw_data=record,
                )
                self.db.add(trade_stat)
                inserted += 1

            except Exception as e:
                logger.error("save_trade_stat_error", error=str(e))

        await self.db.flush()
        return inserted

    async def collect(
        self,
        reporter_country: str,
        period: str,
        trade_flow: str = "import",
    ) -> Dict:
        """
        Main collection method: fetch + save + log

        Returns:
            Dict with stats about the run
        """
        run = IntelAdapterRun(
            tenant_id=self.tenant_id,
            status="running",
            run_metadata={
                "reporter_country": reporter_country,
                "period": period,
                "trade_flow": trade_flow,
            },
        )
        self.db.add(run)
        await self.db.flush()

        try:
            # Fetch data
            data = await self.fetch_trade_data(
                reporter_country=reporter_country,
                period=period,
                trade_flow=trade_flow,
            )

            # Save to database
            inserted = await self.save_to_database(data)

            # Update run record
            run.status = "success"
            run.items_processed = len(data)
            run.items_inserted = inserted
            run.finished_at = datetime.utcnow()

            await self.db.flush()

            logger.info(
                "comtrade_collection_complete",
                reporter=reporter_country,
                period=period,
                processed=len(data),
                inserted=inserted,
            )

            return {
                "status": "success",
                "processed": len(data),
                "inserted": inserted,
            }

        except Exception as e:
            run.status = "failed"
            run.error_message = str(e)
            run.finished_at = datetime.utcnow()
            await self.db.flush()

            logger.error("comtrade_collection_failed", error=str(e))

            return {
                "status": "failed",
                "error": str(e),
            }

    def _format_period(self, period: str) -> str:
        """Convert YYYYMM to YYYY-MM"""
        if len(period) == 6:
            return f"{period[:4]}-{period[4:]}"
        return period

    async def close(self):
        await self.client.aclose()
