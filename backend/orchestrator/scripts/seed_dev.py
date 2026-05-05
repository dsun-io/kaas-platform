"""seed_dev.py — INT-R3 种子数据（真实数据来源：Notion 联佳—知识库 2026-04-12）

数据覆盖：
  - 牛栏网：上疏下密 2.0×1.8 / 1.8×1.8 / 2.2mm / 2.5mm，环扣 2.0×1.8
  - 立柱：Y型直边 / Y型花边，各 7 个高度
  - 顺丰零担 / 顺丰干配 全国运费表
  - 联佳丝网定价策略（margin: 10%/15%/20%）
幂等 INSERT，可重复运行。
"""
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


# ════════════════════════════════════════════════════════════════
# 1. Product Specs — 牛栏网 上疏下密 2.0×1.8（普通款）
#    来源：Notion 牛栏网 → 丝径 2.0×1.8 — 标准规格卷重速查
#    公式：卷重(kg) × 单价(元/kg) = 每卷成本
#    成本价：4.6 元/kg（Notion 确认）
#    列头格式：mesh_width/roll_length
# ════════════════════════════════════════════════════════════════
_SSXM_20x18_COLS = [  # (mesh_width, roll_length)
    (5, 30), (10, 50), (15, 50), (15, 100), (20, 50), (20, 100), (25, 50), (25, 100)
]
_SSXM_20x18_DATA = {  # height -> [weight] 对应各列, None = 无此规格
    1.0:  [24.5, 25,   19,   38.5, 16.5, 33,   15,   30],
    1.2:  [31,   30.5, 23.5, 47,   20,   40,   18,   36.5],
    1.5:  [35,   33.5, 26,   52,   21.5, 43.5, 19.5, 39],
    1.65: [40,   39,   30,   None, 25.5, 51,   23,   46],
    1.8:  [42,   41,   31,   None, None, 53,   23.5, 47],
}

# 牛栏网 上疏下密 1.8×1.8 — 列: 10/50, 15/50, 15/100, 20/50, 20/100, 25/50, 25/100
_SSXM_18x18_COLS = [(10, 50), (15, 50), (15, 100), (20, 50), (20, 100), (25, 50), (25, 100)]
_SSXM_18x18_DATA = {
    # Notion 确认 2026-04-12: 10/50 列 1.65m=34kg, 1.8m=35.5kg
    1.0:  [22,   None, 35,   None, 30,   None, 27],
    1.2:  [26.5, None, 42,   None, 36,   None, 33],
    1.5:  [29,   None, 46,   None, 39,   None, 35],
    1.65: [34,   27,   None, None, 46,   None, 42],
    1.8:  [35.5, 28,   None, 24,   None, 21.5, None],
}

# 牛栏网 上疏下密 2.2mm — 列: 10/30, 15/50
_SSXM_22_COLS = [(10, 30), (15, 50)]
_SSXM_22_DATA = {
    1.2: [21, 28.5],
    1.5: [23, 30.5],
}

# 牛栏网 上疏下密 2.5mm — 列: 10/30, 15/30, 20/50, 25/50
_SSXM_25_COLS = [(10, 30), (15, 30), (20, 50), (25, 50)]
_SSXM_25_DATA = {
    1.0:  [24,   19,   27.5, 25],
    1.2:  [29.5, 23.5, 34,   31],
    1.5:  [32,   25.5, 36.5, 33],
    1.65: [37.5, 29.5, 43,   39],
}

# 牛栏网 环扣（鹿网）2.0×1.8 — 列: 10/30, 15/50, 25/50
_HK_20x18_COLS = [(10, 30), (15, 50), (25, 50)]
_HK_20x18_DATA = {
    1.25: [20, 24.5, 20],
    1.5:  [24.5, 31, 23],
    1.8:  [27, 36, None],
}


