"""Kaas v2 · 通用 Schema"""
from pydantic import BaseModel
from typing import Any


class ErrorResponse(BaseModel):
    error_code: str
    message: str
    detail: dict[str, Any] | None = None


class PageResponse(BaseModel):
    total: int
    page: int = 1
    page_size: int = 20
