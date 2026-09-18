"""Test intel API endpoints"""
import asyncio
import sys
sys.path.insert(0, '.')

from httpx import AsyncClient, ASGITransport
from app.main import app


async def test_intel_api():
    """Test intel API endpoints"""

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # Test 1: Health check (no auth required)
        print("Testing health endpoint...")
        response = await client.get("/health")
        assert response.status_code == 200
        print("✓ Health check passed")

        # Test 2: Intel shipments list (requires auth)
        print("\nTesting intel shipments list (no auth)...")
        response = await client.get("/api/v1/intel/shipments")
        # Should return 401 or 403 without auth
        assert response.status_code in [401, 403, 422]
        print(f"✓ Intel shipments auth check passed (status: {response.status_code})")

        # Test 3: Intel trade stats (requires auth)
        print("\nTesting intel trade stats (no auth)...")
        response = await client.get("/api/v1/intel/trade-stats")
        assert response.status_code in [401, 403, 422]
        print(f"✓ Intel trade stats auth check passed (status: {response.status_code})")

        # Test 4: Intel adapter runs (requires auth)
        print("\nTesting intel adapter runs (no auth)...")
        response = await client.get("/api/v1/intel/adapter-runs")
        assert response.status_code in [401, 403, 422]
        print(f"✓ Intel adapter runs auth check passed (status: {response.status_code})")

        # Test 5: Intel channels (requires auth)
        print("\nTesting intel channels (no auth)...")
        response = await client.get("/api/v1/intel/channels")
        assert response.status_code in [401, 403, 422]
        print(f"✓ Intel channels auth check passed (status: {response.status_code})")

        print("\n✅ All basic endpoint tests passed!")


if __name__ == "__main__":
    asyncio.run(test_intel_api())
