"""
Kaas v2 · spec_hash 规范算法 (§11 开放问题 4)
─────────────────────────────────────────────
Canonical JSON → SHA-256 前 16 hex。
sorted keys + ensure_ascii=False + separators 保证跨语言确定性。
"""
import hashlib
import json
import unicodedata
from decimal import Decimal
from typing import Any, Callable, Optional


def compute_spec_hash(product_spec: dict) -> str:
    """Canonical JSON → SHA-256 前 16 hex。"""
    canonical = json.dumps(
        product_spec,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _normalize_value(v: Any) -> Any:
    """单值规范化: Decimal normalize + NFC unicode + strip。"""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float, Decimal)):
        return f"{Decimal(str(v)).normalize():f}"
    if isinstance(v, str):
        return unicodedata.normalize("NFC", v.strip())
    if isinstance(v, list):
        items = [_normalize_value(x) for x in v if x is not None and x != ""]
        return sorted(items, key=lambda x: json.dumps(x, ensure_ascii=False))
    if isinstance(v, dict):
        return {k: _normalize_value(val) for k, val in v.items()}
    raise TypeError(f"Unsupported type: {type(v)}")


def compute_sku_hash(
    category_code: str,
    spec_values: dict,
    unit_map: Optional[dict] = None,
    convert_fn: Optional[Callable] = None,
) -> str:
    """
    新版 SKU spec_hash: category_code + 规范化 spec_values → SHA-256[:32]。

    spec_values: { attribute_code: { "v": value, "u"?: unit, "g"?: group } }
    unit_map:    { attribute_code: base_unit_code }
    convert_fn:  (value, from_unit, to_unit) -> Decimal
    """
    normalized = {}
    for attr_code in sorted(spec_values.keys()):
        entry = spec_values[attr_code]
        if not isinstance(entry, dict) or "v" not in entry:
            continue
        raw_val = entry["v"]
        if raw_val is None or raw_val == "":
            continue
        if entry.get("u") and unit_map and attr_code in unit_map and convert_fn:
            try:
                raw_val = convert_fn(raw_val, entry["u"], unit_map[attr_code])
            except (ValueError, TypeError):
                pass
        normalized[attr_code] = _normalize_value(raw_val)

    payload = {"c": category_code, "v": normalized}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]
