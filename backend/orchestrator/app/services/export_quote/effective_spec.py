"""P13 差异读路径纯逻辑层：基线 + 差异 → ProductSpec（不冻住）。

本文件是 **纯逻辑层**（不依赖 sqlalchemy / app.db / 任何业务模块），
只用 `spec_delta` + `tenant_products.spec_from_dict`。
它被 sync-shared.ps1 镜像进 worker（Pyodide 可跑），两端同源。

用法（由 `_effective_product` / `quote_api._effective_product` 在拿到基线 dict 后调用）：
    from app.services.export_quote.effective_spec import resolve_effective_product
    spec, warnings = resolve_effective_product(base_spec_dict, delta_dict)

- 无差异列 / 差异为空 ⇒ 直接用基线（"未设差异的团队跟着变"）；
- 有差异 ⇒ `apply_delta(base, delta)` 合并后再 `spec_from_dict` 当形状闸门；
- `base_spec_hash` 不匹配（上游改过）⇒ **不静默套用**，抛 `SpecUpstreamChanged`；
- 未知 `spec_version` ⇒ 抛 `SpecDeltaError`（422）。

当 tenant_products 表的 `override` 列（S5 迁移）生效后，调用方只需从行里读出 delta dict 传入，
这里直接生效（不冻住）。当前无 delta 列时，base_spec_dict 就是最终 spec。
"""
from __future__ import annotations

from typing import Any, Optional

from .spec_delta import SpecDeltaError, apply_delta, normalize_delta, spec_fingerprint
from .tenant_products import spec_from_dict, spec_to_dict


class SpecUpstreamChanged(Exception):
    """差异的 `base_spec_hash` 与当前基线不一致（上游已变更）⇒ 拒绝合并。"""


def resolve_effective_product(
    base_spec: Optional[dict],
    delta: Optional[dict],
) -> tuple[Optional[Any], list[str]]:
    """基线 + 差异 → `ProductSpec`；返回 `(spec_or_None, warnings)`。

    - `base_spec`：基线 dict（`spec_to_dict` 形态）或 None（产品不存在）。
    - `delta`：差异 dict（`spec_delta` 形态）或 None / 空（无覆盖）。
    - 返回 `(None, [])` = 产品不存在（调用方按原语义 404/400）。
    - 抛 `SpecUpstreamChanged` = `base_spec_hash` 不匹配（上游已变）。
    - 抛 `SpecDeltaError` = 差异非法（未知版本 / 未知字段 / 结构矛盾）。
    """
    if base_spec is None:
        return None, []
    if not delta:
        # 无差异 ⇒ 基线原样（"未设差异的团队跟着变"）
        return spec_from_dict(dict(base_spec)), []
    merged, report = apply_delta(base_spec, delta)
    return spec_from_dict(merged), list(report.warnings())


def assert_base_hash_match(base_spec: dict, delta: Optional[dict]) -> None:
    """差异带 `base_spec_hash` 时，校验它与当前基线指纹一致（不一致 ⇒ 抛异常）。"""
    if not delta:
        return
    norm = normalize_delta(delta)
    base_hash = norm.get("base_spec_hash")
    if base_hash is not None and base_hash != spec_fingerprint(base_spec):
        raise SpecUpstreamChanged(
            f"`base_spec_hash` 与当前基线不一致：差异写的是 {base_hash}，"
            f"当前基线是 {spec_fingerprint(base_spec)} —— 上游已变更，请人工复核这条差异后再合并"
        )
