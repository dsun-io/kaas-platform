"""spec_hash 规范算法。

⚠️ 口径：方案 B 收敛后只有一个运行时（本 Worker），orchestrator 业务壳已删，本文件
即唯一实现（compute_spec_hash / normalize_value / compute_sku_hash 三个函数体），
无需再与第二侧保持同步；改本文件即改唯一真源，同一规格的 hash 全局一致。
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


_SKU_UNITS = ("g", "kg", "m", "mm", "cm2", "m2", "t")


def normalize_value(value) -> str:
    """数值/单位串归一化（与 orchestrator spec_hash.normalize_value 同算法）。

    「40 克」「40g」「40 g」→「40g」；「11×13」「11*13」「11x13」→「11*13」。
    仅改 spec_hash 的计算口径，不改规格表/报价表数据。
    """
    s = str(value or "").strip().lower().replace(" ", "").replace("×", "*").replace("х", "*")
    s = s.replace("x", "*") if "*" not in s and "/" not in s else s
    for unit in _SKU_UNITS:
        if s.endswith("/" + unit):
            return s[: -(len(unit) + 1)]
        if s.endswith(unit):
            body = s[: -len(unit)]
            if body and (body.replace(".", "", 1).isdigit()):
                return f"{body}{unit}"
    return s


def compute_sku_hash(product_category: str, spec: dict) -> str:
    """SKU 确定性哈希（全量 32 hex；与 orchestrator compute_sku_hash 同算法）。

    值归一化 + 排序键 → SHA-256 全量十六进制（含 category 前缀）。
    """
    canonical_pairs = [
        (str(k), normalize_value(v))
        for k, v in spec.items()
        if v is not None and str(v).strip() != ""
    ]
    canonical_pairs.sort(key=lambda kv: kv[0])
    canonical = "|".join(f"{k}={v}" for k, v in canonical_pairs)
    payload = f"{product_category.strip().lower()}::{canonical}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
