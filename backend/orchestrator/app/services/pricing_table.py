"""客户定价数据 ↔ 报价引擎 之间的桥。

职责边界（为什么要有这一层）
----------------------------
报价引擎是**纯函数**：给同样的输入必然得到同样的输出，不碰数据库、不碰网络。
所以引擎不认识「定价数据表」，它只认 `QuoteRequest.cost_table` 这一张查价表。
本模块负责两件事：

1. 读：按当前客户把库里的成本读成查价表，交给引擎（`load_cost_table`）；
2. 建：把产品定价键的**完整组合矩阵**和客户已配置的值合到一起，给界面渲染。

查价键由**产品定义声明的定价键**决定（`ProductSpec.pricing_key`），
本模块不写死任何产品知识 —— 换个产品、加个档位，定价页与查价自动跟着变。

降级策略：某组合客户没配过 → 表里就没有这个键 → 引擎回退产品定义里的内联成本。
因此「没配定价数据」与「配了」在数值上连续，老报价不会因为上线这个功能而变化。
"""
from __future__ import annotations

from itertools import product as _cartesian
from typing import Any, Mapping, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.cost_items_repo import list_pricing_key_items
from app.services.export_quote.models import (
    ProductSpec,
    pricing_key_defined_values,
    pricing_key_of,
    pricing_key_value,
)
from app.services.export_quote.formulas import describe_pricing_key

# 定价键记录在 spec_hash 里的前缀分隔符："{product_key}:{key}"
SEPARATOR = ":"
# product_spec_json 里标记「这是一条定价键成本」的类型字段
KIND = "pricing_key"


def make_spec_hash(product_key: str, key: str) -> str:
    """定价键记录在 `customer_cost_items.spec_hash` 里的取值。"""
    return f"{product_key}{SEPARATOR}{key}"


def key_of_values(product: ProductSpec, values: Mapping[str, Any]) -> str:
    """按产品定价键把一组取值拼成查价键；缺维度返回 ""（= 不可查价）。"""
    return pricing_key_of(product, dict(values))


def matrix_rows(product: ProductSpec) -> list[dict]:
    """产品定价键的**完整取值组合**（笛卡尔积），顺序与界面列一致。

    例：牛栏网 = 边丝径(2) × 镀锌量(2) → 4 行。
    """
    dims = describe_pricing_key(product)
    if not dims:
        return []
    combos = list(_cartesian(*[d["options"] for d in dims]))
    rows: list[dict] = []
    for combo in combos:
        values = {d["field"]: opt["value"] for d, opt in zip(dims, combo)}
        rows.append({
            "values": values,
            "labels": [opt["label"] for opt in combo],
            "key": key_of_values(product, values),
        })
    return rows


async def load_cost_table(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product: ProductSpec,
) -> dict[str, float]:
    """读出该客户在这个产品上的成本表：``{"de=2|coating_code=zinc_40": 4.4}``。

    产品没声明定价键 → 返回空表（引擎自然回退内联成本）。
    同一个键有多条历史版本时取**最新一条**（repo 已按 id 倒序返回）。

    传进来的 ``product`` 应当是**已并入客户档位的有效规格空间**
    （见 `load_option_extensions` + `models.extend_product`），
    否则客户自己加的档位会被下面这层「有效性」过滤当成失效键而丢掉。
    """
    if not product.pricing_key:
        return {}

    items = await list_pricing_key_items(session, tenant_id, customer_id, product.key)
    table: dict[str, float] = {}
    for item in items:
        if not item.spec_hash.startswith(f"{product.key}{SEPARATOR}"):
            continue
        key = item.spec_hash.split(SEPARATOR, 1)[1]
        if key in table:
            continue  # 已有更新的版本
        if item.amount is not None and item.amount > 0:
            table[key] = float(item.amount)

    # 只保留产品当前仍然存在的组合：产品改了档位（如取消某个镀锌量）之后，
    # 库里残留的旧键不该继续参与报价 —— 否则会出现「界面上没有、报价里却在用」的价。
    valid = {row["key"] for row in matrix_rows(product)}
    if valid:
        table = {k: v for k, v in table.items() if k in valid}
    return table