def _build_ssxm_specs(wd, cols, data, ptype="上疏下密"):
    """从数据矩阵构建 ProductSpec 列表。"""
    ptype_code = "ssxm" if ptype == "上疏下密" else ptype[:2]
    specs = []
    for h, weights in data.items():
        for (mw, rl), w in zip(cols, weights):
            if w is None:
                continue
            wd_clean = wd.replace("×", "x").replace(".", "")
            spec_hash = f"nlw_{ptype_code}_{wd_clean}_{int(mw)}_{int(h*10)}_{int(rl)}"
            specs.append({
                "product_category": "牛栏网",
                "product_type": ptype,
                "wire_diameter": wd,
                "height": h,
                "mesh_width": float(mw),
                "roll_length": float(rl),
                "weight_kg": w,
                "spec_hash": spec_hash,
            })
    return specs


def _build_hk_specs():
    """构建环扣（鹿网）ProductSpec 列表。"""
    specs = []
    for h, weights in _HK_20x18_DATA.items():
        for (mw, rl), w in zip(_HK_20x18_COLS, weights):
            if w is None:
                continue
            spec_hash = f"nlw_hk_20x18_{int(mw)}_{int(h*10)}_{int(rl)}"
            specs.append({
                "product_category": "牛栏网",
                "product_type": "环扣",
                "wire_diameter": "2.0x1.8",
                "height": h,
                "mesh_width": float(mw),
                "roll_length": float(rl),
                "weight_kg": w,
                "spec_hash": spec_hash,
            })
    return specs


# ── ProductSpec 种子数据 ──
# 当前 scope = 联佳产品线（牛栏网 4 种丝径 + 环扣鹿网 + 立柱直边/花边）
# 未来扩展：勾花网、石笼网等需按相同矩阵模式追加
PRODUCT_SPECS = []
# 上疏下密 2.0×1.8（主销）
PRODUCT_SPECS.extend(_build_ssxm_specs("2.0x1.8", _SSXM_20x18_COLS, _SSXM_20x18_DATA))
# 上疏下密 1.8×1.8
PRODUCT_SPECS.extend(_build_ssxm_specs("1.8x1.8", _SSXM_18x18_COLS, _SSXM_18x18_DATA))
# 上疏下密 2.2mm
PRODUCT_SPECS.extend(_build_ssxm_specs("2.2", _SSXM_22_COLS, _SSXM_22_DATA))
# 上疏下密 2.5mm
PRODUCT_SPECS.extend(_build_ssxm_specs("2.5", _SSXM_25_COLS, _SSXM_25_DATA))
# 环扣 2.0×1.8（鹿网）
PRODUCT_SPECS.extend(_build_hk_specs())

# ── 立柱 ProductSpec（来源：Notion 立柱页 Y型直边 / Y型花边）──
# 数据格式：(产品类型, 高度m, 进价元/根, bundle_size, 5根重kg, 10根重kg)
POST_DATA = {
    "直边": [
        (1.3, 4.6, 5.2, 10.4),
        (1.5, 5.3, 6.0, 12.0),
        (1.7, 6.0, 6.8, 13.6),
        (1.8, 6.3, 7.2, 14.4),
        (2.0, 7.0, 8.0, 16.0),
        (2.3, 8.0, 9.2, 18.4),
        (2.5, 8.8, 10.0, 20.0),
    ],
    "花边": [
        (1.3, 7.4, 7.15, 14.3),
        (1.5, 7.4, 8.25, 16.5),
        (1.7, 8.4, 9.35, 18.7),
        (1.8, 8.9, 9.9, 19.8),
        (2.0, 9.8, 11.0, 22.0),
        (2.3, 11.3, 12.65, 25.3),
        (2.5, 12.2, 13.75, 27.5),
    ],
}

for ptype, rows in POST_DATA.items():
    for h, cost, w5, w10 in rows:
        type_short = "straight" if ptype == "直边" else "deco"
        spec_hash = f"post_{type_short}_{int(h*10)}_10"
        # 柱顶按 bundle_size=10 记录重量
        PRODUCT_SPECS.append({
            "product_category": "立柱",
            "product_type": ptype,
            "height": h,
            "bundle_size": 10,
            "weight_kg": w10,  # 10 根总重
            "spec_hash": spec_hash,
        })


