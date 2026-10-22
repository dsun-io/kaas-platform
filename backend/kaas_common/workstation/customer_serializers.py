"""客户/询盘序列化 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。

2026-10-18：客户阶段拆成两层
---------------------------
`customers.stage` 只存**手动状态**（active / inactive），而接口里对外的
`stage` 是**推导值**（有开启中的订单 ⇒ ordered）。所以序列化拆成两个字段：

  · `manual_stage` —— 库里的手动状态（客户页下拉用它回填）
  · `stage`        —— 对外展示值（活跃 / 沉寂 / 已下单）

`row_to_customer(c, display_stage=...)` 的 `display_stage` 由调用方用
`customer_rules.derive_customer_stage()` 算好传进来；不传时退回手动状态
（新建客户必然没有订单，等价于 active）。

2026-10-22（设计 §5 / §13.3）：询盘支持多产品行
---------------------------------------------
- `cust_inquiries.items` 是 jsonb 数组，每行
  `{product_key?, product_name_raw, spec_text?, quantity?, quantity_unit?, application?, notes?}`；
- **旧字段保留**（第一行同步写进 product_name_raw/quantity/quantity_unit/application），
  旧报表/链式分析不用改；
- 读取时 `items` 非空用 items；为空把旧字段**合成一行**，历史询盘照常显示。
"""
import json
from typing import Any, List, Optional

from .customer_rules import normalize_manual_stage

__all__ = ["row_to_customer", "row_to_inquiry", "inquiry_items", "normalize_inquiry_items"]


def row_to_customer(c: Any, display_stage: Optional[str] = None) -> dict:
    """客户 ORM 行/字典 → API 响应字典。

    `display_stage`：调用方按订单推导出的展示阶段（ordered / active / inactive）；
    缺省时用库里的手动阶段归一化后的值。
    """
    if isinstance(c, dict):
        g = c.get
    else:
        g = lambda k: getattr(c, k, None)
    manual = normalize_manual_stage(g("stage"))
    return {
        "id": g("id"),
        "company_name": g("name"),
        # 客户缩写（询盘编号用；可空）
        "abbr": g("abbr"),
        "country": g("country"),
        "address": g("address"),
        "default_port": g("default_port"),
        "credit_level": g("credit_level"),
        # 对外展示阶段（活跃 / 沉寂 / 已下单）
        "stage": display_stage or manual,
        # 手动状态（活跃 / 沉寂）—— 客户页「更新阶段」用它回填
        "manual_stage": manual,
        "notes": g("notes"),
        "created_at": _iso(g("created_at")),
        "updated_at": _iso(g("updated_at")),
    }


def row_to_inquiry(i: Any) -> dict:
    """询盘 ORM 行/字典 → API 响应字典。

    `items` 恒为数组（见模块头）：历史行（items 为空 / 读不到）用旧字段合成一行，
    前端不再需要自己判空分支。
    """
    if isinstance(i, dict):
        g = i.get
    else:
        g = lambda k: getattr(i, k, None)
    qty = g("quantity")
    return {
        "id": g("id"),
        "customer_id": g("customer_id"),
        "inquiry_no": g("inquiry_no"),
        "lead_id": g("lead_id"),
        "channel": g("channel"),
        "category_id": g("category_id"),
        "product_name_raw": g("product_name_raw"),
        "quantity": float(qty) if qty is not None else None,
        "quantity_unit": g("quantity_unit"),
        "application": g("application"),
        # 多产品行（迁移 202610220001）：非空用 items；空则用旧字段合成一行。
        "items": inquiry_items(i),
        "status": g("status"),
        # 询盘阶段（TODO(TODO:F4)，迁移 202610200003）：读不到 stage 的历史行按 status 退化，
        # 前端据此显示真实流程进度（展示推导仅作兜底）。
        "stage": g("stage"),
        "stage_updated_at": _iso(g("stage_updated_at")),
        "created_at": _iso(g("created_at")),
    }


def inquiry_items(row: Any) -> List[dict]:
    """询盘的多产品行（纯函数，两端共用）。

    取值顺序：
      1. `items` 是数组且非空 ⇒ 逐行归一化后返回；
      2. 否则用旧字段合成一行（历史询盘）；旧字段全空 ⇒ `[]`。

    asyncpg 在 Workers 里可能把 jsonb 返回成字符串，这里防御性 `json.loads`
    （与 `backend/worker/src/dbjson.py` 的口径一致：解析失败按空处理，不抛 500）。
    """
    g = row.get if isinstance(row, dict) else (lambda k: getattr(row, k, None))
    raw = g("items")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else []
        except ValueError:
            raw = []
    if isinstance(raw, list) and raw:
        return [normalize_inquiry_item(it) for it in raw if isinstance(it, dict)]
    legacy = {
        "product_key": None,
        "product_name_raw": g("product_name_raw"),
        "spec_text": None,
        "quantity": _float(g("quantity")),
        "quantity_unit": g("quantity_unit"),
        "application": g("application"),
        "notes": None,
    }
    if any(legacy[k] not in (None, "") for k in ("product_name_raw", "quantity",
                                                 "quantity_unit", "application")):
        return [legacy]
    return []


def normalize_inquiry_items(items: Any) -> List[dict]:
    """入参 items（list / JSON 字符串）→ 落库前归一化。

    只保留白名单键，未知键丢弃（避免把前端随手塞的字段写进 jsonb）；
    数量转 float（写 jsonb 时 JSON 数字）；空数组保持 `[]`。
    """
    if isinstance(items, str):
        try:
            items = json.loads(items) if items.strip() else []
        except ValueError:
            items = []
    if not isinstance(items, list):
        return []
    return [normalize_inquiry_item(it) for it in items if isinstance(it, dict)]


def normalize_inquiry_item(it: dict) -> dict:
    """单行询盘产品归一化（7 键，缺省 None）。"""
    name = it.get("product_name_raw")
    if name is None:
        # 兼容前端可能传 product_name（与订单行项命名一致）
        name = it.get("product_name")
    return {
        "product_key": _str_or_none(it.get("product_key")),
        "product_name_raw": _str_or_none(name),
        "spec_text": _str_or_none(it.get("spec_text")),
        "quantity": _float(it.get("quantity")),
        "quantity_unit": _str_or_none(it.get("quantity_unit")),
        "application": _str_or_none(it.get("application")),
        "notes": _str_or_none(it.get("notes")),
    }


def _str_or_none(v):
    if v is None:
        return None
    text = str(v).strip()
    return text or None


def _float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _iso(dt):
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)
