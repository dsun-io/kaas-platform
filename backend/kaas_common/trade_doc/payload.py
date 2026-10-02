"""单证 payload 装配 —— 字段合成 / 快照冻结 / 方案应用（纯函数）。

优先级（**手工 > 派生 > 主体 > 默认**）：业务员手工改过的内容永不被自动覆盖——
这是沿用 trade_doc_payload 的合成语义，此处抽成纯函数供两后端共用（G1）。

方案（scheme）语义（2026-09-30 用户裁决）：
- QUO 可带多方案（如 3万米/5万米）供客户比较，各方案单价存 items[].scheme_prices。
- PI/CI/PL **不做方案选择器**：apply_scheme 只是把选定方案的 qty/单价**物化**到
  行项目（报价准确场景一键应用），物化后仍可逐行手改。
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping, Sequence

from .rules import check_line_amount, RuleError, ITEMS_INVALID


# ─── 字段合成 ──────────────────────────────────────────────────────────────

def deep_merge(*layers: Mapping[str, Any] | None) -> dict:
    """深合并（后者覆盖前者，None 层跳过）。列表整体替换，不拼接。"""
    out: dict[str, Any] = {}
    for layer in layers:
        if not layer:
            continue
        for key, value in layer.items():
            if value is None:
                continue
            if isinstance(value, Mapping) and isinstance(out.get(key), dict):
                out[key] = deep_merge(out[key], value)
            else:
                out[key] = deepcopy(value)
    return out


def compose_fields(
    *,
    defaults: Mapping[str, Any] | None = None,
    derived: Mapping[str, Any] | None = None,
    subjects: Mapping[str, Any] | None = None,
    manual: Mapping[str, Any] | None = None,
) -> dict:
    """字段合成入口（低→高优先级）：默认 → 派生/上游 → 买卖主体 → 手工。"""
    return deep_merge(defaults, derived, subjects, manual)


# ─── 快照冻结 ──────────────────────────────────────────────────────────────

def freeze_snapshot(source: Mapping[str, Any] | None) -> dict:
    """开单瞬间冻结上游快照：深拷贝防引用污染，下游变更不回写。"""
    return deepcopy(dict(source or {}))


def derive_payload(
    source_payload: Mapping[str, Any],
    *,
    source_kind: str,
    doc_type: str,
    manual: Mapping[str, Any] | None = None,
    extra_sources: Mapping[str, Any] | None = None,
) -> dict:
    """派生建单的 raw_payload 装配。

    结构：
        {"sources": {"<kind>": 快照, ...}, "custom": {手工/派生字段}, "derived": {溯源}}
    快照冻结：源单证后继变更**不影响**已派生单据（历史不失真）。
    """
    sources: dict[str, Any] = {}
    if source_kind:
        # 派生源：整份 raw_payload 冻结（含其 sources/custom）
        sources[source_kind] = freeze_snapshot(source_payload)
    for kind, snap in (extra_sources or {}).items():
        sources[kind] = freeze_snapshot(snap)

    # 派生继承：源单 custom 为底（低优先级），手工覆盖
    inherited = dict((source_payload or {}).get("custom") or {})
    custom = deep_merge(inherited, manual)
    return {
        "sources": sources,
        "custom": custom,
        "derived": {"from_kind": source_kind, "doc_type": doc_type},
    }


# ─── 方案（多方案报价 → 派生单物化）────────────────────────────────────────

def scheme_names(items: Sequence[Mapping[str, Any]]) -> list[str]:
    """从行项目的 scheme_prices 收集方案名（保持出现顺序、去重）。"""
    names: list[str] = []
    for it in items:
        for name in (it.get("scheme_prices") or {}):
            if name not in names:
                names.append(name)
    return names


def resolve_scheme(items: Sequence[Mapping[str, Any]], scheme_key: str | None) -> str | None:
    """方案确定：单方案自动应用；多方案须指定（API 层可回传候选列表）。

    返回最终方案名；多方案且未指定时返回 None（调用方按"参考值带入"处理）。
    """
    names = scheme_names(items)
    if not names:
        return None
    if scheme_key is not None:
        if scheme_key not in names:
            raise RuleError(ITEMS_INVALID, f"未知方案「{scheme_key}」；可选: {names}")
        return scheme_key
    return names[0] if len(names) == 1 else None


def apply_scheme(
    items: Sequence[Mapping[str, Any]],
    scheme_key: str | None,
) -> list[dict]:
    """把选定方案的 qty/单价**物化**到行项目（PI 直接应用场景）。

    - 每行 scheme_prices[scheme_key] 覆盖该行的 qty/unit_price/line_amount；
    - 未命中方案价的行保持原值（自由行不受方案影响）；
    - 物化结果仍是普通行项目，业务员可逐行手改（改过即手工，不再被覆盖）。
    """
    key = resolve_scheme(items, scheme_key)
    if key is None:
        return [deepcopy(dict(it)) for it in items]

    out: list[dict] = []
    for it in items:
        row = deepcopy(dict(it))
        scheme_price = (row.get("scheme_prices") or {}).get(key) or {}
        if scheme_price:
            if scheme_price.get("qty") is not None:
                row["qty"] = scheme_price["qty"]
            if scheme_price.get("unit_price") is not None:
                row["unit_price"] = scheme_price["unit_price"]
            # 行金额按物化后的 qty×price 重算并勾稽
            row["line_amount"] = check_line_amount(row)
            row["source"] = "generated"
        out.append(row)
    return out


# ─── 行项目装配（create 用）────────────────────────────────────────────────

def normalize_items(raw_items: Sequence[Mapping[str, Any]] | None) -> list[dict]:
    """入库前行项目规范化：补 group_no/source、行金额勾稽落定。"""
    out: list[dict] = []
    for i, it in enumerate(raw_items or [], 1):
        row = deepcopy(dict(it))
        row.setdefault("group_no", 0)
        row.setdefault("source", "manual")
        row["line_amount"] = check_line_amount(row)
        row["_sort"] = i
        out.append(row)
    return out