# ════════════════════════════════════════════════════════════════
# 2. Customer Cost Items — 客户私有成本价
#    来源：Notion 联佳—知识库
#    - 牛栏网 2.0×1.8: 4.6 元/kg ✓
#    - 牛栏网 1.8×1.8: 4.7 元/kg ✓
#    - 牛栏网 2.2/2.5mm: pending_review（Notion 无明确成本数据）
#    - 立柱：见 POST_DATA 进价列 ✓
# ════════════════════════════════════════════════════════════════
CUSTOMER_COST_ITEMS = []

# 牛栏网成本（按丝径 × 元/kg）
COST_PER_KG = {
    "2.0x1.8": 4.6,
    "1.8x1.8": 4.7,
}
for wd, ckg in COST_PER_KG.items():
    # 找到匹配该丝径的所有 spec_hash
    for spec in PRODUCT_SPECS:
        if spec["product_category"] != "牛栏网":
            continue
        if spec["wire_diameter"] == wd:
            CUSTOMER_COST_ITEMS.append({
                "tenant_id": "lianjia",
                "customer_id": "lianjia",
                "product_category": "牛栏网",
                "spec_hash": spec["spec_hash"],
                "cost_type": "cost_per_kg",
                "amount": ckg,
                "unit": "kg",
                "source": "notion:lianjai_knowledge_base",
                "notes": f"Notion 确认: {wd} {ckg}元/kg",
            })

# 立柱成本（按根计价）
for ptype, rows in POST_DATA.items():
    type_short = "straight" if ptype == "直边" else "deco"
    for h, cost, _, _ in rows:
        spec_hash = f"post_{type_short}_{int(h*10)}_10"
        CUSTOMER_COST_ITEMS.append({
            "tenant_id": "lianjia",
            "customer_id": "lianjia",
            "product_category": "立柱",
            "spec_hash": spec_hash,
            "cost_type": "cost_per_item",
            "amount": cost,
            "unit": "根",
            "source": "notion:lianjai_knowledge_base",
            "notes": f"Y型{ptype} {h}m 进价 {cost}元/根",
        })


# ════════════════════════════════════════════════════════════════
# 3. Customer Pricing Profiles — 报价策略
#    保持原有 margin 合理值，Notion 确认报价默认不含税
# ════════════════════════════════════════════════════════════════
CUSTOMER_PRICING_PROFILES = [
    {
        "tenant_id": "lianjia", "customer_id": "lianjia",
        "product_category": "牛栏网", "profile_name": "default",
        "low_margin_rate": 1.10,
        "standard_margin_rate": 1.15,
        "high_margin_rate": 1.20,
        "tax_rate": 0.03,  # Notion：报价默认不含税，开票加 3 个税点
        "source": "notion:lianjai_knowledge_base",
    },
    {
        "tenant_id": "lianjia", "customer_id": "lianjia",
        "product_category": "立柱", "profile_name": "default",
        "low_margin_rate": 1.10,
        "standard_margin_rate": 1.15,
        "high_margin_rate": 1.20,
        "tax_rate": 0.03,
        "source": "notion:lianjai_knowledge_base",
    },
    {
        "tenant_id": "client_b", "customer_id": "client_b",
        "product_category": "牛栏网", "profile_name": "default",
        "low_margin_rate": 1.08,
        "standard_margin_rate": 1.12,
        "high_margin_rate": 1.18,
        "tax_rate": 0.0,
        "source": "seed",
    },
]


