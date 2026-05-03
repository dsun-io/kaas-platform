"""seed_dev.py — 插入开发用种子数据（幂等）"""
import asyncio
from app.db.session import async_session_factory
from app.db.models import CustomerCapability
from app.repositories.capabilities_repo import upsert_capability

SEED_CAPABILITIES = [
    {
        "customer_id": "C001",
        "customer_name": "联凯工地A",
        "product_category": "牛栏网",
        "spec_constraints": {"mesh": "50x50-100x100", "wire": "2.0-4.0"},
        "notes": "常用规格",
    },
    {
        "customer_id": "C001",
        "customer_name": "联凯工地A",
        "product_category": "石笼网",
        "spec_constraints": {"mesh": "80x100-120x150", "wire": "2.5-3.5"},
        "notes": "河道工程用",
    },
    {
        "customer_id": "C002",
        "customer_name": "演示客户",
        "product_category": "牛栏网",
        "spec_constraints": {"mesh": "50x50", "wire": "2.5"},
        "notes": "单一规格",
    },
]


async def seed():
    async with async_session_factory() as session:
        for c in SEED_CAPABILITIES:
            cap = await upsert_capability(
                session=session,
                customer_id=c["customer_id"],
                customer_name=c["customer_name"],
                product_category=c["product_category"],
                spec_constraints=c["spec_constraints"],
                notes=c.get("notes"),
            )
            print(f"  Upserted capability: {cap.customer_id}/{cap.product_category}")

        await session.commit()
        print(f"Seeded {len(SEED_CAPABILITIES)} capabilities")


if __name__ == "__main__":
    asyncio.run(seed())
