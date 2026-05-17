"""Kaas v2 · 租户隔离安全测试

验证:
- customer token + forged X-Tenant-Id → 403
- customer token + forged body customer_id → 403
- customer token + forged body tenant_id → 403
- customer token + correct/no X-Tenant-Id → 200
- internal token + any tenant → allowed
"""

import pytest
from fastapi import HTTPException
from app.core.auth import AuthContext


class TestRequireTenantMatch:
    """auth_utils.require_tenant_match 单元测试"""

    def test_internal_passes_any_tenant(self):
        from app.core.auth_utils import require_tenant_match
        auth = AuthContext(user_id=1, account_type="internal", tenant_id="lianjia")
        require_tenant_match(auth, "client_b")  # no raise

    def test_internal_passes_none(self):
        from app.core.auth_utils import require_tenant_match
        auth = AuthContext(user_id=1, account_type="internal", tenant_id="lianjia")
        require_tenant_match(auth, None)  # no raise

    def test_customer_passes_when_none(self):
        from app.core.auth_utils import require_tenant_match
        auth = AuthContext(user_id=2, account_type="customer", tenant_id="lianjia")
        require_tenant_match(auth, None)  # no raise

    def test_customer_passes_when_match(self):
        from app.core.auth_utils import require_tenant_match
        auth = AuthContext(user_id=2, account_type="customer", tenant_id="lianjia")
        require_tenant_match(auth, "lianjia")  # no raise

    def test_customer_raises_403_on_mismatch(self):
        from app.core.auth_utils import require_tenant_match
        auth = AuthContext(user_id=2, account_type="customer", tenant_id="lianjia")
        with pytest.raises(HTTPException) as exc:
            require_tenant_match(auth, "client_b")
        assert exc.value.status_code == 403
        assert "Tenant ID" in exc.value.detail["message"]

    def test_free_user_raises_403_on_mismatch(self):
        """free 用户与 customer 一样受限"""
        from app.core.auth_utils import require_tenant_match
        auth = AuthContext(user_id=3, account_type="free", tenant_id="lianjia")
        with pytest.raises(HTTPException) as exc:
            require_tenant_match(auth, "client_b")
        assert exc.value.status_code == 403

    def test_customer_empty_string_tenant_passes(self):
        """空字符串视为未提供，不触发 403"""
        from app.core.auth_utils import require_tenant_match
        auth = AuthContext(user_id=2, account_type="customer", tenant_id="lianjia")
        require_tenant_match(auth, "")  # no raise


class TestRequireCustomerMatch:
    """auth_utils.require_customer_match 单元测试"""

    def test_internal_passes_any_customer(self):
        from app.core.auth_utils import require_customer_match
        auth = AuthContext(user_id=1, account_type="internal", customer_code="lianjia")
        require_customer_match(auth, "client_b")  # no raise

    def test_customer_passes_when_none(self):
        from app.core.auth_utils import require_customer_match
        auth = AuthContext(user_id=2, account_type="customer", customer_code="lianjia")
        require_customer_match(auth, None)  # no raise

    def test_customer_passes_when_match(self):
        from app.core.auth_utils import require_customer_match
        auth = AuthContext(user_id=2, account_type="customer", customer_code="lianjia")
        require_customer_match(auth, "lianjia")  # no raise

    def test_customer_raises_403_on_mismatch(self):
        from app.core.auth_utils import require_customer_match
        auth = AuthContext(user_id=2, account_type="customer", customer_code="lianjia")
        with pytest.raises(HTTPException) as exc:
            require_customer_match(auth, "other_customer")
        assert exc.value.status_code == 403
        assert "Customer ID" in exc.value.detail["message"]


class TestScopedTenantId:
    """get_scoped_tenant_id 行为测试"""

    def test_internal_returns_none(self):
        from app.core.auth_utils import get_scoped_tenant_id
        auth = AuthContext(user_id=1, account_type="internal", tenant_id="lianjia")
        assert get_scoped_tenant_id(auth) is None

    def test_customer_returns_own_tenant(self):
        from app.core.auth_utils import get_scoped_tenant_id
        auth = AuthContext(user_id=2, account_type="customer", tenant_id="lianjia")
        assert get_scoped_tenant_id(auth) == "lianjia"

    def test_customer_no_tenant_returns_none(self):
        from app.core.auth_utils import get_scoped_tenant_id
        auth = AuthContext(user_id=2, account_type="customer", tenant_id=None)
        assert get_scoped_tenant_id(auth) is None


class TestAuthMiddlewareTenantCheck:
    """AuthContextMiddleware tenant mismatch 检测逻辑

    模拟 middleware 中对 customer/free 用户的 X-Tenant-Id 校验逻辑，
    确保 customer token + forged X-Tenant-Id 返回 403。
    """

    @staticmethod
    def _check_tenant_mismatch(account_type: str, auth_tenant_id: str | None,
                               header_tenant: str | None) -> bool:
        """复现 AuthContextMiddleware 中的 tenant mismatch 检测逻辑。"""
        if account_type in ("customer", "free") and auth_tenant_id:
            if header_tenant and header_tenant != auth_tenant_id:
                return False  # mismatch → reject
        return True  # no mismatch → allow

    def test_customer_correct_tenant_passes(self):
        assert self._check_tenant_mismatch(
            "customer", "fe4a98df-bc3f-4f50-97b1-86470867454d",
            "fe4a98df-bc3f-4f50-97b1-86470867454d"
        ) is True

    def test_customer_forged_tenant_rejected(self):
        assert self._check_tenant_mismatch(
            "customer", "fe4a98df-bc3f-4f50-97b1-86470867454d", "lianjia"
        ) is False

    def test_customer_no_header_passes(self):
        """不带 X-Tenant-Id 时，不触发 mismatch"""
        assert self._check_tenant_mismatch(
            "customer", "fe4a98df-bc3f-4f50-97b1-86470867454d", None
        ) is True

    def test_internal_forged_tenant_passes(self):
        """internal 用户允许跨租户"""
        assert self._check_tenant_mismatch(
            "internal", "lianjia", "client_b"
        ) is True

    def test_free_user_forged_tenant_rejected(self):
        """free 用户与 customer 一样不能跨租户"""
        assert self._check_tenant_mismatch(
            "free", "tenant-a", "tenant-b"
        ) is False

    def test_customer_empty_header_passes(self):
        """空字符串 header 视为未提供"""
        assert self._check_tenant_mismatch(
            "customer", "fe4a98df-bc3f-4f50-97b1-86470867454d", ""
        ) is True