# ════════════════════════════════════════════════════════════════
# 4. Customer Freight Rates — 客户运费表
#    来源：Notion 运费页 → 顺丰零担 / 顺丰干配(3000泡)
#    数据格式：(省份, 首重20kg价, 续重元/kg) 零担
#    数据格式：(省份, 首重价, 续重元/kg) 干配
# ════════════════════════════════════════════════════════════════
_LINGDAN = [
    ("河南", 20, 1.1), ("河北", 21, 1.1),
    ("四川", 22, 1.02), ("山东", 22, 1.1),
    ("安徽", 24, 1.05), ("湖北", 24, 1.1),
    ("福建", 24, 1.15), ("浙江", 25, 1.1),
    ("江苏", 26, 1.1), ("湖南", 26, 1.15),
    ("重庆", 26, 1.1), ("广东", 27, 1.1),
    ("山西", 27, 1.3), ("江西", 28, 1.1),
    ("天津", 28, 1.4), ("陕西", 28, 1.4),
    ("贵州", 30, 1.35), ("北京", 31, 1.54),
    ("甘肃", 32, 1.6), ("上海", 32, 1.6),
    ("云南", 34, 1.35), ("海南", 34, 1.43),
    ("广西", 37, 1.35), ("辽宁", 37, 1.75),
    ("宁夏", 37, 1.8), ("吉林", 42, 1.75),
    ("青海", 42, 1.81), ("内蒙古", 42, 2.1),
    ("黑龙江", 57, 2.7),
]

_GANPEI = [
    ("山西", 17.82, 0.9), ("陕西", 17.96, 1.21),
    ("河南", 18.01, 0.96), ("河北", 19.28, 0.99),
    ("山东", 19.28, 0.99), ("四川", 20.01, 0.92),
    ("湖北", 22.16, 1.03), ("安徽", 22.68, 0.97),
    ("福建", 22.68, 1.05), ("辽宁", 23.33, 1.04),
    ("浙江", 23.49, 1.05), ("天津", 23.8, 1.19),
    ("重庆", 23.9, 1.03), ("江苏", 24.06, 1.09),
    ("湖南", 24.5, 1.07), ("上海", 24.5, 1.16),
    ("广东", 25.16, 1.1), ("江西", 26.73, 1.07),
    ("贵州", 28.76, 1.3), ("北京", 28.8, 1.44),
    ("云南", 32.81, 1.3), ("宁夏", 33.4, 1.67),
    ("海南", 34.02, 1.38), ("青海", 34.2, 1.71),
    ("内蒙古", 35.4, 1.77), ("吉林", 35.6, 1.78),
    ("广西", 35.64, 1.3), ("新疆", 43.4, 2.17),
    ("黑龙江", 44.6, 2.23),
]

CUSTOMER_FREIGHT_RATES = []
for prov, base, per_kg in _LINGDAN:
    CUSTOMER_FREIGHT_RATES.append({
        "tenant_id": "lianjia", "customer_id": "lianjia",
        "carrier": "顺丰零担", "province": prov,
        "formula_type": "base_plus_weight",
        "base_fee": base,
        "threshold_kg": 20,
        "per_kg_after_threshold": per_kg,
        "min_weight_kg": 1,
        "source": "notion:lianjai_knowledge_base",
    })

for prov, base, per_kg in _GANPEI:
    CUSTOMER_FREIGHT_RATES.append({
        "tenant_id": "lianjia", "customer_id": "lianjia",
        "carrier": "顺丰干配", "province": prov,
        "formula_type": "base_plus_weight",
        "base_fee": base,
        "threshold_kg": 1,
        "per_kg_after_threshold": per_kg,
        "min_weight_kg": 1,
        "source": "notion:lianjai_knowledge_base",
    })

# client_b 原有运费（保留隔离测试数据）
CUSTOMER_FREIGHT_RATES.extend([
    {"tenant_id": "client_b", "customer_id": "client_b", "carrier": "京东物流", "province": "四川",
     "formula_type": "base_plus_weight", "base_fee": 200.0, "threshold_kg": 50,
     "per_kg_after_threshold": 1.8, "min_weight_kg": 10, "source": "seed"},
])


