"""spec_hash 规范算法（阶段 3 · 与 orchestrator app/domain/spec_hash.py 同一算法）。

⚠️ 同步义务：本文件与 backend/orchestrator/app/domain/spec_hash.py 保持逐字一致
（compute_spec_hash 部分）。两个运行时之间没有共享包机制，复制是结构性的；
改任何一侧必须同步另一侧，否则同一规格会算出不同 hash、报价匹配会断。
"""
from __future__ import annotations

import hashlib
import json


def compute_spec_hash(product_spec: dict) -> str:
    """Canonical JSON → SHA-256 前 16 hex。

    sorted keys + ensure_ascii=False + separators 保证跨语言确定性。
    """
    canonical = json.dumps(
        product_spec,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
