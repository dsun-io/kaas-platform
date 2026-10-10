"""Repository 模式 —— 数据访问逻辑抽成类，ORM/SQL 细节藏在内部。

API 层只调 Repository，不关心 SQLAlchemy 还是 asyncpg；
测试可用内存适配器 mock。

用法：
    from kaas_common.db.repositories import CustomerRepository
    repo = CustomerRepository(adapter)
    customer = await repo.get_by_id(tenant_id, customer_id)

适配器接口（各端自己实现）：
    class Adapter:
        async def fetch_one(self, sql: str, params: dict) -> Optional[dict]
        async def fetch_all(self, sql: str, params: dict) -> list[dict]
        async def execute(self, sql: str, params: dict) -> None
"""
from typing import Any, Optional, Protocol

from .queries import (
    CUSTOMER_LIST, CUSTOMER_BY_ID, CUSTOMER_INSERT, CUSTOMER_UPDATE,
    QUOTE_LIST, QUOTE_BY_ID, QUOTE_INSERT,
    ORDER_LIST, ORDER_BY_ID, ORDER_INSERT,
    INQUIRY_LIST, INQUIRY_INSERT,
)

__all__ = ["Adapter", "CustomerRepository", "QuoteRepository", "OrderRepository", "InquiryRepository"]


class Adapter(Protocol):
    """数据库适配器接口（SQLAlchemy 或 asyncpg 各自实现）。"""
    async def fetch_one(self, sql: str, params: dict) -> Optional[dict]: ...
    async def fetch_all(self, sql: str, params: dict) -> list[dict]: ...
    async def execute(self, sql: str, params: dict) -> None: ...


class CustomerRepository:
    def __init__(self, adapter: Adapter):
        self._db = adapter

    async def get_by_id(self, tenant_id: str, customer_id: int) -> Optional[dict]:
        return await self._db.fetch_one(CUSTOMER_BY_ID, {
            "tenant_id": tenant_id, "customer_id": customer_id,
        })

    async def list(self, tenant_id: str, stage: str = None, country: str = None,
                   q: str = None, limit: int = 50, offset: int = 0) -> list[dict]:
        return await self._db.fetch_all(CUSTOMER_LIST, {
            "tenant_id": tenant_id, "stage": stage, "country": f"%{country}%" if country else None,
            "q": f"%{q}%" if q else None, "limit": limit, "offset": offset,
        })

    async def create(self, tenant_id: str, **fields) -> dict:
        return await self._db.fetch_one(CUSTOMER_INSERT, {"tenant_id": tenant_id, **fields})

    async def update(self, tenant_id: str, customer_id: int, **fields) -> Optional[dict]:
        return await self._db.fetch_one(CUSTOMER_UPDATE, {
            "tenant_id": tenant_id, "customer_id": customer_id, **fields,
        })


class QuoteRepository:
    def __init__(self, adapter: Adapter):
        self._db = adapter

    async def get_by_id(self, tenant_id: str, quote_id: int) -> Optional[dict]:
        return await self._db.fetch_one(QUOTE_BY_ID, {
            "tenant_id": tenant_id, "quote_id": quote_id,
        })

    async def list(self, tenant_id: str, customer_id: int = None, status: str = None,
                   limit: int = 50, offset: int = 0) -> list[dict]:
        return await self._db.fetch_all(QUOTE_LIST, {
            "tenant_id": tenant_id, "customer_id": customer_id, "status": status,
            "limit": limit, "offset": offset,
        })

    async def create(self, tenant_id: str, **fields) -> dict:
        return await self._db.fetch_one(QUOTE_INSERT, {"tenant_id": tenant_id, **fields})


class OrderRepository:
    def __init__(self, adapter: Adapter):
        self._db = adapter

    async def get_by_id(self, tenant_id: str, order_id: int) -> Optional[dict]:
        return await self._db.fetch_one(ORDER_BY_ID, {
            "tenant_id": tenant_id, "order_id": order_id,
        })

    async def list(self, tenant_id: str, customer_id: int = None, status: str = None,
                   limit: int = 50, offset: int = 0) -> list[dict]:
        return await self._db.fetch_all(ORDER_LIST, {
            "tenant_id": tenant_id, "customer_id": customer_id, "status": status,
            "limit": limit, "offset": offset,
        })

    async def create(self, tenant_id: str, **fields) -> dict:
        return await self._db.fetch_one(ORDER_INSERT, {"tenant_id": tenant_id, **fields})


class InquiryRepository:
    def __init__(self, adapter: Adapter):
        self._db = adapter

    async def list(self, tenant_id: str, customer_id: int = None, status: str = None,
                   limit: int = 50, offset: int = 0) -> list[dict]:
        return await self._db.fetch_all(INQUIRY_LIST, {
            "tenant_id": tenant_id, "customer_id": customer_id, "status": status,
            "limit": limit, "offset": offset,
        })

    async def create(self, tenant_id: str, **fields) -> dict:
        return await self._db.fetch_one(INQUIRY_INSERT, {"tenant_id": tenant_id, **fields})