# ════════════════════════════════════════════════════════════════
# 5. Customer Sale Price Items — 销售价覆盖（保留原有测试数据）
# ════════════════════════════════════════════════════════════════
CUSTOMER_SALE_PRICES = [
    {"tenant_id": "client_b", "customer_id": "client_b",
     "product_category": "牛栏网", "spec_hash": "nlw_ssxm_20x18_15_15_50",
     "sale_price_type": "sale_per_roll", "amount": 165.0, "unit": "卷", "source": "seed"},
]


# ════════════════════════════════════════════════════════════════
# 6. INT-R2 遗留：Capabilities & Quotations & Events
# ════════════════════════════════════════════════════════════════
SEED_CAPABILITIES = [
    {"customer_id": "lianjia", "customer_name": "联佳丝网", "product_category": "牛栏网",
     "spec_constraints": {"material": ["热镀锌", "冷镀锌"], "wire_diameter": [2.0, 2.5, 3.0],
                          "height": [1.0, 1.2, 1.5, 1.8, 2.0]}},
    {"customer_id": "lianjia", "customer_name": "联佳丝网", "product_category": "立柱",
     "spec_constraints": {"material": ["热镀锌"], "height": [1.5, 1.8, 2.0, 2.5]}},
]

SEED_QUOTATIONS: list[dict] = []  # demo 报价已清除，正式报价通过 API 录入

SEED_EVENTS = [
    {"tenant_id": "lianjia", "event_type": "chat.turn", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"message": "测试对话轮次", "model": "gpt-4o", "token_total": 450}, "sampled": True},
    {"tenant_id": "lianjia", "event_type": "quote.request", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"customer_id": "lianjia", "product_category": "牛栏网", "request_id": "req-001",
                 "token_total": 120}, "sampled": True},
    {"tenant_id": "lianjia", "event_type": "quote.response", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"customer_id": "lianjia", "product_category": "牛栏网", "request_id": "req-001",
                 "token_total": 380}, "sampled": True},
    {"tenant_id": "lianjia", "event_type": "kb.query", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"dataset_name": "L1_共通", "query": "牛栏网规格", "token_total": 210}, "sampled": True},
    {"tenant_id": "lianjia", "event_type": "kb.query", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"dataset_name": "L2_牛栏网_产品", "query": "2.0x1.8丝径", "token_total": 180}, "sampled": True},
    {"tenant_id": "lianjia", "event_type": "kb.query", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"dataset_name": "L3_联佳丝网_牛栏网", "query": "客户定价", "token_total": 150}, "sampled": True},
    {"tenant_id": "lianjia", "event_type": "quote.request", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"customer_id": "lianjia", "product_category": "立柱", "request_id": "req-002",
                 "token_total": 90}, "sampled": True},
    {"tenant_id": "lianjia", "event_type": "quote.response", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"customer_id": "lianjia", "product_category": "立柱", "request_id": "req-002",
                 "token_total": 420}, "sampled": True},
    {"tenant_id": "client_b", "event_type": "quote.request", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"customer_id": "client_b", "product_category": "牛栏网", "request_id": "req-003",
                 "token_total": 100}, "sampled": True},
    {"tenant_id": "client_b", "event_type": "quote.response", "schema_version": 1,
     "event_source": "kaas-web",
     "payload": {"customer_id": "client_b", "product_category": "牛栏网", "request_id": "req-003",
                 "token_total": 350}, "sampled": True},
]


# ════════════════════════════════════════════════════════════════
# Seeding Logic
# ════════════════════════════════════════════════════════════════
async def _seed_product_specs(session):
    print("Seeding product_specs …")
    count = 0
    for s in PRODUCT_SPECS:
        existing = await session.execute(
            __import__("sqlalchemy").select(ProductSpec).where(ProductSpec.spec_hash == s["spec_hash"])
        )
        if existing.scalar_one_or_none():
            continue
        spec = ProductSpec(**s)
        session.add(spec)
        count += 1
    print(f"  {count} new specs (total {len(PRODUCT_SPECS)} defined)")


