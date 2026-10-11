"""团队级档位覆盖的读写：**改显示名 / 软停用**。

粒度为什么是**团队**（2026-10-11 用户裁决）
-------------------------------------------
档位 = **公司能做什么**，不该因买家而异。而 `tenant_id` 恒为 `"default"`、
已经不是隔离边界，**团队才是**。所以覆盖按 `(team_id, product_key)` 存。

与之相对，**成本价**仍是买家客户级 —— 那是"不同买家拿到不同价"的商务差异，
继续存在定价数据里（`customer_cost_items`），本模块不碰。

为什么单开一张表
----------------
不能塞进 `tenant_products`：那张表存的是**完整 ProductSpec 快照**，
把几个档位的改名写进去会让该租户的产品定义**冻成快照** ——
以后代码改了产品定义它不跟着变。所以只存"覆盖"，与产品定义解耦。

载荷形如::

    {"coating_code": {"rename": {"zinc_40": "40克锌层"},
                      "disabled": ["pvc_black"]}}

两条硬约束（与 `models.apply_option_overrides` 一致）：
  · **只改显示名，不改 code** —— code 是查价键的一半，一改历史数据就对不上。
  · **停用是软停用** —— 从界面清单消失，但引擎仍能解析，
    否则已引用该档位的历史报价单重算会失败。
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import TeamOptionOverride

# 一份覆盖里允许的键；写库前归一，免得脏键混进 JSONB
ALLOWED_KEYS = ("rename", "disabled")


def normalize_overrides(raw: Any) -> dict[str, dict]:
    """把外部来的覆盖载荷收敛成合法形状（只留 rename / disabled）。"""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict] = {}
    for field, payload in raw.items():
        if not isinstance(field, str) or not isinstance(payload, dict):
            continue
        entry: dict[str, Any] = {}
        rename = payload.get("rename")
        if isinstance(rename, dict):
            entry["rename"] = {str(k): str(v) for k, v in rename.items()}
        disabled = payload.get("disabled")
        if isinstance(disabled, (list, tuple, set)):
            entry["disabled"] = [str(x) for x in disabled]
        if entry:
            out[field] = entry
    return out


async def load_team_option_overrides(
    session: AsyncSession,
    team_id: Optional[int],
    product_key: str,
) -> dict[str, dict]:
    """读一个团队在某产品上的档位覆盖；没有就返回空字典。

    `team_id` 为空时返回空 —— **不做"全实例兜底"**：那会把别的团队的档位
    混进来，正是本次要避免的粒度错误。
    """
    if not team_id or not product_key:
        return {}
    row = (
        await session.execute(
            select(TeamOptionOverride).where(
                TeamOptionOverride.team_id == team_id,
                TeamOptionOverride.product_key == product_key,
            )
        )
    ).scalars().first()
    if row is None:
        return {}
    return normalize_overrides(row.overrides)


async def save_team_option_overrides(
    session: AsyncSession,
    team_id: int,
    product_key: str,
    overrides: dict,
) -> dict[str, dict]:
    """整体写入（upsert）。返回归一化后的载荷。"""
    payload = normalize_overrides(overrides)
    row = (
        await session.execute(
            select(TeamOptionOverride).where(
                TeamOptionOverride.team_id == team_id,
                TeamOptionOverride.product_key == product_key,
            )
        )
    ).scalars().first()
    if row is None:
        row = TeamOptionOverride(team_id=team_id, product_key=product_key,
                                 overrides=payload)
        session.add(row)
    else:
        # 整对象替换，JSONB 的原地改动 SQLAlchemy 不会认出来
        row.overrides = payload
    await session.flush()
    return payload


def merge_override(
    current: dict,
    field: str,
    *,
    rename: Optional[dict] = None,
    disable: Optional[list] = None,
    enable: Optional[list] = None,
) -> dict:
    """在现有一份覆盖上做增量修改，返回**新的**载荷（不改原对象）。

    `rename` 传 ``{code: 新显示名}``；显示名传空串表示**取消改名**（回到产品定义的写法）。
    `disable` / `enable` 增删软停用标记。
    """
    out = {k: dict(v) for k, v in normalize_overrides(current).items()}
    entry = out.setdefault(field, {})

    if rename:
        labels = dict(entry.get("rename") or {})
        for code, label in rename.items():
            if label in (None, ""):
                labels.pop(str(code), None)     # 取消改名
            else:
                labels[str(code)] = str(label)
        if labels:
            entry["rename"] = labels
        else:
            entry.pop("rename", None)

    disabled = list(dict.fromkeys(entry.get("disabled") or []))
    for code in (disable or []):
        if str(code) not in disabled:
            disabled.append(str(code))
    for code in (enable or []):
        if str(code) in disabled:
            disabled.remove(str(code))
    if disabled:
        entry["disabled"] = disabled
    else:
        entry.pop("disabled", None)

    if not entry:
        out.pop(field, None)
    return out
