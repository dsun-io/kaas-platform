"""Kaas v2 · INT-R3 权限系统（§2）

权限点:
- cost:read / cost:write
- sale_price:read / sale_price:write
- pricing_profile:read / pricing_profile:write
- freight_rate:read / freight_rate:write
- quote:run
- quote:sensitive_debug
- admin:customer_read

角色默认权限:
- tenant_owner: all
- tenant_finance: cost, sale_price, pricing_profile, freight_rate (read+write) + quote:run
- tenant_pricing_admin: same as finance
- tenant_sales_manager: sale_price:read + quote:run
- tenant_sales: quote:run + sale_price:read (no cost)
- external_buyer: quote:run only
- platform_admin: all (audit required for cost access)
"""
from typing import Optional
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse

# ── Role → Permission mapping ──
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "platform_admin": {
        "cost:read", "cost:write",
        "sale_price:read", "sale_price:write",
        "pricing_profile:read", "pricing_profile:write",
        "freight_rate:read", "freight_rate:write",
        "quote:run", "quote:sensitive_debug",
        "admin:customer_read",
    },
    "tenant_owner": {
        "cost:read", "cost:write",
        "sale_price:read", "sale_price:write",
        "pricing_profile:read", "pricing_profile:write",
        "freight_rate:read", "freight_rate:write",
        "quote:run",
        "admin:customer_read",
    },
    "tenant_finance": {
        "cost:read", "cost:write",
        "sale_price:read", "sale_price:write",
        "pricing_profile:read", "pricing_profile:write",
        "freight_rate:read", "freight_rate:write",
        "quote:run",
    },
    "tenant_pricing_admin": {
        "cost:read", "cost:write",
        "sale_price:read", "sale_price:write",
        "pricing_profile:read", "pricing_profile:write",
        "freight_rate:read", "freight_rate:write",
        "quote:run",
    },
    "tenant_sales_manager": {
        "sale_price:read",
        "quote:run",
    },
    "tenant_sales": {
        "quote:run",
    },
    "external_buyer": {
        "quote:run",
    },
}

DEFAULT_ROLE = "tenant_sales"


def get_role(request: Request) -> str:
    """从请求头提取角色。dev 阶段用 X-Role header。"""
    return request.headers.get("X-Role", DEFAULT_ROLE)


def get_actor_id(request: Request) -> str:
    return request.headers.get("X-Actor-Id", "unknown")


def has_permission(role: str, permission: str) -> bool:
    perms = ROLE_PERMISSIONS.get(role, set())
    return permission in perms


async def require_permission(request: Request, permission: str):
    """FastAPI dependency — 校验当前角色有指定权限。"""
    role = get_role(request)
    if not has_permission(role, permission):
        raise HTTPException(
            status_code=403,
            detail={
                "error": "forbidden",
                "error_code": "INSUFFICIENT_PERMISSIONS",
                "message": f"Role '{role}' lacks required permission '{permission}'",
            },
        )
    return role


async def require_cost_read(request: Request):
    return await require_permission(request, "cost:read")


async def require_cost_write(request: Request):
    return await require_permission(request, "cost:write")


async def require_sale_price_read(request: Request):
    return await require_permission(request, "sale_price:read")


async def require_freight_write(request: Request):
    return await require_permission(request, "freight_rate:write")


SENSITIVE_FIELDS = frozenset({
    "cost_amount", "cost_per_kg", "cost_per_sqm", "margin_rate",
    "base_fee", "per_kg_after_threshold", "threshold_kg",
    "internal_cost_subtotal", "bottom_price",
})


def sanitize_payload(payload: dict) -> dict:
    """移除敏感字段，防止泄露到 response / events / logs。"""
    return {k: v for k, v in payload.items() if k not in SENSITIVE_FIELDS}
