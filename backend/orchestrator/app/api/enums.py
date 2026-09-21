"""Kaas v2 · 业务枚举字典 API（WORKSTATION_DESIGN.md §10.4）

GET /api/v1/enums — 返回前后端共用的合法值清单。
前端渲染下拉/标签必须以此为准，禁止硬编码另一份（不变量11）。
"""
from fastapi import APIRouter

from app.domain.enums import ENUMS

router = APIRouter(prefix="/api/v1", tags=["enums"])


@router.get("/enums")
async def list_enums():
    return {k: list(v) for k, v in ENUMS.items()}
