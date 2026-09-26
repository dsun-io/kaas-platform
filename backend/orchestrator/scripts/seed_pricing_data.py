"""把「定价数据」灌成真实可用的一套（替代旧的 99.99 虚构占位值）。

为什么需要这个脚本
------------------
「定价数据」是**算价的输入**。里面若是虚构占位值，报价会「看起来正常、
数字却完全错」—— 这比直接报错危险得多。所以：

1. 停用旧的虚构行（source='demo'，牛栏网 99.99 元/kg 那批）；
2. 按**产品定价键**写入基准成本（牛栏网 = 边丝径 × 镀锌量 → 4 行）。

查价键一律**从产品定义算出来**，不手写字符串 ——
手写过的教训：脚本写 `de=2.0`、界面回传 `de=2`，同一格分裂成两把钥匙，
存进去了却查不到（详见 models.pricing_key_value 的注释）。

本脚本只**补空位**，不覆盖人工配过的值（要覆盖加 --force）。
人工配置是该客户真实的成本，脚本不该悄悄改掉它。

用法
----
    python scripts/seed_pricing_data.py            # 补空位 + 停用旧虚构值
    python scripts/seed_pricing_data.py --force    # 连人工配过的值一起重置为基准
    python scripts/seed_pricing_data.py --check    # 只看现状，不改数据
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import select, update

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.models import CustomerCostItem  # noqa: E402
from app.db.session import async_session_factory  # noqa: E402
from app.services.export_quote.models import pricing_key_of, pricing_key_value  # noqa: E402
from app.services.export_quote.products import get as get_product  # noqa: E402

TENANT_ID = "lianjia"
CUSTOMER_ID = "lianjia"
PRODUCT_KEY = "field_fence"
PRODUCT_NAME = "牛栏网"

# 基准成本（元/kg）= 产品定义里的内联兜底值。
# 保持与产品定义一致，「配了定价数据」与「没配」在报价上才能无缝衔接。
# 取值写的是**原始规格值**，查价键由 pricing_key_value 统一规范化后生成。
BASE_COST: dict[tuple, float] = {
    (2.0, "zinc_40"): 4.4,    # 边丝径 2.0 · 普锌 40g/㎡
    (2.0, "zinc_200"): 5.6,   # 边丝径 2.0 · 重镀锌 ≥200g/㎡
    (2.5, "zinc_40"): 4.4,    # 边丝径 2.5 · 普锌 40g/㎡
    (2.5, "zinc_200"): 5.6,   # 边丝径 2.5 · 重镀锌 ≥200g/㎡
}


async def main(check_only: bool, force: bool) -> int:
    product = get_product(PRODUCT_KEY)
    fields = [d["field"] for d in product.pricing_key]

    # 每一条基准成本 → (查价键, 原始取值)
    targets: list[tuple[str, dict, float]] = []
    for (de, coating_code), amount in BASE_COST.items():
        values = {"de": de, "coating_code": coating_code}
        missing = [f for f in fields if f not in values]
        if missing:
            raise SystemExit(f"基准成本缺少定价键维度: {missing}（产品声明 {fields}）")
        targets.append((pricing_key_of(product, values), values, amount))
    valid_keys = {k for k, _, _ in targets}

    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(CustomerCostItem).where(
                    CustomerCostItem.tenant_id == TENANT_ID,
                    CustomerCostItem.customer_id == CUSTOMER_ID,
                    CustomerCostItem.product_category == PRODUCT_NAME,
                    CustomerCostItem.status == "active",
                )
            )
        ).scalars().all()

        legacy = [r for r in rows if not r.spec_hash.startswith(f"{PRODUCT_KEY}:")]
        keyed = {
            r.spec_hash[len(PRODUCT_KEY) + 1:]: r
            for r in rows
            if r.spec_hash.startswith(f"{PRODUCT_KEY}:")
        }
        # 产品已经不再支持的键（如档位被删、或早期的键写法）→ 死数据
        dead = {k: r for k, r in keyed.items() if k not in valid_keys}
        live = {k: r for k, r in keyed.items() if k in valid_keys}

        print(f"[现状] 牛栏网 active 成本记录 {len(rows)} 条："
              f"旧虚构 {len(legacy)} / 定价键 {len(keyed)}（其中失效键 {len(dead)}）")
        print("[基准表]")
        for key, _, amount in targets:
            cur = live.get(key)
            mark = f"已有 {float(cur.amount)}" if cur else "空位"
            print(f"  · {key:<34} 基准 {amount}   ({mark})")
        if dead:
            print("[失效键]（产品当前不支持，将停用）")
            for k, r in dead.items():
                print(f"  · {k:<34} {float(r.amount)}  id={r.id}")

        if check_only:
            print("\n[--check] 未修改任何数据。")
            return 0

        deactivate_ids = [r.id for r in legacy] + [r.id for r in dead.values()]
        if deactivate_ids:
            await session.execute(
                update(CustomerCostItem)
                .where(CustomerCostItem.id.in_(deactivate_ids))
                .values(status="inactive")
            )
            print(f"\n[停用] {len(deactivate_ids)} 条（旧虚构 {len(legacy)} + 失效键 {len(dead)}）")

        written = skipped = 0
        for key, values, amount in targets:
            spec_hash = f"{PRODUCT_KEY}:{key}"
            existing = live.get(key)
            if existing is not None and not force:
                # 人工配过的成本是这个客户的真实数据，脚本不覆盖它
                skipped += 1
                continue

            await session.execute(
                update(CustomerCostItem)
                .where(
                    CustomerCostItem.tenant_id == TENANT_ID,
                    CustomerCostItem.customer_id == CUSTOMER_ID,
                    CustomerCostItem.spec_hash == spec_hash,
                    CustomerCostItem.status == "active",
                )
                .values(status="inactive")
            )
            session.add(
                CustomerCostItem(
                    tenant_id=TENANT_ID,
                    customer_id=CUSTOMER_ID,
                    product_category=PRODUCT_NAME,
                    spec_hash=spec_hash,
                    cost_type="cost_per_kg",
                    amount=amount,
                    currency="CNY",
                    unit="kg",
                    product_spec_id=None,
                    product_spec_json={
                        "kind": "pricing_key",
                        "product_key": PRODUCT_KEY,
                        "pricing_key": key,
                        "values": {k: pricing_key_value(v) for k, v in values.items()},
                    },
                    source="seed",
                    notes="牛栏网基准成本（与产品定义内联兜底值一致）",
                )
            )
            written += 1
            print(f"[写入] {key} → {amount} 元/kg")

        await session.commit()
        print(f"\n完成：停用 {len(deactivate_ids)} 条，写入 {written} 条，"
              f"保留人工配置 {skipped} 条。")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只报告现状，不修改数据")
    parser.add_argument("--force", action="store_true", help="连人工配过的值也重置为基准")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.check, args.force)))