async def _seed_cost_items(session):
    print("\nSeeding customer_cost_items …")
    count = 0
    for c in CUSTOMER_COST_ITEMS:
        existing = await session.execute(
            __import__("sqlalchemy").select(CustomerCostItem).where(
                CustomerCostItem.tenant_id == c["tenant_id"],
                CustomerCostItem.customer_id == c["customer_id"],
                CustomerCostItem.spec_hash == c["spec_hash"],
                CustomerCostItem.cost_type == c["cost_type"],
            )
        )
        if existing.scalar_one_or_none():
            continue
        item = CustomerCostItem(**c)
        session.add(item)
        count += 1
    print(f"  {count} new items (total {len(CUSTOMER_COST_ITEMS)} defined)")


async def _seed_sale_prices(session):
    print("\nSeeding customer_sale_price_items …")
    count = 0
    for s in CUSTOMER_SALE_PRICES:
        existing = await session.execute(
            __import__("sqlalchemy").select(CustomerSalePriceItem).where(
                CustomerSalePriceItem.tenant_id == s["tenant_id"],
                CustomerSalePriceItem.customer_id == s["customer_id"],
                CustomerSalePriceItem.spec_hash == s["spec_hash"],
            )
        )
        if existing.scalar_one_or_none():
            continue
        item = CustomerSalePriceItem(**s)
        session.add(item)
        count += 1
        print(f"  {s['tenant_id']}/{s['product_category']} ¥{s['amount']}/{s['unit']}")
    print(f"  {count} new items (total {len(CUSTOMER_SALE_PRICES)} defined)")


async def _seed_pricing_profiles(session):
    print("\nSeeding customer_pricing_profiles …")
    count = 0
    for p in CUSTOMER_PRICING_PROFILES:
        existing = await session.execute(
            __import__("sqlalchemy").select(CustomerPricingProfile).where(
                CustomerPricingProfile.tenant_id == p["tenant_id"],
                CustomerPricingProfile.customer_id == p["customer_id"],
                CustomerPricingProfile.product_category == p["product_category"],
            )
        )
        if existing.scalar_one_or_none():
            continue
        profile = CustomerPricingProfile(**p)
        session.add(profile)
        count += 1
        print(f"  {p['tenant_id']}/{p['product_category']} margins: "
              f"{p['low_margin_rate']}/{p['standard_margin_rate']}/{p['high_margin_rate']}")
    print(f"  {count} new profiles (total {len(CUSTOMER_PRICING_PROFILES)} defined)")


async def _seed_freight_rates(session):
    print("\nSeeding customer_freight_rates …")
    count = 0
    for f in CUSTOMER_FREIGHT_RATES:
        existing = await session.execute(
            __import__("sqlalchemy").select(CustomerFreightRate).where(
                CustomerFreightRate.tenant_id == f["tenant_id"],
                CustomerFreightRate.customer_id == f["customer_id"],
                CustomerFreightRate.carrier == f["carrier"],
                CustomerFreightRate.province == f["province"],
            )
        )
        if existing.scalar_one_or_none():
            continue
        rate = CustomerFreightRate(**f)
        session.add(rate)
        count += 1
    print(f"  {count} new rates (total {len(CUSTOMER_FREIGHT_RATES)} defined: lianjia {len(_LINGDAN)} zero担 + "
          f"{len(_GANPEI)} 干配)")


async def _clean_old_specs(session):
    """移除旧版不规范 spec_hash（含中文的 hash），保证重复运行幂等。"""
    result = await session.execute(
        __import__("sqlalchemy").select(ProductSpec).where(
            ProductSpec.spec_hash.like("nlw_%疏%"),
        )
    )
    old = list(result.scalars().all())
    for sp in old:
        await session.delete(sp)
    if old:
        print(f"  cleaned {len(old)} old Chinese-hash specs")


