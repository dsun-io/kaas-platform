"""Kaas v2 · OpenAPI Schema 测试 (§15.5)"""
import json
import pytest
pytestmark = pytest.mark.unit


@pytest.fixture
def openapi_doc():
    """加载导出的 OpenAPI JSON。"""
    from pathlib import Path
    doc_path = Path(__file__).resolve().parent.parent / "docs" / "openapi.json"
    if not doc_path.exists():
        pytest.skip("openapi.json not exported; run: python scripts/export_openapi.py")
    with open(doc_path, encoding="utf-8") as f:
        return json.load(f)


class TestOpenAPISchema:
    """OpenAPI 规范质量检查。"""

    def test_paths_count_at_least_10(self, openapi_doc):
        """paths >= 10。"""
        paths = openapi_doc.get("paths", {})
        assert len(paths) >= 10

    def test_quote_response_schema_exists(self, openapi_doc):
        """POST /api/v1/quote 有 200 response schema。"""
        path = openapi_doc["paths"].get("/api/v1/quote", {})
        post = path.get("post", {})
        resp200 = post.get("responses", {}).get("200", {})
        schema = resp200.get("content", {}).get("application/json", {}).get("schema")
        assert schema is not None, "QuoteResponse schema missing"

    def test_health_paths_have_schema(self, openapi_doc):
        """/health 系列的 200 response 有 schema。"""
        for p in ["/health", "/health/ready", "/health/deep"]:
            path = openapi_doc["paths"].get(p, {})
            get = path.get("get", {})
            resp200 = get.get("responses", {}).get("200", {})
            assert "content" in resp200, f"{p} missing response schema"

    def test_events_has_schema(self, openapi_doc):
        """POST /api/v1/events response 有 schema。"""
        path = openapi_doc["paths"].get("/api/v1/events", {})
        post = path.get("post", {})
        assert "responses" in post, "/api/v1/events missing responses"

    def test_admin_endpoints_have_schema(self, openapi_doc):
        """Admin 端点有 response schema。"""
        admin_paths = [p for p in openapi_doc["paths"] if p.startswith("/api/v1/admin")]
        assert len(admin_paths) >= 5
        for p in admin_paths:
            methods = openapi_doc["paths"][p]
            for method, detail in methods.items():
                if method in ("parameters",):
                    continue
                assert "responses" in detail, f"{method.upper()} {p} missing responses"
