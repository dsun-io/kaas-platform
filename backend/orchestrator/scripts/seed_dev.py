"""seed_dev.py — INT-R3 种子数据（幂等 INSERT，可重复运行）"""
import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone

from app.db.session import async_session_factory
from app.db.models import (
    CustomerCapability, Quotation, Event,
    ProductSpec, CustomerCostItem, CustomerSalePriceItem,
    CustomerPricingProfile, CustomerFreightRate,
)
from app.repositories.capabilities_repo import upsert_capability
from app.repositories.events import insert_event
from app.repositories.quotations_repo import insert_quotation


def _spec_hash(spec: dict) -> str:
    raw = json.dumps(spec, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ── INT-R3: 平台通用规格 ──
PRODUCT_SPECS = [
    # 牛栏网 - 上疏下密
    {"product_category": "牛栏网", "product_type": "上疏下密", "wire_diameter": "2.0x1.8", "height": 1.5, "mesh_width": 15, "roll_length": 50, "weight_kg": 26.0, "spec_hash": "nlw_ssxm_20x18_15_15_50"},
    {"product_category": "牛栏网", "product_type": "上疏下密", "wire_diameter": "2.0x1.8", "height": 1.8, "mesh_width": 15, "roll_length": 50, "weight_kg": 31.2, "spec_hash": "nlw_ssxm_20x18_18_15_50"},
    {"product_category": "牛栏网", "product_type": "上疏下密", "wire_diameter": "2.5x2.0", "height": 1.5, "mesh_width": 15, "roll_length": 50, "weight_kg": 32.5, "spec_hash": "nlw_ssxm_25x20_15_15_50"},
    {"product_category": "牛栏网", "product_type": "上疏下密", "wire_diameter": "2.5x2.0", "height": 1.8, "mesh_width": 15, "roll_length": 50, "weight_kg": 39.0, "spec_hash": "nlw_ssxm_25x20_18_15_50"},
    # 牛栏网 - 环扣
    {"product_category": "牛栏网", "product_type": "环扣", "wire_diameter": "2.0x1.8", "height": 1.5, "mesh_width": 15, "roll_length": 50, "weight_kg": 24.0, "spec_hash": "nlw_hk_20x18_15_15_50"},
    {"product_category": "牛栏网", "product_type": "环扣", "wire_diameter": "2.5x2.0", "height": 1.8, "mesh_width": 15, "roll_length": 50, "weight_kg": 36.0, "spec_hash": "nlw_hk_25x20_18_15_50"},
    # 立柱
    {"product_category": "立柱", "product_type": "直边", "height": 1.5, "bundle_size": 10, "weight_kg": 18.5, "spec_hash": "post_straight_15_10"},
    {"product_category": "立柱", "product_type": "直边", "height": 1.8, "bundle_size": 10, "weight_kg": 22.0, "spec_hash": "post_straight_18_10"},
    {"product_category": "立柱", "product_type": "直边", "height": 2.0, "bundle_size": 10, "weight_kg": 25.0, "spec_hash": "post_straight_20_10"},
    {"product_category": "立柱", "product_type": "花边", "height": 1.5, "bundle_size": 10, "weight_kg": 20.0, "spec_hash": "post_deco_15_10"},
    {"product_category": "立柱", "product_type": "花边", "height": 1.8, "bundle_size": 10, "weight_kg": 24.0, "spec_hash": "post_deco_18_10"},
]

# ── INT-R3: 客户私有成本价 ──
CUSTOMER_COST_ITEMS = [
    # liankai 牛栏网成本
    {"tenant_id": "liankai", "customer_id": "liankai", "product_category": "牛栏网", "spec_hash": "nlw_ssxm_20x18_15_15_50", "cost_type": "cost_per_kg", "amount": 4.82, "unit": "kg", "source": "seed"},
    {"tenant_id": "liankai", "customer_id": "liankai", "product_category": "牛栏网", "spec_hash": "nlw_ssxm_20x18_18_15_50", "cost_type": "cost_per_kg", "amount": 4.82, "unit": "kg", "source": "seed"},
    {"tenant_id": "liankai", "customer_id": "liankai", "product_category": "牛栏网", "spec_hash": "nlw_ssxm_25x20_15_15_50", "cost_type": "cost_per_kg", "amount": 5.10, "unit": "kg", "source": "seed"},
    # client_b 牛栏网成本不同（隔离测试）
    {"tenant_id": "client_b", "customer_id": "client_b", "product_category": "牛栏网", "spec_hash": "nlw_ssxm_20x18_15_15_50", "cost_type": "cost_per_kg", "amount": 5.50, "unit": "kg", "source": "seed"},
    # 立柱成本
    {"tenant_id": "liankai", "customer_id": "liankai", "product_category": "立柱", "spec_hash": "post_straight_18_10", "cost_type": "cost_per_bundle", "amount": 180.0, "unit": "捆", "source": "seed"},
    {"tenant_id": "liankai", "customer_id": "liankai", "product_category": "立柱", "spec_hash": "post_straight_20_10", "cost_type": "cost_per_bundle", "amount": 210.0, "unit": "捆", "source": "seed"},
]

# ── INT-R3: 客户私有销售价覆盖 ──
CUSTOMER_SALE_PRICES = [
    # client_b 有销售价覆盖（优先于成本+利润率）
    {"tenant_id": "client_b", "customer_id": "client_b", "product_category": "牛栏网", "spec_hash": "nlw_ssxm_20x18_15_15_50", "sale_price_type": "sale_per_roll", "amount": 165.0, "unit": "卷", "source": "seed"},
]

# ── INT-R3: 客户私有报价策略 ──
CUSTOMER_PRICING_PROFILES = [
    {"tenant_id": "liankai", "customer_id": "liankai", "product_category": "牛栏网", "profile_name": "default", "low_margin_rate": 1.10, "standard_margin_rate": 1.15, "high_margin_rate": 1.20, "tax_rate": 0.0, "source": "seed"},
    {"tenant_id": "client_b", "customer_id": "client_b", "product_category": "牛栏网", "profile_name": "default", "low_margin_rate": 1.08, "standard_margin_rate": 1.12, "high_margin_rate": 1.18, "tax_rate": 0.0, "source": "seed"},
]

# ── INT-R3: 客户私有运费表 ──
CUSTOMER_FREIGHT_RATES = [
    {"tenant_id": "liankai", "customer_id": "liankai", "carrier": "顺丰干配", "province": "四川", "formula_type": "base_plus_weight", "base_fee": 180.0, "threshold_kg": 50, "per_kg_after_threshold": 1.5, "min_weight_kg": 10, "source": "seed"},
    {"tenant_id": "liankai", "customer_id": "liankai", "carrier": "顺丰零担", "province": "四川", "formula_type": "per_kg", "per_kg_after_threshold": 2.0, "source": "seed"},
    {"tenant_id": "liankai", "customer_id": "liankai", "carrier": "圆通", "province": "河南", "formula_type": "base_plus_weight", "base_fee": 120.0, "threshold_kg": 30, "per_kg_after_threshold": 1.2, "min_weight_kg": 10, "source": "seed"},
    # client_b 四川运费不同（隔离测试）
    {"tenant_id": "client_b", "customer_id": "client_b", "carrier": "京东物流", "province": "四川", "formula_type": "base_plus_weight", "base_fee": 200.0, "threshold_kg": 50, "per_kg_after_threshold": 1.8, "min_weight_kg": 10, "source": "seed"},
]

# ── INT-R2 遗留数据 ──
SEED_CAPABILITIES = [
    {"customer_id": "liankai", "customer_name": "联凯五金", "product_category": "牛栏网", "spec_constraints": {"material": ["热镀锌", "冷镀锌"], "wire_diameter": [2.0, 2.5, 3.0], "height": [1.0, 1.2, 1.5, 1.8, 2.0]}},
    {"customer_id": "liankai", "customer_name": "联凯五金", "product_category": "立柱", "spec_constraints": {"material": ["热镀锌"], "height": [1.5, 1.8, 2.0, 2.5]}},
    {"customer_id": "client_b", "customer_name": "B 客户", "product_category": "钢板网", "spec_constraints": {"material": ["冷轧板", "热轧板"], "thickness": [0.5, 0.8, 1.0]}},
]

SEED_QUOTATIONS = [
    {"customer_id": "liankai", "product_category": "牛栏网", "product_spec": {"material": "热镀锌", "wire_diameter": 2.5, "height": 1.8, "mesh": "50x100"}, "unit_price": 5.20, "source": "manual", "notes": "基准报价"},
    {"customer_id": "liankai", "product_category": "牛栏网", "product_spec": {"material": "冷镀锌", "wire_diameter": 2.0, "height": 1.5, "mesh": "50x100"}, "unit_price": 4.30, "source": "manual", "notes": "冷镀锌常规"},
    {"customer_id": "liankai", "product_category": "立柱", "product_spec": {"material": "热镀锌", "height": 1.8}, "unit_price": 35.00, "source": "manual", "notes": "立柱标准价"},
    {"customer_id": "client_b", "product_category": "钢板网", "product_spec": {"material": "冷轧板", "thickness": 0.8}, "unit_price": 28.50, "source": "manual", "notes": "钢板网基准"},
    {"customer_id": "liankai", "product_category": "牛栏网", "product_spec": {"material": "热镀锌", "wire_diameter": 2.5, "height": 1.8, "mesh": "50x100"}, "unit_price": 5.50, "source": "manual", "notes": "调价场景（+1day）", "effective_from_offset_days": 1},
]

SEED_EVENTS = [
    {"tenant_id": "liankai", "event_type": "chat.turn", "schema_version": 1, "event_source": "kaas-web", "payload": {"message": "测试对话轮次", "model": "gpt-4o"}, "sampled": True},
    {"tenant_id": "liankai", "event_type": "quote.request", "schema_version": 1, "event_source": "kaas-web", "payload": {"customer_id": "liankai", "product_category": "牛栏网"}, "sampled": True},
    {"tenant_id": "client_b", "event_type": "audit.access", "schema_version": 1, "event_source": "kaas-admin", "payload": {"action": "page_view", "target": "/quotations"}, "sampled": True},
]


async def _seed_product_specs(session):
    print("Seeding product_specs …")
    for s in PRODUCT_SPECS:
        existing = await session.execute(
            __import__("sqlalchemy").select(ProductSpec).where(ProductSpec.spec_hash == s["spec_hash"])
        )
        if existing.scalar_one_or_none():
            continue
        spec = ProductSpec(**s)
        session.add(spec)
        print(f"  {s['product_category']}/{s['product_type']} {s.get('wire_diameter','')} {s.get('height','')}")


async def _seed_cost_items(session):
    print("\nSeeding customer_cost_items …")
    for c in CUSTOMER_COST_ITEMS:
        item = CustomerCostItem(**c)
        session.add(item)
        print(f"  {c['tenant_id']}/{c['product_category']} ¥{c['amount']}/{c['unit']}")


async def _seed_sale_prices(session):
    print("\nSeeding customer_sale_price_items …")
    for s in CUSTOMER_SALE_PRICES:
        item = CustomerSalePriceItem(**s)
        session.add(item)
        print(f"  {s['tenant_id']}/{s['product_category']} ¥{s['amount']}/{s['unit']}")


async def _seed_pricing_profiles(session):
    print("\nSeeding customer_pricing_profiles …")
    for p in CUSTOMER_PRICING_PROFILES:
        profile = CustomerPricingProfile(**p)
        session.add(profile)
        print(f"  {p['tenant_id']}/{p['product_category']} margins: {p['low_margin_rate']}/{p['standard_margin_rate']}/{p['high_margin_rate']}")


async def _seed_freight_rates(session):
    print("\nSeeding customer_freight_rates …")
    for f in CUSTOMER_FREIGHT_RATES:
        rate = CustomerFreightRate(**f)
        session.add(rate)
        print(f"  {f['tenant_id']}/{f['province']} - {f['carrier']}")


async def seed():
    async with async_session_factory() as session:
        # ── INT-R3: 平台规格 ──
        await _seed_product_specs(session)

        # ── INT-R3: 客户私有数据 ──
        await _seed_cost_items(session)
        await _seed_sale_prices(session)
        await _seed_pricing_profiles(session)
        await _seed_freight_rates(session)

        # ── Capabilities ──
        print("\nSeeding capabilities …")
        for c in SEED_CAPABILITIES:
            cap = await upsert_capability(
                session=session, customer_id=c["customer_id"], customer_name=c["customer_name"],
                product_category=c["product_category"], spec_constraints=c["spec_constraints"],
            )
            print(f"  {cap.customer_id}/{cap.product_category}")

        # ── Quotations ──
        print("\nSeeding quotations …")
        for q in SEED_QUOTATIONS:
            spec_hash = _spec_hash(q["product_spec"])
            effective_from = datetime.now(timezone.utc) + timedelta(days=q.get("effective_from_offset_days", 0))
            ins = await insert_quotation(
                session=session, customer_id=q["customer_id"],
                product_category=q["product_category"], product_spec=q["product_spec"],
                spec_hash=spec_hash, unit_price=q["unit_price"], currency="CNY",
                unit="平方米", discount=None, min_quantity=None,
                source=q["source"], notes=q["notes"], created_by="seed_dev",
            )
            if q.get("effective_from_offset_days"):
                ins.effective_from = effective_from
            print(f"  {q['customer_id']}/{q['product_category']} ¥{q['unit_price']}")

        # ── Events ──
        print("\nSeeding events …")
        for e in SEED_EVENTS:
            ev = await insert_event(
                session=session, tenant_id=e["tenant_id"], trace_id=None,
                event_type=e["event_type"], schema_version=e["schema_version"],
                event_source=e["event_source"], payload=e["payload"], sampled=e["sampled"],
            )
            print(f"  {ev.tenant_id}/{ev.event_type}")

        await session.commit()
        print(f"\nINT-R3 seed complete: {len(PRODUCT_SPECS)} specs + {len(CUSTOMER_COST_ITEMS)} cost items + "
              f"{len(CUSTOMER_SALE_PRICES)} sale prices + {len(CUSTOMER_PRICING_PROFILES)} profiles + "
              f"{len(CUSTOMER_FREIGHT_RATES)} freight rates + "
              f"{len(SEED_CAPABILITIES)} capas + {len(SEED_QUOTATIONS)} quotes + {len(SEED_EVENTS)} events")


if __name__ == "__main__":
    asyncio.run(seed())