async def seed_int_r3(session=None):
    """INT-R3 种子数据（产品规格、定价、运费等）。"""
    own_session = session is None
    if own_session:
        s = async_session_factory()
    else:
        s = session

    try:
        # ── 清理旧版不规范 spec_hash ──
        await _clean_old_specs(s)

        # ── Product Specs（平台规格） ──
        await _seed_product_specs(s)

        # ── 客户私有数据 ──
        await _seed_cost_items(s)
        await _seed_sale_prices(s)
        await _seed_pricing_profiles(s)
        await _seed_freight_rates(s)

        # ── Capabilities ──
        print("\nSeeding capabilities …")
        for c in SEED_CAPABILITIES:
            cap = await upsert_capability(
                session=s, customer_id=c["customer_id"],
                customer_name=c["customer_name"],
                product_category=c["product_category"],
                spec_constraints=c["spec_constraints"],
            )
            print(f"  {cap.customer_id}/{cap.product_category}")

        # ── Quotations ──
        print("\nSeeding quotations …")
        for q in SEED_QUOTATIONS:
            spec_hash = _spec_hash(q["product_spec"])
            effective_from = datetime.now(timezone.utc) + timedelta(days=q.get("effective_from_offset_days", 0))
            ins = await insert_quotation(
                session=s, customer_id=q["customer_id"],
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
                session=s, tenant_id=e["tenant_id"], trace_id=None,
                event_type=e["event_type"], schema_version=e["schema_version"],
                event_source=e["event_source"], payload=e["payload"], sampled=e["sampled"],
            )
            print(f"  {ev.tenant_id}/{ev.event_type}")

        if own_session:
            await s.commit()

        nlw_count = sum(1 for sp in PRODUCT_SPECS if sp["product_category"] == "牛栏网")
        post_count = sum(1 for sp in PRODUCT_SPECS if sp["product_category"] == "立柱")
        print(f"\nSeed complete: {nlw_count} 牛栏网 specs + {post_count} 立柱 specs + "
              f"{len(CUSTOMER_COST_ITEMS)} cost items + "
              f"{len(CUSTOMER_SALE_PRICES)} sale prices + "
              f"{len(CUSTOMER_PRICING_PROFILES)} profiles + "
              f"{len(CUSTOMER_FREIGHT_RATES)} freight rates + "
              f"{len(SEED_CAPABILITIES)} capas + {len(SEED_QUOTATIONS)} quotes + "
              f"{len(SEED_EVENTS)} events")
    finally:
        if own_session:
            await s.close()


# ════════════════════════════════════════════════════════════════
# AUTH-WX-R1: 种子账号 & 客户 & 微信 Bot
# ════════════════════════════════════════════════════════════════

AUTH_SEED_USERS = [
    {
        "email": "david@kaas.local",
        "password": "kaas123",
        "display_name": "David",
        "account_type": "internal",
    },
    {
        "email": "lianjia@test.local",
        "password": "test123",
        "display_name": "联佳业务员",
        "account_type": "customer",
    },
    {
        "email": "clientb@test.local",
        "password": "test123",
        "display_name": "客户B业务员",
        "account_type": "customer",
    },
]

AUTH_SEED_CUSTOMERS = [
    {
        "tenant_id": "lianjia",
        "code": "lianjia",
        "name": "联佳丝网",
    },
    {
        "tenant_id": "client_b",
        "code": "client_b",
        "name": "客户B",
    },
]

# user_email → customer_code 绑定
AUTH_SEED_USER_CUSTOMERS = [
    {"email": "lianjia@test.local", "customer_code": "lianjia"},
    {"email": "clientb@test.local", "customer_code": "client_b"},
]

# 微信 ClawBot 种子
AUTH_SEED_WECHAT_BOT = {
    "customer_code": "lianjia",
    "tenant_id": "lianjia",
    "bot_name": "联佳ClawBot",
    "bot_type": "clawbot",
    "bot_token": "clawbot-test-token-000000",
}


