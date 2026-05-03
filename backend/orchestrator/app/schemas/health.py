"""Kaas v2 · 健康检查 Schema"""
from pydantic import BaseModel


class LivenessResponse(BaseModel):
    status: str


class ReadinessResponse(BaseModel):
    status: str
    checks: dict


class DeepCheckResponse(BaseModel):
    status: str
    checks: dict
