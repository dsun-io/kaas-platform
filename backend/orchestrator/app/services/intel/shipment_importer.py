"""Excel/CSV importer service for manual data import"""
import csv
import io
import structlog
from typing import List, Dict, Optional
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import IntelShipment, IntelAdapterRun

logger = structlog.get_logger()


class ShipmentImporter:
    """Import shipment data from Excel/CSV files"""

    # Expected CSV column mapping (case-insensitive)
    COLUMN_MAPPING = {
        # Core fields
        "shipper": ["shipper", "exporter", "发货人", "出口方"],
        "consignee": ["consignee", "importer", "收货人", "进口方", "买家"],
        "ship_date": ["ship_date", "date", "shipment_date", "发货日期", "日期"],
        "carrier": ["carrier", "shipping_line", "船公司", "承运人"],
        "notify_party": ["notify_party", "notify", "通知方", "货代"],
        "origin_port": ["origin_port", "loading_port", "起运港", "装货港"],
        "origin_country": ["origin_country", "起运国"],
        "dest_port": ["dest_port", "destination_port", "discharge_port", "目的港", "卸货港"],
        "dest_country": ["dest_country", "destination_country", "目的国", "进口国"],
        "product_desc": ["product_desc", "product", "goods_description", "品名", "产品描述", "货物描述"],
        "hs_code": ["hs_code", "hs", "hs编码"],
        # Quantities
        "qty": ["qty", "quantity", "数量"],
        "qty_unit": ["qty_unit", "unit", "单位"],
        "gross_weight_kg": ["gross_weight", "gross_weight_kg", "毛重"],
        "net_weight_kg": ["net_weight", "net_weight_kg", "净重"],
        "volume_cbm": ["volume_cbm", "volume", "体积", "立方"],
        # Container & transport
        "container_no": ["container_no", "container", "集装箱号", "箱号"],
        "container_type": ["container_type", "箱型"],
        "bl_no": ["bl_no", "b_l_no", "bill_of_lading", "提单号"],
        "voyage_no": ["voyage_no", "voyage", "航次", "航次号"],
        # Value
        "declared_value": ["declared_value", "value", "金额", "货值", "申报价值"],
        "currency": ["currency", "币种", "货币"],
        # Other
        "marks": ["marks", "shipping_marks", "唛头"],
        "remarks": ["remarks", "notes", "备注"],
        "shipment_type": ["shipment_type", "运输方式", "装运方式"],
        "incoterm": ["incoterm", "贸易条款"],
        "freight_prepaid": ["freight_prepaid", "运费预付"],
    }

    def __init__(self, db: AsyncSession, tenant_id: str, created_by: str):
        self.db = db
        self.tenant_id = tenant_id
        self.created_by = created_by

    async def import_csv(
        self,
        file_content: bytes,
        source_channel: str = "manual_csv",
        source_ref: Optional[str] = None,
    ) -> Dict:
        """
        Import shipments from CSV file

        Args:
            file_content: CSV file bytes
            source_channel: Source channel identifier
            source_ref: Original file name or reference

        Returns:
            Dict with import stats
        """
        run = IntelAdapterRun(
            tenant_id=self.tenant_id,
            status="running",
            run_metadata={
                "source_channel": source_channel,
                "source_ref": source_ref,
                "import_type": "csv",
            },
        )
        self.db.add(run)
        await self.db.flush()

        try:
            # Parse CSV
            text_content = file_content.decode("utf-8-sig")  # Handle BOM
            reader = csv.DictReader(io.StringIO(text_content))

            # Detect column mapping
            headers = reader.fieldnames or []
            column_map = self._detect_columns(headers)

            logger.info("csv_column_mapping_detected", mapping=column_map)

            # Import rows
            inserted = 0
            errors = []

            for row_num, row in enumerate(reader, start=2):  # Skip header
                try:
                    shipment_data = self._map_row_to_shipment(row, column_map)
                    if shipment_data:
                        shipment = IntelShipment(
                            tenant_id=self.tenant_id,
                            source_channel=source_channel,
                            source_ref=source_ref,
                            created_by=self.created_by,
                            **shipment_data,
                        )
                        self.db.add(shipment)
                        inserted += 1

                except Exception as e:
                    error_msg = f"Row {row_num}: {str(e)}"
                    errors.append(error_msg)
                    logger.warning("csv_row_import_error", row=row_num, error=str(e))

            await self.db.flush()

            # Update run record
            run.status = "success" if not errors else "success"  # Partial success is still success
            run.items_processed = inserted + len(errors)
            run.items_inserted = inserted
            run.error_message = "\n".join(errors) if errors else None
            run.finished_at = datetime.utcnow()
            await self.db.flush()

            return {
                "status": "success",
                "processed": inserted + len(errors),
                "inserted": inserted,
                "errors": len(errors),
                "error_details": errors[:10],  # Return first 10 errors
            }

        except Exception as e:
            run.status = "failed"
            run.error_message = str(e)
            run.finished_at = datetime.utcnow()
            await self.db.flush()

            logger.error("csv_import_failed", error=str(e))

            return {
                "status": "failed",
                "error": str(e),
            }

    def _detect_columns(self, headers: List[str]) -> Dict[str, str]:
        """
        Detect which CSV column maps to which shipment field

        Returns:
            Dict mapping shipment field name -> CSV column name
        """
        column_map = {}
        headers_lower = {h.lower().strip(): h for h in headers}

        for field, possible_names in self.COLUMN_MAPPING.items():
            for name in possible_names:
                if name.lower() in headers_lower:
                    column_map[field] = headers_lower[name.lower()]
                    break

        return column_map

    def _map_row_to_shipment(self, row: Dict, column_map: Dict[str, str]) -> Optional[Dict]:
        """
        Map a CSV row to shipment data dict

        Returns:
            Dict of shipment fields, or None if invalid
        """
        data = {}

        for field, csv_column in column_map.items():
            value = row.get(csv_column, "").strip()
            if not value:
                continue

            # Type conversions
            if field == "ship_date":
                data[field] = self._parse_date(value)
            elif field in ["qty", "gross_weight_kg", "net_weight_kg", "volume_cbm", "declared_value"]:
                data[field] = self._parse_number(value)
            elif field == "freight_prepaid":
                data[field] = self._parse_boolean(value)
            else:
                data[field] = value

        # Required fields check
        if "shipper" not in data or "consignee" not in data or "product_desc" not in data:
            return None

        return data

    def _parse_date(self, value: str) -> Optional[datetime]:
        """Parse date string to datetime"""
        formats = ["%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y", "%Y-%m-%d %H:%M:%S"]
        for fmt in formats:
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                continue
        return None

    def _parse_number(self, value: str) -> Optional[float]:
        """Parse number string to float"""
        try:
            # Remove commas and currency symbols
            cleaned = value.replace(",", "").replace("$", "").replace("¥", "").strip()
            return float(cleaned)
        except ValueError:
            return None

    def _parse_boolean(self, value: str) -> Optional[bool]:
        """Parse boolean string"""
        value_lower = value.lower()
        if value_lower in ["yes", "true", "1", "prepaid", "y"]:
            return True
        elif value_lower in ["no", "false", "0", "collect", "n"]:
            return False
        return None
