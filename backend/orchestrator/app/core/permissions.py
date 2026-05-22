"""Kaas v2 · INT-R3 权限系统（§2）— 三层角色体系

权限点:
- cost:read / cost:write
- sale_price:read / sale_price:write
- pricing_profile:read / pricing_profile:write
- freight_rate:read / freight_rate:write
- quote:run
- quote:sensitive_debug
- admin:customer_read

三层角色权限映射 (Wave 2 · T4):
- system_admin (L1): 所有权限（平台管理员）
- customer_owner (L2): 客户域全部权限（读+写）
- customer_member (L3): 基本权限（quote:run, sale_price:read）

向后兼容: 旧角色（tenant_owner 等）仍通过 X-Role header 支持。
"""
from typing import Optional
from fastapi import Request, HTTPException

# ── 三层角色 → 权限映射 (新体系) ──
EFFECTIVE_ROLE_PERMISSIONS: dict[str, set[str]] = {
    "system_admin": {
        "cost:read", "cost:write",
        "sale_price:read", "sale_price:write",
        "pricing_profile:read", "pricing_profile:write",
        "freight_rate:read", "freight_rate:write",
        "quote:run", "quote:sensitive_debug",
        "admin:customer_read",
    },
    "customer_owner": {
        "cost:read", "cost:write",
        "sale_price:read", "sale_price:write",
        "pricing_profile:read", "pricing_profile:write",
        "freight_rate:read", "freight_rate:write",
        "quote:run",
        "admin:customer_read",
    },
    "customer_member": {
        "quote:run",
        "sale_price:read",
    },
}

# ── 旧角色 → 权限映射 (兼容层，过渡期使用) ──
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "platform_admin": EFFECTIVE_ROLE_PERMISSIONS["system_admin"],
    "tenant_owner": EFFECTIVE_ROLE_PERMISSIONS["customer_owner"],
    "tenant_finance": EFFECTIVE_ROLE_PERMISSIONS["customer_owner"],
    "tenant_pricing_admin": EFFECTIVE_ROLE_PERMISSIONS["customer_owner"],
    "tenant_sales_manager": {"sale_price:read", "quote:run"},
    "tenant_sales": {"quote:run"},
    "external_buyer": {"quote:run"},
}

DEFAULT_ROLE = "customer_member"


def get_role(request: Request) -> str:
    """提取当前请求的有效角色。

    优先级:
    1. request.state.auth.effective_role (AuthContext，推荐)
    2. X-Role header (旧兼容层，dev 阶段)
    3. DEFAULT_ROLE (customer_member)
    """
    auth = getattr(request.state, "auth", None)
    if auth is not None:
        return getattr(auth, "effective_role", DEFAULT_ROLE)
    return request.headers.get("X-Role", DEFAULT_ROLE)


def get_actor_id(request: Request) -> str:
    return request.headers.get("X-Actor-Id", "unknown")


def has_permission(role: str, permission: str) -> bool:
    """检查角色是否拥有指定权限。同时支持三层新角色和旧角色兼容层。"""
    perms = EFFECTIVE_ROLE_PERMISSIONS.get(role) or ROLE_PERMISSIONS.get(role, set())
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
