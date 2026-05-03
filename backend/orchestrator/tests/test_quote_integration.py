"""Kaas v2 · 报价 V2 全链路集成测试 (INT-R3)

使用 client fixture（内建 DB 会话回滚），验证报价引擎各环节衔接。
"""
import pytest
pytestmark = pytest.mark.db


class TestQuoteV2Integration:
    """V2 报价引擎全链路测试（真实 DB 查询）。"""

    async def test_full_chain_matched_with_cost(self, client):
        """成本+策略完整 → matched 状态 + 三档报价。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 10,
            },
            headers={"X-Tenant-Id": "liankai", "X-Role": "tenant_owner"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "matched"
        tiers = data["main_line"]["tiers"]
        assert len(tiers) == 3
        labels = {t["label"] for t in tiers}
        assert labels == {"低", "标准", "高"}
        # Cost: 4.82 * 26.0 = 125.32, Low margin: 1.10 → 137.85
        assert tiers[0]["unit_price"] > 0
        assert data["main_line"]["quantity"] == 10

    async def test_full_chain_with_sale_price_override(self, client):
        """有销售价覆盖的客户 → 三档统一价。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 5,
            },
            headers={
                "X-Tenant-Id": "client_b",
                "X-Customer-Id": "client_b",
                "X-Role": "tenant_owner",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "matched"
        tiers = data["main_line"]["tiers"]
        assert len(tiers) >= 1
        # Sale price: 165.0/roll, all tiers same
        prices = {t["unit_price"] for t in tiers}
        assert len(prices) == 1
        assert list(prices)[0] == 165.0

    async def test_full_chain_with_freight(self, client):
        """含运费 → freight 信息完整。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 10,
                "province": "四川",
            },
            headers={"X-Tenant-Id": "liankai", "X-Role": "tenant_owner"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["freight"] is not None
        assert data["freight"]["province"] == "四川"
        assert data["freight"]["chosen"] is not None
        assert data["freight"]["chosen"]["amount"] > 0

    async def test_full_chain_no_match_returns_valid_response(self, client):
        """不存在的规格规格 → 降级正常响应（非 500）。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "99.9",
                "height": 99.9,
                "quantity": 1,
            },
            headers={"X-Tenant-Id": "liankai", "X-Role": "tenant_owner"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "no_match"
        assert "copyable_script" in data

    async def test_script_rendered_for_matched(self, client):
        """matched 状态的话术包含产品名称和报价梯度。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 10,
            },
            headers={"X-Tenant-Id": "liankai", "X-Role": "tenant_owner"},
        )
        assert response.status_code == 200
        data = response.json()
        script = data["copyable_script"]
        assert "牛栏网" in script
        assert "元/卷" in script
        assert "合计" in script

    async def test_script_rendered_for_no_match(self, client):
        """no_match 状态的话术包含错误说明。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "wire_diameter": "99.9",
                "height": 99.9,
                "quantity": 1,
            },
            headers={"X-Tenant-Id": "liankai", "X-Role": "tenant_owner"},
        )
        assert response.status_code == 200
        data = response.json()
        script = data["copyable_script"]
        assert "规格未匹配" in script or "未找到" in script
