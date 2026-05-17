"""
Kaas v2 · 统一鉴权工具（基于 AuthContext）
─────────────────────────────────────────
供所有 API 端点复用，不修改 AuthContext/auth middleware/token 校验。
"""
from fastapi import HTTPException
from app.core.auth import AuthContext


def require_internal(auth: AuthContext) -> None:
    """要求账号类型为 internal（管理员）。

    - account_type == "internal" 且 role 为 system_admin/admin 时通过
    - 否则 403，不泄露权限细节
    """
    if auth.account_type == "internal" and auth.role in ("system_admin", "admin"):
        return
    raise HTTPException(
        status_code=403,
        detail={"error": "forbidden", "message": "Admin access required"},
    )


def require_customer_access(auth: AuthContext, target_customer_id: int) -> None:
    """校验是否有权访问指定 customer（整数 PK）的数据。

    - internal：可访问任意 customer
    - customer/free：只能访问自己绑定的 customer
    - 否则 403，不泄露目标 customer 是否存在
    """
    if auth.is_internal():
        return
    if auth.customer_id is not None and auth.customer_id == target_customer_id:
        return
    raise HTTPException(
        status_code=403,
        detail={"error": "forbidden", "message": "Access to this customer's data is not allowed"},
    )


def require_customer_code_access(auth: AuthContext, customer_code: str) -> None:
    """校验是否有权访问指定 customer_code（Text 编码）的数据。

    用于需要按 Text customer_code（如 "lianjia"）过滤的旧表。
    - internal：可访问任意 customer
    - customer/free：只能访问自己绑定的 customer_code
    - 否则 403
    """
    if auth.is_internal():
        return
    if auth.customer_code is not None and auth.customer_code == customer_code:
        return
    raise HTTPException(
        status_code=403,
        detail={"error": "forbidden", "message": "Access to this customer's data is not allowed"},
    )


def require_tenant_access(auth: AuthContext, target_tenant_id: str) -> None:
    """校验是否有权访问指定 tenant 的数据。

    - internal：可访问任意 tenant
    - customer/free：只能访问自己绑定的 tenant
    - 否则 403，不泄露目标 tenant 是否存在
    """
    if auth.is_internal():
        return
    if auth.tenant_id is not None and auth.tenant_id == target_tenant_id:
        return
    raise HTTPException(
        status_code=403,
        detail={"error": "forbidden", "message": "Access to this tenant's data is not allowed"},
    )


def get_scoped_customer_id(auth: AuthContext) -> int | None:
    """获取当前用户可见的 customer_id。

    - internal：返回 None（不限制，调用方按需处理）
    - customer/free：返回 auth.customer_id（强制限定）
    """
    if auth.is_internal():
        return None
    return auth.customer_id


def get_scoped_tenant_id(auth: AuthContext) -> str | None:
    """获取当前用户可见的 tenant_id。

    - internal：返回 None（不限制，调用方按需处理）
    - customer/free：返回 auth.tenant_id（强制限定）
    """
    if auth.is_internal():
        return None
    return auth.tenant_id


def require_tenant_match(auth: AuthContext, request_tenant_id: str | None) -> None:
    """customer/free 用户携带的 tenant_id 必须与 AuthContext 一致，否则 403。

    - internal：不校验
    - customer/free：request_tenant_id 为空则放行；非空但与 auth 不一致则 403
    - 前端不应为 customer/free 请求注入租户覆盖参数
    """
    if auth.is_internal():
        return
    if request_tenant_id and request_tenant_id != auth.tenant_id:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "forbidden",
                "message": "Tenant ID does not match your authorized tenant",
            },
        )


def require_customer_match(auth: AuthContext, request_customer_id: str | None) -> None:
    """customer/free 用户携带的 customer_id 必须与 AuthContext 一致，否则 403。

    - internal：不校验
    - customer/free：request_customer_id 为空则放行；非空但与 auth.customer_code 不一致则 403
    """
    if auth.is_internal():
        return
    if request_customer_id and request_customer_id != auth.customer_code:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "forbidden",
                "message": "Customer ID does not match your authorized customer",
            },
        )
