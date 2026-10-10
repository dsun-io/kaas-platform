"""每日汇率拉取任务：USD/CNY 实时汇率入库（fx_rates）。

设计：
- 可独立运行（python scripts/fetch_fx_rates.py）或被定时任务调用；
- 多个汇率源依次尝试，失败自动降级到下一个；全部失败则沿用最近一条汇率并标 is_stale；
- ON CONFLICT (base_currency, quote_currency, rate_date) DO UPDATE 幂等，重复跑不产生重复行；
- 只负责"拉取 + 入库"，报价时由 ws_common.lock_fx_rate 读取当日快照。
"""
from __future__ import annotations

import json
import logging
import urllib.request
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch_fx_rates")


def _http_json(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "kaas-fx-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_from_erhost() -> Optional[Decimal]:
    """汇率 API（免费、无需鉴权）：返回 USD/CNY。"""
    try:
        data = _http_json("https://open.er-api.com/v6/latest/USD")
        rate = (data.get("rates") or {}).get("CNY")
        return Decimal(str(rate)) if rate else None
    except Exception as exc:  # noqa: BLE001 - 汇率源失败不应中断整个任务
        log.warning("er-api 拉取失败: %s", exc)
        return None


def fetch_from_frankfurter() -> Optional[Decimal]:
    """Frankfurter（欧洲央行）汇率源。"""
    try:
        data = _http_json("https://api.frankfurter.app/latest?from=USD&to=CNY")
        rate = (data.get("rates") or {}).get("CNY")
        return Decimal(str(rate)) if rate else None
    except Exception as exc:  # noqa: BLE001
        log.warning("frankfurter 拉取失败: %s", exc)
        return None


FX_SOURCES = (
    ("er-api", fetch_from_erhost),
    ("frankfurter", fetch_from_frankfurter),
)


async def fetch_and_store(db) -> dict:
    """拉取 USD/CNY 并写入 fx_rates。返回 {rate, source, is_stale}。"""
    rate: Optional[Decimal] = None
    source = ""
    for name, fn in FX_SOURCES:
        rate = fn()
        if rate is not None and rate > 0:
            source = name
            break
    is_stale = False
    if rate is None:
        # 全部汇率源失败 → 沿用最近一条，标记 is_stale，让报价界面能提示业务确认
        row = await db.fetchrow(
            "SELECT rate, source FROM fx_rates WHERE base_currency=$1 AND quote_currency=$2"
            " ORDER BY rate_date DESC LIMIT 1",
            "USD", "CNY",
        )
        if row is None:
            raise RuntimeError("所有汇率源均失败，且数据库中没有任何历史汇率可用")
        rate = row["rate"]
        source = "stale-fallback"
        is_stale = True

    today = date.today()
    await db.execute(
        "INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, source, is_stale, fetched_at)"
        " VALUES ($1, $2, $3, $4, $5, $6, $7)"
        " ON CONFLICT (base_currency, quote_currency, rate_date)"
        " DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source,"
        "   is_stale = EXCLUDED.is_stale, fetched_at = EXCLUDED.fetched_at",
        "USD", "CNY", rate, today, source, is_stale, datetime.now(timezone.utc),
    )
    log.info("USD/CNY = %s (source=%s, is_stale=%s)", rate, source, is_stale)
    return {"rate": str(rate), "source": source, "is_stale": is_stale}


if __name__ == "__main__":
    # 独立运行入口：用 orchestrator 的异步 session 跑一次
    import asyncio
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.db.session import async_session_factory  # noqa: E402

    async def _main() -> None:
        async with async_session_factory() as db:
            result = await fetch_and_store(db)
            print(json.dumps(result, ensure_ascii=False))

    asyncio.run(_main())
