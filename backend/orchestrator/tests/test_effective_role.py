"""Kaas v2 · 三层角色体系 (Wave 2 · T8) 验收测试

覆盖:
- AuthContext.effective_role 映射
- AuthContext.is_admin() 基于 effective_role
- permissions.py 三层角色权限校验
- auth_utils.require_internal 基于 effective_role
"""

import pytest
from unittest.mock import MagicMock


# ═══════════════════════════════════════════════════════════════
# AuthContext effective_role 映射测试
# ═══════════════════════════════════════════════════════════════

class TestAuthContextEffectiveRole:
    """测试 AuthContext.effective_role 正确映射旧角色到新三层体系。"""

    def test_system_admin_maps_to_system_admin(self):
        from app.core.auth import AuthContext
        ctx = AuthContext(user_id=1, account_type="internal", role="system_admin")
        assert ctx.effective_role == "system_admin"
        assert ctx.is_admin() is True

    def test_admin_maps_to_system_admin(self):
        from app.core.auth import AuthContext
        ctx = AuthContext(user_id=1, account_type="internal", role="admin")
        assert ctx.effective_role == "system_admin"
        assert ctx.is_admin() is True

    def test_owner_maps_to_customer_owner(self):
        from app.core.auth import AuthContext
        ctx = AuthContext(user_id=2, account_type="customer", role="owner")
        assert ctx.effective_role == "customer_owner"
        assert ctx.is_admin() is False

    def test_customer_owner_maps_to_customer_owner(self):
        from app.core.auth import AuthContext
        ctx = AuthContext(user_id=2, account_type="customer", role="customer_owner")
        assert ctx.effective_role == "customer_owner"
        assert ctx.is_admin() is False

    def test_user_maps_to_customer_member(self):
        from app.core.auth import AuthContext
        ctx = AuthContext(user_id=3, account_type="customer", role="user")
        assert ctx.effective_role == "customer_member"
        assert ctx.is_admin() is False

    def test_customer_member_maps_to_customer_member(self):
        from app.core.auth import AuthContext
        ctx = AuthContext(user_id=3, account_type="customer", role="customer_member")
        assert ctx.effective_role == "customer_member"
        assert ctx.is_admin() is False

    def test_unknown_role_fallback_to_customer_member(self):
        from app.core.auth import AuthContext
        ctx = AuthContext(user_id=4, account_type="customer", role="unknown_role")
        assert ctx.effective_role == "customer_member"


# ═══════════════════════════════════════════════════════════════
# permissions.py 三层角色权限测试
# ═══════════════════════════════════════════════════════════════

class TestEffectiveRolePermissions:
    """测试三层角色的权限分配。"""

    def test_system_admin_has_all_permissions(self):
        from app.core.permissions import has_permission
        assert has_permission("system_admin", "cost:read") is True
        assert has_permission("system_admin", "cost:write") is True
        assert has_permission("system_admin", "quote:run") is True
        assert has_permission("system_admin", "admin:customer_read") is True
        assert has_permission("system_admin", "quote:sensitive_debug") is True

    def test_customer_owner_has_customer_permissions(self):
        from app.core.permissions import has_permission
        assert has_permission("customer_owner", "cost:read") is True
        assert has_permission("customer_owner", "cost:write") is True
        assert has_permission("customer_owner", "quote:run") is True
        assert has_permission("customer_owner", "admin:customer_read") is True
        assert has_permission("customer_owner", "quote:sensitive_debug") is False

    def test_customer_member_has_limited_permissions(self):
        from app.core.permissions import has_permission
        assert has_permission("customer_member", "quote:run") is True
        assert has_permission("customer_member", "sale_price:read") is True
        assert has_permission("customer_member", "cost:read") is False
        assert has_permission("customer_member", "cost:write") is False
        assert has_permission("customer_member", "admin:customer_read") is False

    def test_old_role_backward_compatibility(self):
        from app.core.permissions import has_permission
        # tenant_owner → customer_owner permissions
        assert has_permission("tenant_owner", "cost:write") is True
        # tenant_sales → quote:run only
        assert has_permission("tenant_sales", "quote:run") is True
        assert has_permission("tenant_sales", "cost:read") is False


class TestRequirePermission:
    """测试 require_permission 依赖。"""

    @pytest.mark.asyncio
    async def test_require_permission_with_auth_context(self):
        from app.core.permissions import require_permission
        from app.core.auth import AuthContext

        mock_request = MagicMock()
        mock_request.state.auth = AuthContext(
            user_id=1, account_type="internal", role="system_admin"
        )
        role = await require_permission(mock_request, "cost:read")
        assert role == "system_admin"

    @pytest.mark.asyncio
    async def test_require_permission_denied(self):
        from app.core.permissions import require_permission
        from fastapi import HTTPException

        mock_request = MagicMock()
        mock_request.state.auth = None
        mock_request.headers.get.return_value = "customer_member"

        with pytest.raises(HTTPException) as exc_info:
            await require_permission(mock_request, "cost:read")
        assert exc_info.value.status_code == 403


# ═══════════════════════════════════════════════════════════════
# auth_utils.py 测试
# ═══════════════════════════════════════════════════════════════

class TestAuthUtilsEffectiveRole:
    """测试 auth_utils 使用 effective_role。"""

    def test_require_internal_with_system_admin(self):
        from app.core.auth_utils import require_internal
        from app.core.auth import AuthContext

        ctx = AuthContext(user_id=1, account_type="internal", role="system_admin")
        require_internal(ctx)  # should not raise

    def test_require_internal_with_admin_role(self):
        from app.core.auth_utils import require_internal
        from app.core.auth import AuthContext

        ctx = AuthContext(user_id=1, account_type="internal", role="admin")
        require_internal(ctx)  # admin → effective_role system_admin, should not raise

    def test_require_internal_with_customer_owner_fails(self):
        from app.core.auth_utils import require_internal
        from app.core.auth import AuthContext
        from fastapi import HTTPException

        ctx = AuthContext(user_id=2, account_type="customer", role="owner")
        with pytest.raises(HTTPException) as exc_info:
            require_internal(ctx)
        assert exc_info.value.status_code == 403
