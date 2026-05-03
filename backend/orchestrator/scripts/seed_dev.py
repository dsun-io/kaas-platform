"""seed_dev.py — INT-R2 种子数据（幂等 INSERT，可重复运行）"""
import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone

from app.db.session import async_session_factory
from app.db.models import CustomerCapability, Quotation, Event
from app.repositories.capabilities_repo import upsert_capability
from app.repositories.events import insert_event
from app.repositories.quotations_repo import insert_quotation


def _spec_hash(spec: dict) -> str:
    raw = json.dumps(spec, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


SEED_CAPABILITIES = [
    {
        "customer_id": "liankai",
        "customer_name": "联凯五金",
        "product_category": "牛栏网",
        "spec_constraints": {
            "material": ["热镀锌", "冷镀锌"],
            "wire_diameter": [2.0, 2.5, 3.0],
            "height": [1.0, 1.2, 1.5, 1.8, 2.0],
        },
    },
    {
        "customer_id": "liankai",
        "customer_name": "联凯五金",
        "product_category": "立柱",
        "spec_constraints": {
            "material": ["热镀锌"],
            "height": [1.5, 1.8, 2.0, 2.5],
        },
    },
    {
        "customer_id": "client_b",
        "customer_name": "B 客户",
        "product_category": "钢板网",
        "spec_constraints": {
            "material": ["冷轧板", "热轧板"],
            "thickness": [0.5, 0.8, 1.0],
        },
    },
]

SEED_QUOTATIONS = [
    {
        "customer_id": "liankai",
        "product_category": "牛栏网",
        "product_spec": {"material": "热镀锌", "wire_diameter": 2.5, "height": 1.8, "mesh": "50x100"},
        "unit_price": 5.20,
        "source": "manual",
        "notes": "基准报价",
    },
    {
        "customer_id": "liankai",
        "product_category": "牛栏网",
        "product_spec": {"material": "冷镀锌", "wire_diameter": 2.0, "height": 1.5, "mesh": "50x100"},
        "unit_price": 4.30,
        "source": "manual",
        "notes": "冷镀锌常规",
    },
    {
        "customer_id": "liankai",
        "product_category": "立柱",
        "product_spec": {"material": "热镀锌", "height": 1.8},
        "unit_price": 35.00,
        "source": "manual",
        "notes": "立柱标准价",
    },
    {
        "customer_id": "client_b",
        "product_category": "钢板网",
        "product_spec": {"material": "冷轧板", "thickness": 0.8},
        "unit_price": 28.50,
        "source": "manual",
        "notes": "钢板网基准",
    },
    {
        "customer_id": "liankai",
        "product_category": "牛栏网",
        "product_spec": {"material": "热镀锌", "wire_diameter": 2.5, "height": 1.8, "mesh": "50x100"},
        "unit_price": 5.50,
        "source": "manual",
        "notes": "调价场景（+1day）",
        "effective_from_offset_days": 1,
    },
]

SEED_EVENTS = [
    {
        "tenant_id": "liankai",
        "event_type": "chat.turn",
        "schema_version": 1,
        "event_source": "kaas-web",
        "payload": {"message": "测试对话轮次", "model": "gpt-4o"},
        "sampled": True,
    },
    {
        "tenant_id": "liankai",
        "event_type": "quote.request",
        "schema_version": 1,
        "event_source": "kaas-web",
        "payload": {"customer_id": "liankai", "product_category": "牛栏网"},
        "sampled": True,
    },
    {
        "tenant_id": "client_b",
        "event_type": "audit.access",
        "schema_version": 1,
        "event_source": "kaas-admin",
        "payload": {"action": "page_view", "target": "/quotations"},
        "sampled": True,
    },
]


async def seed():
    async with async_session_factory() as session:
        # ── Capabilities ──
        print("Seeding capabilities …")
        for c in SEED_CAPABILITIES:
            cap = await upsert_capability(
                session=session,
                customer_id=c["customer_id"],
                customer_name=c["customer_name"],
                product_category=c["product_category"],
                spec_constraints=c["spec_constraints"],
            )
            print(f"  {cap.customer_id}/{cap.product_category}")

        # ── Quotations ──
        print("\nSeeding quotations …")
        for q in SEED_QUOTATIONS:
            spec_hash = _spec_hash(q["product_spec"])
            effective_from = datetime.now(timezone.utc) + timedelta(
                days=q.get("effective_from_offset_days", 0)
            )
            ins = await insert_quotation(
                session=session,
                customer_id=q["customer_id"],
                product_category=q["product_category"],
                product_spec=q["product_spec"],
                spec_hash=spec_hash,
                unit_price=q["unit_price"],
                currency="CNY",
                unit="平方米",
                discount=None,
                min_quantity=None,
                source=q["source"],
                notes=q["notes"],
                created_by="seed_dev",
            )
            # Override effective_from if needed
            if q.get("effective_from_offset_days"):
                ins.effective_from = effective_from
            print(f"  {q['customer_id']}/{q['product_category']} ¥{q['unit_price']}")

        # ── Events ──
        print("\nSeeding events …")
        for e in SEED_EVENTS:
            ev = await insert_event(
                session=session,
                tenant_id=e["tenant_id"],
                trace_id=None,
                event_type=e["event_type"],
                schema_version=e["schema_version"],
                event_source=e["event_source"],
                payload=e["payload"],
                sampled=e["sampled"],
            )
            print(f"  {ev.tenant_id}/{ev.event_type}")

        await session.commit()
        print(f"\nDone. Seeded {len(SEED_CAPABILITIES)} capabilities + {len(SEED_QUOTATIONS)} quotations + {len(SEED_EVENTS)} events")


if __name__ == "__main__":
    asyncio.run(seed())
