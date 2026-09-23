"""阶段 6 · business_events 事件流测试（11 类型）。

验证三处登记一致、每类载荷拒绝空对象、ORM 模型与迁移对齐。
不需要数据库（unit 档）。
"""
import pytest
from pydantic import ValidationError

from app.api.schema_registry import VALID_EVENT_TYPES
from app.db.models import BusinessEvent
from app.domain.schema_registry import PAYLOAD_SCHEMAS as DOMAIN_SCHEMAS

pytestmark = pytest.mark.unit

ALL_EVENT_TYPES = {
    "capability.update",
    "audit.access",
    "market.selected",
    "lead.discovered",
    "lead.enriched",
    "lead.outreach_ready",
    "outreach.sent",
    "outreach.replied",
    "quotation.converted",
    "order.shipped",
    "shipment.documented",
}


def test_domain_registry_covers_all_11_types():
    assert set(DOMAIN_SCHEMAS) == ALL_EVENT_TYPES


def test_api_valid_event_types_covers_all_11_types():
    assert set(VALID_EVENT_TYPES) == ALL_EVENT_TYPES


def test_business_event_model_matches_migration():
    assert BusinessEvent.__tablename__ == "business_events"
    columns = {c.name for c in BusinessEvent.__table__.columns}
    assert columns == {
        "id",
        "tenant_id",
        "event_type",
        "from_workstation",
        "to_workstation",
        "payload",
        "actor_id",
        "created_at",
    }


@pytest.mark.parametrize("event_type", sorted(ALL_EVENT_TYPES))
def test_payload_rejects_empty_object(event_type):
    with pytest.raises(ValidationError):
        DOMAIN_SCHEMAS[event_type].model_validate({})


def test_migration_has_reversible_downgrade():
    from pathlib import Path

    mig = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "202609230006_create_business_events.py"
    assert mig.exists()
    text = mig.read_text(encoding="utf-8")
    assert "def upgrade" in text
    assert "def downgrade" in text
    assert "drop_table" in text
