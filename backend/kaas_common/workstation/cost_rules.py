"""产品成本历史 / 参考成本规则（两端共用，纯函数 / 标准库）。

用户口径（2026-10-18）：产品成本**手动输入**，每次输入存该产品历史；
无法获取成本时按历史算参考成本：

  1. 同产品 + 同规格（spec_hash）：取**最近一次**；
  2. 最近一次超过 30 天，或没有同规格记录 → 取近 30 天**中位数**；
  3. 仍没有 → 没有参考（调用方退回产品定义/规格默认值，或提示缺成本）。

「近 30 天」以 `now` 为基准，便于测试注入固定时间。
"""
from __future__ import annotations

import hashlib
import json
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional

__all__ = ["cost_spec_hash", "reference_cost", "cost_specs_of", "cost_snapshot_of"]

RECENT_DAYS = 30


def cost_specs_of(snapshot: Any) -> dict:
    """从成本历史快照里取**产品参数**（规格）。

    兼容两种形态：
      · 新形态：`{"product_key": ..., "specs": {...}, "cost_unit": "元/㎡"}`
      · 旧数据/直接传规格：`{"de": 2.0, "coating_code": "zinc_40"}`
    """
    if not isinstance(snapshot, Mapping):
        return {}
    nested = snapshot.get("specs")
    if isinstance(nested, Mapping):
        return dict(nested)
    return dict(snapshot)


def cost_snapshot_of(product_key: str, specs: Any, cost_unit: str = "") -> dict:
    """统一成本历史快照：**产品 + 完整产品参数 + 成本单位**。

    用户口径（2026-10-18）：成本历史不能只存产品，必须把该次报价的产品参数
    一起存下来（如勾花网的丝径/网孔/宽度/长度；勾花网成本按平米计）。
    """
    return {
        "product_key": product_key,
        "specs": dict(specs or {}),
        "cost_unit": cost_unit or "",
    }


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def cost_spec_hash(spec: Any) -> str:
    """规格快照指纹：同产品 + 同指纹才视为「同规格」。"""
    return hashlib.sha256(_canonical_json(spec or {}).encode("utf-8")).hexdigest()


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def _when(row: Mapping[str, Any]) -> Optional[datetime]:
    value = row.get("created_at")
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def reference_cost(
    rows: Iterable[Mapping[str, Any]],
    *,
    spec_hash: Optional[str] = None,
    now: Optional[datetime] = None,
    recent_days: int = RECENT_DAYS,
) -> Optional[dict]:
    """从历史行算参考成本；没有可用行 → None。

    返回 `{cost, source: "latest" | "median_30d", sample_count, as_of}`；
    `rows` 需含 `cost_pretax`、`created_at`、可选 `spec_hash`（按时间倒序与否均可）。
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    cutoff = now - timedelta(days=recent_days)

    valid: list[tuple[datetime, float, Optional[str]]] = []
    for row in rows:
        cost = _num(row.get("cost_pretax"))
        when = _when(row)
        if cost is None or when is None:
            continue
        valid.append((when, cost, row.get("spec_hash")))

    if not valid:
        return None
    valid.sort(key=lambda item: item[0], reverse=True)

    # 1) 同规格最近一次（不限 30 天）
    if spec_hash:
        for when, cost, row_hash in valid:
            if row_hash == spec_hash:
                return {
                    "cost": cost,
                    "source": "latest",
                    "sample_count": 1,
                    "as_of": when.isoformat(),
                }

    # 2) 近 30 天中位数
    recent = [cost for when, cost, _ in valid if when >= cutoff]
    if recent:
        return {
            "cost": float(statistics.median(recent)),
            "source": "median_30d",
            "sample_count": len(recent),
            "as_of": max(when for when, _, _ in valid if when >= cutoff).isoformat(),
        }

    # 3) 全部超 30 天：没有参考（不硬拿旧价当参考，避免报错价）
    return None
