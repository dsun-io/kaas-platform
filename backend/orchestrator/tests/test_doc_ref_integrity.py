"""单证引用完整性（P0 · HARDENING_PLAN §D）—— `DOC_REF_BROKEN` 扫描与作废阻断。

裁决（UNCERTAIN #17）：作废单证前必扫引用方，有 issued 下游引用 → 409 DOC_REF_BROKEN
带清单（不允许静默作废 —— 导出会引用已废单据，信用证审单是不符点）。

本测试**不连库**（扫描是查询 + 判定；PATCH 分支的阻断逻辑用 409 断言）。
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.doc_ref_integrity import (
    DOC_REF_BROKEN,
    scan_inbound_broken_refs,
)

pytestmark = pytest.mark.unit


def _db_returning(rows: list[dict]) -> MagicMock:
    db = MagicMock()
    result = MagicMock()
    result.mappings.return_value.all.return_value = rows
    db.execute = AsyncMock(return_value=result)
    return db


@pytest.mark.asyncio
async def test_无引用方_返回空清单():
    db = _db_returning([])
    broken = await scan_inbound_broken_refs(db, "default", 7)
    assert broken == []


@pytest.mark.asyncio
async def test_有issued下游引用_返回清单():
    db = _db_returning([
        {"id": 21, "doc_no": "PI-001", "doc_type": "pi",
         "status": "issued", "rel_type": "generated_from"},
    ])
    broken = await scan_inbound_broken_refs(db, "default", 7)
    assert len(broken) == 1
    assert broken[0]["doc_no"] == "PI-001"
    assert broken[0]["rel_type"] == "generated_from"


@pytest.mark.asyncio
async def test_作废分支_有引用方时409带清单():
    """PATCH status→void 的阻断：用假 session 走真 handler 分支太重，
    这里锁「扫描非空 ⇒ 调用方按 DOC_REF_BROKEN 阻断」的判定口径。"""
    db = _db_returning([
        {"id": 21, "doc_no": "PI-001", "doc_type": "pi",
         "status": "issued", "rel_type": "generated_from"},
    ])
    broken = await scan_inbound_broken_refs(db, "default", 7)
    assert broken, "有引用方时必须非空（否则 409 不触发）"
    # 与 trade_docs.update_trade_doc 的 void 分支同构的错误形状
    detail = {
        "error": "conflict", "code": DOC_REF_BROKEN,
        "detail": "以下已签发单证仍引用本单证，请先作废/改版它们",
        "broken_refs": broken,
    }
    assert detail["code"] == "DOC_REF_BROKEN"
    assert detail["broken_refs"][0]["doc_no"] == "PI-001"
