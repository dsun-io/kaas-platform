"""seed_dev.py — 开发环境种子数据

默认只初始化业务/demo 数据（产品规格、成本价、运费、报价策略）。
开发测试账号需通过 SEED_DEV_ACCOUNTS=true + DEV_* 环境变量显式启用。
生产环境禁止运行本脚本。

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
import os
import sys
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
from app.config.settings import settings

# ════════════════════════════════════════════════════════════════
# 生产环境防护 — seed_dev.py 禁止在生产环境运行
# ════════════════════════════════════════════════════════════════
if settings.app_env == "production":
    raise RuntimeError(
        "seed_dev.py 禁止在生产环境运行。"
        "如需初始化数据，请使用独立的 production_seed.py 并通过审批流程。"
    )


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
        (1.3, 99.99, 5.2, 10.4),  # 虚构进价
        (1.5, 99.99, 6.0, 12.0),
        (1.7, 99.99, 6.8, 13.6),
        (1.8, 99.99, 7.2, 14.4),
        (2.0, 99.99, 8.0, 16.0),
        (2.3, 99.99, 9.2, 18.4),
        (2.5, 99.99, 10.0, 20.0),
    ],
    "花边": [
        (1.3, 99.99, 7.15, 14.3),  # 虚构进价
        (1.5, 99.99, 8.25, 16.5),
        (1.7, 99.99, 9.35, 18.7),
        (1.8, 99.99, 9.9, 19.8),
        (2.0, 99.99, 11.0, 22.0),
        (2.3, 99.99, 12.65, 25.3),
        (2.5, 99.99, 13.75, 27.5),
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
# 2. Customer Cost Items — 客户私有成本价（DEMO 数据）
#    真实数据通过 Admin API 录入，代码中不硬编码商业机密
# ════════════════════════════════════════════════════════════════
CUSTOMER_COST_ITEMS = []

# 牛栏网成本（DEMO 数据 — 明显虚构值）
COST_PER_KG = {
    "2.0x1.8": 99.99,
    "1.8x1.8": 99.99,
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
                "source": "demo",
                "notes": f"Demo 数据: {wd} {ckg}元/kg（请通过 Admin API 录入真实数据）",
            })

# 立柱成本（DEMO 数据）
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
            "source": "demo",
            "notes": f"Demo 数据: Y型{ptype} {h}m 进价 {cost}元/根（请通过 Admin API 录入真实数据）",
        })


# ════════════════════════════════════════════════════════════════
# 3. Customer Pricing Profiles — 报价策略（DEMO 数据）
#    真实数据通过 Admin API 录入，代码中不硬编码商业机密
# ════════════════════════════════════════════════════════════════
CUSTOMER_PRICING_PROFILES = [
    {
        "tenant_id": "lianjia", "customer_id": "lianjia",
        "product_category": "牛栏网", "profile_name": "default",
        "low_margin_rate": 9.99,   # DEMO 虚构值
        "standard_margin_rate": 8.88,  # DEMO 虚构值
        "high_margin_rate": 7.77,  # DEMO 虚构值
        "tax_rate": 0.03,
        "source": "demo",
    },
    {
        "tenant_id": "lianjia", "customer_id": "lianjia",
        "product_category": "立柱", "profile_name": "default",
        "low_margin_rate": 9.99,   # DEMO 虚构值
        "standard_margin_rate": 8.88,  # DEMO 虚构值
        "high_margin_rate": 7.77,  # DEMO 虚构值
        "tax_rate": 0.03,
        "source": "demo",
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
    ("河南", 999.99, 1.1), ("河北", 999.99, 1.1),
    ("四川", 999.99, 1.02), ("山东", 999.99, 1.1),
    ("安徽", 999.99, 1.05), ("湖北", 999.99, 1.1),
    ("福建", 999.99, 1.15), ("浙江", 999.99, 1.1),
    ("江苏", 999.99, 1.1), ("湖南", 999.99, 1.15),
    ("重庆", 999.99, 1.1), ("广东", 999.99, 1.1),
    ("山西", 999.99, 1.3), ("江西", 999.99, 1.1),
    ("天津", 999.99, 1.4), ("陕西", 999.99, 1.4),
    ("贵州", 999.99, 1.35), ("北京", 999.99, 1.54),
    ("甘肃", 999.99, 1.6), ("上海", 999.99, 1.6),
    ("云南", 999.99, 1.35), ("海南", 999.99, 1.43),
    ("广西", 999.99, 1.35), ("辽宁", 999.99, 1.75),
    ("宁夏", 999.99, 1.8), ("吉林", 999.99, 1.75),
    ("青海", 999.99, 1.81), ("内蒙古", 999.99, 2.1),
    ("黑龙江", 999.99, 2.7),
]

_GANPEI = [
    ("山西", 999.99, 0.9), ("陕西", 999.99, 1.21),
    ("河南", 999.99, 0.96), ("河北", 999.99, 0.99),
    ("山东", 999.99, 0.99), ("四川", 999.99, 0.92),
    ("湖北", 999.99, 1.03), ("安徽", 999.99, 0.97),
    ("福建", 999.99, 1.05), ("辽宁", 999.99, 1.04),
    ("浙江", 999.99, 1.05), ("天津", 999.99, 1.19),
    ("重庆", 999.99, 1.03), ("江苏", 999.99, 1.09),
    ("湖南", 999.99, 1.07), ("上海", 999.99, 1.16),
    ("广东", 999.99, 1.1), ("江西", 999.99, 1.07),
    ("贵州", 999.99, 1.3), ("北京", 999.99, 1.44),
    ("云南", 999.99, 1.3), ("宁夏", 999.99, 1.67),
    ("海南", 999.99, 1.38), ("青海", 999.99, 1.71),
    ("内蒙古", 999.99, 1.77), ("吉林", 999.99, 1.78),
    ("广西", 999.99, 1.3), ("新疆", 999.99, 2.17),
    ("黑龙江", 999.99, 2.23),
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
        "source": "demo",
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
        "source": "demo",
    })

# client_b 原有运费（保留隔离测试数据）
CUSTOMER_FREIGHT_RATES.extend([
    {"tenant_id": "client_b", "customer_id": "client_b", "carrier": "京东物流", "province": "四川",
     "formula_type": "base_plus_weight", "base_fee": 999.99, "threshold_kg": 50,
     "per_kg_after_threshold": 1.8, "min_weight_kg": 10, "source": "demo"},
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
# Seeding Logic (业务数据: 产品规格、成本、运费、报价策略、Capabilities、Events)
# ════════════════════════════════════════════════════════════════

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


# ════════════════════════════════════════════════════════════════
# 开发测试账号 seed（可选 · 需 SEED_DEV_ACCOUNTS=true 显式启用）
# ════════════════════════════════════════════════════════════════

_DEV_CUSTOMERS = [
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

_WECHAT_BOT_CONFIG = {
    "customer_code": "lianjia",
    "tenant_id": "lianjia",
    "bot_name": "联佳ClawBot",
    "bot_type": "clawbot",
    "bot_token": "demo-bot-token-999999",  # 虚构 token，生产环境通过环境变量配置
}


def _is_production() -> bool:
    """检查当前环境是否为生产环境。"""
    app_env = (os.environ.get("APP_ENV") or "").lower()
    env = (os.environ.get("ENV") or "").lower()
    return app_env == "production" or env == "production"


def _validate_dev_account_config() -> dict:
    """校验 SEED_DEV_ACCOUNTS 配置，返回用户配置字典或退出。"""
    required_vars = {
        "DEV_ADMIN_EMAIL": settings.dev_admin_email,
        "DEV_ADMIN_PASSWORD": settings.dev_admin_password,
        "DEV_LIANJIA_EMAIL": settings.dev_lianjia_email,
        "DEV_LIANJIA_PASSWORD": settings.dev_lianjia_password,
        "DEV_CLIENTB_EMAIL": settings.dev_clientb_email,
        "DEV_CLIENTB_PASSWORD": settings.dev_clientb_password,
    }
    missing = [k for k, v in required_vars.items() if not v]
    if missing:
        print(
            f"ERROR: SEED_DEV_ACCOUNTS=true but required env vars missing: "
            f"{', '.join(missing)}"
        )
        print("Set all DEV_*_EMAIL and DEV_*_PASSWORD env vars to proceed.")
        sys.exit(1)
    return required_vars


async def seed_auth():
    """种子开发测试账号（仅当 SEED_DEV_ACCOUNTS=true 且非生产环境时执行）。

    账号邮箱和密码全部来自环境变量，不包含任何硬编码密码。
    幂等 —— 可重复运行。
    """
    # ── 开关检查 ──
    if not settings.seed_dev_accounts:
        print("  [auth] SEED_DEV_ACCOUNTS not enabled. Skipping dev account creation.")
        return None

    # ── 生产环境拒绝 ──
    if _is_production():
        print("ERROR: seed_dev.py refused to run in production environment.")
        print("Production admin accounts must be created via /setup-admin or /api/v1/auth/bootstrap-admin.")
        sys.exit(1)

    # ── 校验环境变量 ──
    env_config = _validate_dev_account_config()

    import base64
    from app.db.models import User, Customer, UserCustomer, WechatBotAccount
    from app.core.auth import hash_password
    from sqlalchemy import select

    async with async_session_factory() as session:
        # ── Customers ──
        customer_map = {}  # code → Customer
        for c_data in _DEV_CUSTOMERS:
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

        # ── Dev Account Definitions (全部来自环境变量) ──
        dev_users = [
            {
                "email": env_config["DEV_ADMIN_EMAIL"],
                "password": env_config["DEV_ADMIN_PASSWORD"],
                "display_name": "David",
                "account_type": "internal",
                "role": "system_admin",
                "plan": "internal",
            },
            {
                "email": env_config["DEV_LIANJIA_EMAIL"],
                "password": env_config["DEV_LIANJIA_PASSWORD"],
                "display_name": "联佳业务员",
                "account_type": "customer",
                "role": "owner",
                "plan": "free",
            },
            {
                "email": env_config["DEV_CLIENTB_EMAIL"],
                "password": env_config["DEV_CLIENTB_PASSWORD"],
                "display_name": "客户B业务员",
                "account_type": "customer",
                "role": "owner",
                "plan": "free",
            },
        ]

        dev_user_customer_bindings = [
            {"email": env_config["DEV_LIANJIA_EMAIL"], "customer_code": "lianjia"},
            {"email": env_config["DEV_CLIENTB_EMAIL"], "customer_code": "client_b"},
        ]

        # ── Users ──
        user_map = {}  # email → User
        for u_data in dev_users:
            stmt = select(User).where(User.email == u_data["email"])
            result = await session.execute(stmt)
            existing = result.scalar_one_or_none()
            if existing is None:
                user = User(
                    email=u_data["email"],
                    password_hash=hash_password(u_data["password"]),
                    display_name=u_data["display_name"],
                    account_type=u_data["account_type"],
                    role=u_data["role"],
                    plan=u_data["plan"],
                    status="active",
                )
                session.add(user)
                await session.flush()
                user_map[u_data["email"]] = user
                print(f"  [auth] Created user: {u_data['email']} ({u_data['account_type']}, id={user.id})")
            else:
                # 幂等更新 — 同步密码、角色等配置变更
                existing.password_hash = hash_password(u_data["password"])
                existing.display_name = u_data["display_name"]
                existing.account_type = u_data["account_type"]
                existing.role = u_data["role"]
                existing.plan = u_data["plan"]
                existing.status = "active"
                user_map[u_data["email"]] = existing
                print(f"  [auth] Updated user: {u_data['email']} ({u_data['account_type']}, id={existing.id})")

        # ── UserCustomer bindings ──
        for uc_data in dev_user_customer_bindings:
            user = user_map.get(uc_data["email"])
            cust = customer_map.get(uc_data["customer_code"])
            if user and cust:
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
        bot_cust = customer_map.get(_WECHAT_BOT_CONFIG["customer_code"])
        if bot_cust:
            stmt = select(WechatBotAccount).where(
                WechatBotAccount.customer_id == bot_cust.id,
                WechatBotAccount.bot_name == _WECHAT_BOT_CONFIG["bot_name"],
            )
            result = await session.execute(stmt)
            existing = result.scalar_one_or_none()
            if existing is None:
                bot = WechatBotAccount(
                    customer_id=bot_cust.id,
                    tenant_id=_WECHAT_BOT_CONFIG["tenant_id"],
                    bot_name=_WECHAT_BOT_CONFIG["bot_name"],
                    bot_type=_WECHAT_BOT_CONFIG["bot_type"],
                    bot_token_encrypted=base64.b64encode(
                        _WECHAT_BOT_CONFIG["bot_token"].encode()
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
        print("  [auth] Dev account seed complete")
        return customer_map


async def seed():
    """幂等种子主入口。

    默认只 seed 业务数据（产品规格、成本、运费、报价策略等）。
    开发测试账号需通过 SEED_DEV_ACCOUNTS=true + DEV_* 环境变量显式启用。
    """
    # 先种 auth 数据（可选）
    await seed_auth()
    # 再种 INT-R3 数据（始终 seed 业务数据）
    await seed_int_r3()


if __name__ == "__main__":
    # 生产环境保护 — 直接运行脚本也拒绝
    if _is_production():
        print("ERROR: seed_dev.py is for development only and cannot run in production.")
        sys.exit(1)
    asyncio.run(seed())
