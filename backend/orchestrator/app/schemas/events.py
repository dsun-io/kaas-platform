"""Kaas v2 · Events Schema"""
from pydantic import BaseModel
from datetime import datetime


class EventResponse(BaseModel):
    id: int
    event_type: str
    tenant_id: str
    trace_id: str | None = None
    schema_version: int
    created_at: str | None = None
