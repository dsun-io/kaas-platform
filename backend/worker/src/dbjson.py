"""JSONB 列解析的唯一真源（Python Worker 版）。

背景：asyncpg 在 Workers 环境里会把 jsonb 返回成 str，需要手动 `json.loads`。
历史上 `main.py` 与 `chain.py` 各存一份列映射与实现，**签名还不一致**
（`(row)` vs `(row, table)`），新增表时极易只改一处 → 前端拿到未解析的字符串。

用法：
- `row_to_dict(row, "research_runs")` —— 精确按表解码（chain.py 全部走这个）
- `row_to_dict(row)` —— 兼容旧调用：仅按 `market_ports` 的 jsonb 列解码
  （`main.py` 多数端点并不需要 jsonb 解码，保持历史行为不变）

⚠️ 新增带 jsonb 列的表时，**必须**在 `JSONB_COLS` 里登记，否则该列会以字符串返回。
"""

import json

# 表名 → 该表的 jsonb 列集合
JSONB_COLS: dict[str, set[str]] = {
    "lead_candidates": {"fit_reasons", "raw", "spec_normalized"},
    "leadgen_runs": {"config"},
    "outreach_campaigns": set(),
    "research_products": {"spec_normalized"},
    "research_runs": {"config"},
    "market_ports": {
        "suitable_cargo",
        "suitable_shipping_modes",
        "connected_corridors",
        "major_carriers",
    },
}

# 未指定表名时的历史行为：只解码 market_ports 的 jsonb 列
_MARKET_PORT_COLS: frozenset[str] = frozenset(JSONB_COLS["market_ports"])


def row_to_dict(row, table: str | None = None) -> dict:
    """把 asyncpg Record 转成 dict，并解析其中已知的 jsonb 列。

    table 为 None 时沿用历史行为（只解码 market_ports 的 jsonb 列）。
    """
    cols = JSONB_COLS.get(table, set()) if table else _MARKET_PORT_COLS
    d = dict(row)
    for k in cols & d.keys():
        v = d[k]
        if isinstance(v, str) and v:
            try:
                d[k] = json.loads(v)
            except Exception:
                pass
    return d