async def seed_auth():
    """种子账号 & 客户 & 微信 Bot 数据（幂等）。"""
    import base64
    from app.db.models import User, Customer, UserCustomer, WechatBotAccount
    from app.core.auth import hash_password

    async with async_session_factory() as session:
        # ── Customers ──
        customer_map = {}  # code → Customer
        for c_data in AUTH_SEED_CUSTOMERS:
            from sqlalchemy import select
            stmt = select(Customer).where(Customer.code == c_data["code"])
            result = await session.execute(stmt)
            existing = result.scalar_one_or_none()
            if existing is None:
                cust = Customer(**c_data)
                session.add(cust)
                await session.flush()
                customer_map[c_data["code"]] = cust
                print(f"  [auth] Created customer: {c_data['code']} (id={cust.id})")
            else:
                customer_map[c_data["code"]] = existing
                print(f"  [auth] Customer exists: {c_data['code']} (id={existing.id})")

        # ── Users ──
        user_map = {}  # email → User
        for u_data in AUTH_SEED_USERS:
            from sqlalchemy import select
            stmt = select(User).where(User.email == u_data["email"])
            result = await session.execute(stmt)
            existing = result.scalar_one_or_none()
            if existing is None:
                user = User(
                    email=u_data["email"],
                    password_hash=hash_password(u_data["password"]),
                    display_name=u_data["display_name"],
                    account_type=u_data["account_type"],
                    status="active",
                )
                session.add(user)
                await session.flush()
                user_map[u_data["email"]] = user
                print(f"  [auth] Created user: {u_data['email']} ({u_data['account_type']}, id={user.id})")
            else:
                user_map[u_data["email"]] = existing
                print(f"  [auth] User exists: {u_data['email']} ({existing.account_type}, id={existing.id})")

        # ── UserCustomer bindings ──
        for uc_data in AUTH_SEED_USER_CUSTOMERS:
            user = user_map.get(uc_data["email"])
            cust = customer_map.get(uc_data["customer_code"])
            if user and cust:
                from sqlalchemy import select
                stmt = select(UserCustomer).where(
                    UserCustomer.user_id == user.id,
                    UserCustomer.customer_id == cust.id,
                )
                result = await session.execute(stmt)
                existing = result.scalar_one_or_none()
                if existing is None:
                    uc = UserCustomer(user_id=user.id, customer_id=cust.id)
                    session.add(uc)
                    print(f"  [auth] Bound user {uc_data['email']} → customer {uc_data['customer_code']}")
                else:
                    print(f"  [auth] Binding exists: {uc_data['email']} → {uc_data['customer_code']}")

        # ── Wechat Bot Account ──
        bot_cust = customer_map.get(AUTH_SEED_WECHAT_BOT["customer_code"])
        if bot_cust:
            from sqlalchemy import select
            stmt = select(WechatBotAccount).where(
                WechatBotAccount.customer_id == bot_cust.id,
                WechatBotAccount.bot_name == AUTH_SEED_WECHAT_BOT["bot_name"],
            )
            result = await session.execute(stmt)
            existing = result.scalar_one_or_none()
            if existing is None:
                bot = WechatBotAccount(
                    customer_id=bot_cust.id,
                    tenant_id=AUTH_SEED_WECHAT_BOT["tenant_id"],
                    bot_name=AUTH_SEED_WECHAT_BOT["bot_name"],
                    bot_type=AUTH_SEED_WECHAT_BOT["bot_type"],
                    bot_token_encrypted=base64.b64encode(
                        AUTH_SEED_WECHAT_BOT["bot_token"].encode()
                    ).decode(),
                    status="active",
                    created_by="seed",
                )
                session.add(bot)
                await session.flush()
                print(f"  [auth] Created wechat bot: {bot.bot_name} (id={bot.id})")
            else:
                print(f"  [auth] Wechat bot exists: {existing.bot_name} (id={existing.id})")

        await session.commit()
        print("  [auth] Auth seed complete")
        return customer_map


async def seed():
    """幂等种子主入口（INT-R3 + AUTH-WX-R1）。"""
    # 先种 auth 数据
    await seed_auth()
    # 再种 INT-R3 数据
    await seed_int_r3()


if __name__ == "__main__":
    asyncio.run(seed())