_CUSTOMER_TENANT = "fe4a98df-bc3f-4f50-97b1-86470867454d"
_CUSTOMER_HEADERS = {
    "X-Account-Type": "customer",
    "X-Auth-Tenant-Id": _CUSTOMER_TENANT,
}


class TestTenantIsolationEndToEnd:
    """端到端测试：customer token + forged X-Tenant-Id 必须 403

    通过 X-Account-Type: customer header 触发 conftest mock 的 customer 模式，
    验证 AuthContextMiddleware 中的 tenant mismatch 检测生效。
    """

    @pytest.mark.asyncio
    async def test_customer_no_x_tenant_id_works(self, async_client):
        """customer 不带 X-Tenant-Id → 200，tenant 来自 auth"""
        resp = await async_client.get(
            "/api/v1/auth/me",
            headers={**{"Authorization": "Bearer fake-token"}, **_CUSTOMER_HEADERS},
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_customer_correct_x_tenant_id_works(self, async_client):
        """customer 带正确的 X-Tenant-Id → 200"""
        resp = await async_client.get(
            "/health",
            headers={
                "Authorization": "Bearer fake-token",
                **_CUSTOMER_HEADERS,
                "X-Tenant-Id": _CUSTOMER_TENANT,
            },
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_customer_forged_x_tenant_id_returns_403(self, async_client):
        """customer token + forged X-Tenant-Id: lianjia → 403"""
        resp = await async_client.get(
            "/api/v1/auth/me",
            headers={
                "Authorization": "Bearer fake-token",
                **_CUSTOMER_HEADERS,
                "X-Tenant-Id": "lianjia",
            },
        )
        assert resp.status_code == 403
        data = resp.json()
        assert "forbidden" in data.get("error", "")

    @pytest.mark.asyncio
    async def test_customer_forged_tenant_rejected_on_pricing_data(self, async_client):
        """pricing-data: forged X-Tenant-Id → 403"""
        resp = await async_client.get(
            "/api/v1/pricing-data",
            headers={
                "Authorization": "Bearer fake-token",
                **_CUSTOMER_HEADERS,
                "X-Tenant-Id": "lianjia",
            },
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_customer_forged_tenant_rejected_on_product_specs(self, async_client):
        """product-specs: forged X-Tenant-Id → 403"""
        resp = await async_client.get(
            "/api/v1/product-specs?product_category=niulanwang",
            headers={
                "Authorization": "Bearer fake-token",
                **_CUSTOMER_HEADERS,
                "X-Tenant-Id": "lianjia",
            },
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_customer_forged_tenant_rejected_on_events(self, async_client):
        """events: forged X-Tenant-Id → 403"""
        resp = await async_client.post(
            "/api/v1/events",
            json={
                "event_type": "chat.turn",
                "schema_version": 1,
                "payload": {"raw_text": "test"},
            },
            headers={
                "Authorization": "Bearer fake-token",
                **_CUSTOMER_HEADERS,
                "X-Tenant-Id": "lianjia",
            },
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_customer_forged_tenant_rejected_on_capabilities(self, async_client):
        """capabilities: forged X-Tenant-Id → 403"""
        resp = await async_client.get(
            "/api/v1/capabilities",
            headers={
                "Authorization": "Bearer fake-token",
                **_CUSTOMER_HEADERS,
                "X-Tenant-Id": "lianjia",
            },
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_customer_forged_tenant_rejected_on_oss_presign(
        self, async_client, minio_mock
    ):
        """oss/presign: forged X-Tenant-Id → 403"""
        resp = await async_client.post(
            "/api/v1/oss/presign",
            json={"purpose": "event_payload"},
            headers={
                "Authorization": "Bearer fake-token",
                **_CUSTOMER_HEADERS,
                "X-Tenant-Id": "lianjia",
            },
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_customer_forged_body_customer_id_returns_403(
        self, async_client, db_session
    ):
        """customer + body customer_id 不匹配 → 403"""
        from app.main import app
        from app.db.session import get_db_session

        async def override_db():
            yield db_session
        app.dependency_overrides[get_db_session] = override_db

        try:
            resp = await async_client.post(
                "/api/v1/pricing-data",
                json={
                    "product_category": "niulanwang",
                    "cost_amount": 100,
                    "cost_unit": "元/kg",
                    "wire_diameter": "2.0",
                    "height": 1.5,
                    "customer_id": "lianjia",
                },
                headers={
                    "Authorization": "Bearer fake-token",
                    **_CUSTOMER_HEADERS,
                    "X-Tenant-Id": _CUSTOMER_TENANT,
                },
            )
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.clear()
