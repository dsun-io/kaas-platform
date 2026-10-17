"""单证引用完整性（P0 · TRADE_DOC_HARDENING_PLAN §D）—— `DOC_REF_BROKEN` 扫描。

背景（2026-10-12 Tim 单复盘）：单证之间有派生/引用关系（`entity_links` 边表），
上游单证被作废后，引用它的下游单证**不会自动知道**——导出的单证会引用一张
已作废的单据，信用证审单就是不符点。

裁决（UNCERTAIN #17 · 2026-10-17）：
- 被引用单证必须是 `issued` 且有效（`void` 即无效）；
- **作废一份单证前必扫引用方**：有 issued 下游引用它 → `DOC_REF_BROKEN` 阻断
  （下游还在用一张即将作废的单据，不允许静默作废）；
- 清单随 409 返回，调用方按清单提示用户先处理下游。

本模块是纯查询/判定（不改状态），两端各自薄封装（orchestrator 用 SQLAlchemy，
worker 用 asyncpg 同语义 SQL）。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import text

__all__ = ["scan_inbound_broken_refs", "DOC_REF_BROKEN"]

DOC_REF_BROKEN = "DOC_REF_BROKEN"

# 找「引用本单证的下游单证」：entity_links 里 dst = 本单证、src = 单证的边，
# 且下游还是 issued（还在用）——本单证一作废，这条引用就断了。
_SCAN_INBOUND_SQL = """
SELECT d.id, d.doc_no, d.doc_type, d.status, l.rel_type
FROM entity_links l
JOIN trade_docs d
  ON d.tenant_id = l.tenant_id AND d.id = l.src_id
WHERE l.tenant_id = :tenant_id
  AND l.dst_type = 'trade_doc' AND l.dst_id = :doc_id
  AND l.src_type = 'trade_doc'
  AND l.deleted_at IS NULL
  AND d.status = 'issued'
ORDER BY d.id
"""


async def scan_inbound_broken_refs(
    db: Any, tenant_id: str, doc_id: int
) -> list[dict]:
    """作废前必扫：返回「还引用着本单证的 issued 下游单证」清单。

    清单项：`{id, doc_no, doc_type, status, rel_type}`；空列表 = 可安全作废。
    """
    rows = (
        await db.execute(
            text(_SCAN_INBOUND_SQL),
            {"tenant_id": tenant_id, "doc_id": doc_id},
        )
    ).mappings().all()
    return [dict(r) for r in rows]