async def load_option_extensions(
    session: AsyncSession,
    tenant_id: str,
    customer_id: Optional[str],
    product: ProductSpec,
) -> dict[str, list[dict]]:
    """从客户定价数据里反推「客户自己加的档位」。

    **定价数据就是档位的来源**，不另建表：库里出现过一个产品定义没有的取值，
    就说明客户要用这个档位 —— 报价页的规格下拉里也就该多出这一项。
    这样「加档位」只有一步（录成本），不会出现「成本录了、选项忘了加」的裂缝。

    customer_id=None 表示聚合租户下所有客户的档位（管理员视角）。
    """
    fields = [d["field"] for d in (product.pricing_key or []) if d.get("field")]
    if not fields:
        return {}

    items = await list_pricing_key_items(session, tenant_id, customer_id, product.key)
    defined = pricing_key_defined_values(product)
    out: dict[str, list[dict]] = {}
    seen: dict[str, set[str]] = {}

    for item in items:
        payload = item.product_spec_json or {}
        values = payload.get("values")
        if not isinstance(values, dict):
            continue
        labels = payload.get("labels") or {}
        for field in fields:
            if field not in values:
                continue
            raw = values[field]
            canonical = pricing_key_value(raw)
            if canonical in defined.get(field, set()):
                continue  # 产品定义里本来就有，不算新增
            if canonical in seen.setdefault(field, set()):
                continue
            seen[field].add(canonical)
            out.setdefault(field, []).append({
                "value": raw,
                "label": str(labels.get(field) or raw),
            })
    return out


async def load_matrix(
    session: AsyncSession,
    tenant_id: str,
    customer_id: Optional[str],
    product: ProductSpec,
) -> dict:
    """定价页要的数据：维度声明 + 完整矩阵 + 客户已配置的值。

    - 客户视角（customer_id 有值）：只读自己的配置。
    - 管理员视角（customer_id=None）：读租户下**所有客户**的配置，按客户分组返回，
      这样管理员能一眼看出哪些客户还没配价。
    """
    dims = describe_pricing_key(product)
    rows = matrix_rows(product)

    items = await list_pricing_key_items(session, tenant_id, customer_id, product.key)

    # customer_id -> {key: item}
    by_customer: dict[str, dict[str, Any]] = {}
    for item in items:
        if not item.spec_hash.startswith(f"{product.key}{SEPARATOR}"):
            continue
        key = item.spec_hash.split(SEPARATOR, 1)[1]
        bucket = by_customer.setdefault(item.customer_id, {})
        if key not in bucket:  # repo 按 id 倒序 → 首次遇到即最新
            bucket[key] = item

    def _cell(rows_by_key: dict[str, Any], row: dict) -> dict:
        item = rows_by_key.get(row["key"])
        return {
            "key": row["key"],
            "values": row["values"],
            "labels": row["labels"],
            "amount": float(item.amount) if item else None,
            "unit": item.unit if item else (product.cost_unit.split("/")[-1] if product.cost_unit else ""),
            "item_id": item.id if item else None,
            "effective_from": item.effective_from.isoformat() if item and item.effective_from else None,
            "source": (item.source if item else "product_default"),
            "notes": item.notes if item else None,
            "configured": item is not None,
        }

    if customer_id is not None:
        bucket = by_customer.get(customer_id, {})
        return {
            "product_key": product.key,
            "product_name": product.name,
            "cost_unit": product.cost_unit,
            "scope": "own",
            "dims": dims,
            "rows": [_cell(bucket, r) for r in rows],
        }

    customers = [
        {
            "customer_id": cid,
            "rows": [_cell(bucket, r) for r in rows],
            "configured_count": sum(1 for r in rows if bucket.get(r["key"])),
        }
        for cid, bucket in sorted(by_customer.items())
    ]
    return {
        "product_key": product.key,
        "product_name": product.name,
        "cost_unit": product.cost_unit,
        "scope": "all",
        "dims": dims,
        "rows": [_cell({}, r) for r in rows],  # 兜底模板（全为未配置）
        "customers": customers,
    }
