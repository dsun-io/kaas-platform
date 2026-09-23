"""worker 路由级基础测试（阶段 3「补线上接口」用；无数据库、无网络）。

验证两件事：
1. 历史接口面（27 条路由）完好未动；
2. 阶段 3 新补的线上接口已注册到正确路径与方法。

测试方法：stub 掉 Cloudflare 运行时专用的 `workers` 包后加载 main，
断言路由表，并用 FastAPI TestClient 打无凭据请求——鉴权依赖先于数据库
返回 401，即可证明路由与依赖链活着（不需要数据库）。

运行：cd backend/worker && uv run --frozen --with pytest python -m pytest tests -q
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# ── stub `workers`（仅 Cloudflare 运行时提供）────────────────────────────────
_workers = types.ModuleType("workers")


class _WorkerEntrypoint:  # main.py 只需可子类化
    pass


def _asgi(app):
    return app


_workers.WorkerEntrypoint = _WorkerEntrypoint
_workers.asgi = _asgi
sys.modules.setdefault("workers", _workers)

# test_product_extract 可能把 main 顶替成 stub；真加载前清掉
sys.modules.pop("main", None)

import main as worker_main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)


def _routes() -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for r in worker_main.app.routes:
        for m in (getattr(r, "methods", None) or set()):
            out.add((r.path, m))
    return out


# 历史接口面基线（阶段 3 之前既有，一条不许少）
EXISTING_ROUTES = {
    ("/api/v1/auth/bootstrap-admin", "POST"),
    ("/api/v1/auth/login", "POST"),
    ("/api/v1/auth/me", "GET"),
    ("/api/v1/intel/shipments", "GET"),
    ("/api/v1/intel/shipments/{shipment_id}", "GET"),
    ("/api/v1/intel/shipments", "POST"),
    ("/api/v1/intel/import/csv", "POST"),
    ("/api/v1/intel/trade-stats", "GET"),
    ("/api/v1/intel/adapter-runs", "GET"),
    ("/api/v1/intel/channels", "GET"),
    ("/api/v1/customers", "GET"),
    ("/api/v1/customers", "POST"),
    ("/api/v1/customers/{customer_id}", "GET"),
    ("/api/v1/customers/{customer_id}/contacts", "POST"),
    ("/api/v1/customers/{customer_id}/inquiries", "POST"),
    ("/api/v1/customers/{customer_id}/stage", "PATCH"),
    ("/api/v1/market/regions", "GET"),
    ("/api/v1/market/regions/{region_code}/products", "GET"),
    ("/api/v1/market/name-lookup", "GET"),
    ("/api/v1/market/name-mappings", "POST"),
    ("/api/v1/market/usages", "GET"),
    ("/api/v1/market/ports", "GET"),
    ("/api/v1/subscriptions", "GET"),
    ("/api/v1/subscriptions/bundles", "GET"),
    ("/api/v1/dashboard/summary", "GET"),
    ("/health", "GET"),
    ("/api/v1/events", "POST"),
}

# 阶段 3 新补的线上接口（每补一个接口在此追加一条）
NEW_ROUTES: set[tuple[str, str]] = {
    ("/api/v1/quotations", "GET"),
    ("/api/v1/quotations", "POST"),
    ("/api/v1/pricing-data", "GET"),
    ("/api/v1/pricing-data", "POST"),
    ("/api/v1/pricing-data/{item_id}", "PATCH"),
    ("/api/v1/pricing-data/{item_id}", "DELETE"),
    ("/api/v1/spec/skus/{sku_id}/prices", "POST"),
    ("/api/v1/spec/prices/{price_id}", "PATCH"),
    # 第二批：规格分类树 / 向导 / 事件列表 / 管理 / 能力
    ("/api/v1/spec/categories", "GET"),
    ("/api/v1/spec/categories/{category_id}", "GET"),
    ("/api/v1/spec/categories/{category_id}/bindings", "GET"),
    ("/api/v1/spec/wizard/submit", "POST"),
    ("/api/v1/spec/wizard/propose-attribute", "POST"),
    ("/api/v1/events", "GET"),
    ("/api/v1/admin/feature_flag", "GET"),
    ("/api/v1/admin/feature_flag", "POST"),
    ("/api/v1/admin/tenants", "GET"),
    ("/api/v1/admin/tenants/reload", "POST"),
    ("/api/v1/admin/audit-log", "GET"),
    ("/api/v1/admin/archive-logs", "GET"),
    ("/api/v1/capability-customers", "GET"),
    ("/api/v1/capabilities", "GET"),
    ("/api/v1/capabilities", "POST"),
    ("/api/v1/customer/{customer_id}/capabilities", "GET"),
    ("/api/v1/customer/{customer_id}/capabilities", "PATCH"),
    # 阶段 6 任务 2：订单工位（D1 订单 CRUD）
    ("/api/v1/orders", "GET"),
    ("/api/v1/orders", "POST"),
    ("/api/v1/orders/{order_id}", "GET"),
    ("/api/v1/orders/{order_id}", "PATCH"),
    ("/api/v1/orders/{order_id}/status", "POST"),
    # D3：付款计划 + 应收台账
    ("/api/v1/orders/{order_id}/payment-schedules", "GET"),
    ("/api/v1/orders/{order_id}/payment-schedules", "POST"),
    ("/api/v1/payment-schedules/{schedule_id}", "PATCH"),
    ("/api/v1/receivables", "GET"),
    # E：外贸票据工位
    ("/api/v1/trade-docs", "GET"),
    ("/api/v1/trade-docs", "POST"),
    ("/api/v1/trade-docs/{doc_id}", "GET"),
    ("/api/v1/trade-docs/{doc_id}", "PATCH"),
}


def test_existing_routes_intact():
    assert EXISTING_ROUTES <= _routes()


def test_new_routes_registered():
    if not NEW_ROUTES:
        return
    assert NEW_ROUTES <= _routes()


def test_new_routes_answer_auth_challenge():
    """新接口无凭据应返回 401/403（鉴权在数据库之前），而不是 404。"""
    for path, method in sorted(NEW_ROUTES):
        # 带路径参数的路由用占位值打
        probe = path.replace("{shipment_id}", "1").replace("{customer_id}", "1")
        probe = (
            probe.replace("{item_id}", "1")
            .replace("{sku_id}", "1")
            .replace("{price_id}", "1")
            .replace("{category_id}", "1")
            .replace("{order_id}", "1")
            .replace("{schedule_id}", "1")
            .replace("{doc_id}", "1")
        )
        resp = client.request(method, probe)
        assert resp.status_code != 404, f"{method} {path} 未注册"
        assert resp.status_code in (401, 403, 422), (
            f"{method} {path} 无凭据应先被鉴权拦截，实际 {resp.status_code}"
        )


def test_stage6_orders_unauthorized():
    resp = client.get("/api/v1/orders")
    assert resp.status_code == 401
    resp = client.post("/api/v1/orders", json={"customer_name": "x"})
    assert resp.status_code == 401
