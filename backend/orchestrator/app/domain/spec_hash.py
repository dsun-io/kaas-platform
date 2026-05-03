"""
Kaas v2 · spec_hash 规范算法 (§11 开放问题 4)
─────────────────────────────────────────────
Canonical JSON → SHA-256 前 16 hex。
sorted keys + ensure_ascii=False + separators 保证跨语言确定性。
"""
import hashlib
import json


def compute_spec_hash(product_spec: dict) -> str:
    """Canonical JSON → SHA-256 前 16 hex。"""
    canonical = json.dumps(
        product_spec,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
