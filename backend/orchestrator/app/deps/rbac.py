"""
RBAC 三级角色 Depends:
  - require_tenant_viewer:  任何已认证用户（含查看者）
  - require_tenant_admin:   租户管理员 (users.is_tenant_admin = TRUE 或 internal admin)
  - require_platform_ops:   平台运营 (account_type='internal' + role in system_admin/admin)
"""
from fastapi import HTTPException, Request

from app.core.auth import AuthContext


def _get_auth(request: Request) -> AuthContext:
    auth = getattr(request.state, "auth", None)
    if auth is None:
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    return auth


def require_tenant_viewer(request: Request) -> AuthContext:
    """任何已认证用户均可。"""
    return _get_auth(request)


def require_tenant_admin(request: Request) -> AuthContext:
    """租户管理员: is_tenant_admin=True 或 internal admin。"""
    auth = _get_auth(request)
    if auth.is_internal() and auth.is_admin():
        return auth
    # is_tenant_admin 由 middleware 或 get_auth_context 注入到 AuthContext
    # 需要从 request.state 获取完整 user 信息
    user = getattr(request.state, "user", None)
    if user and getattr(user, "is_tenant_admin", False):
        return auth
    # 兼容: AuthContext 上直接检查
    if getattr(auth, "is_tenant_admin", False):
        return auth
    raise HTTPException(status_code=403, detail={"error": "forbidden", "message": "Tenant admin required"})


def require_platform_ops(request: Request) -> AuthContext:
    """平台运营: internal + system_admin/admin。"""
    auth = _get_auth(request)
    if auth.is_internal() and auth.is_admin():
        return auth
    raise HTTPException(status_code=403, detail={"error": "forbidden", "message": "Platform operator required"})
