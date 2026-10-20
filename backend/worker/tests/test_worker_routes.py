"""worker 路由级基础测试（阶段 3「补线上接口」用；无数据库、无网络）。

验证两件事：
1. 历史接口面（27 条路由）完好未动；
2. 阶段 3 新补的线上接口已注册到正确路径与方法。

测试方法：stub 掉 Cloudflare 运行时专用的 `workers` 包后加载 main，
断言路由表，并用 FastAPI TestClient 打无凭据请求——鉴权依赖先于数据库
返回 401，即可证明路由与依赖链活着（不需要数据库）。

运行：cd backend/worker && uv run --frozen --with pytest --with httpx2 python -m pytest tests -q

`--with httpx2` 是必需的：starlette >= 1.0 的 TestClient 依赖 httpx2，而它不在
项目依赖里（线上 bundle 用不到，Cloudflare 对启动 CPU 有额度）。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# 统一起手式：stub `workers` 并**彻底重载** main（含全部同级路由模块）。
# 别自己 pop("main") —— 那会得到新 app + 旧子模块，路由全丢（见 _bootstrap.py）。
from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

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
    # C36（2026-10-21 用户批准删除，旧规格库价格体系退役）：
    # `POST /api/v1/spec/skus/{sku_id}/prices` 与 `PATCH /api/v1/spec/prices/{price_id}`
    # 已从路由表删除，**不再**登记（若哪天回归，下面的断言会先红出来）。
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
    # 产品定义配置化（租户级）+ 报价工位权限矩阵：此前只在 orchestrator 有，
    # 前端 /settings/tenant-products 一上生产就 404。
    ("/api/v1/tenant-products", "GET"),
    ("/api/v1/tenant-products", "POST"),
    ("/api/v1/tenant-products/{product_id}", "PUT"),
    ("/api/v1/tenant-products/{product_id}", "DELETE"),
    ("/api/v1/workstation-products", "GET"),
    ("/api/v1/workstation-products", "POST"),
    # 公司公章（单证签章区盖章用）：纯 Python PNG 校验，Worker 可直接跑
    ("/api/v1/tenant/company-seals", "GET"),
    ("/api/v1/tenant/company-seals", "POST"),
    ("/api/v1/tenant/company-seals/{seal_id}/image", "GET"),
    ("/api/v1/tenant/company-seals/{seal_id}/default", "PUT"),
    ("/api/v1/tenant/company-seals/{seal_id}", "DELETE"),
    # 四域补口（客户/订单/报价/单证）：前端 /shipments 页直接调用这几条
    ("/api/v1/shipments", "GET"),
    ("/api/v1/shipments", "POST"),
    ("/api/v1/shipments/{shipment_id}", "GET"),
    ("/api/v1/shipments/{shipment_id}", "PATCH"),
    # 单证补充端点（前端 use-trade-docs.ts 会调 refresh-sources）
    ("/api/v1/trade-docs/{doc_id}/confirm", "POST"),
    ("/api/v1/trade-docs/{doc_id}/translate", "POST"),
    ("/api/v1/trade-docs/{doc_id}/refresh-sources", "POST"),
    # 单证内容级版本（TODO A1，2026-10-20）
    ("/api/v1/trade-docs/{doc_id}/content-versions", "GET"),
    ("/api/v1/trade-docs/{doc_id}/content-versions/{version_no}", "GET"),
    ("/api/v1/trade-docs/{doc_id}/content-versions/{version_no}/restore", "POST"),
    # 询盘阶段机（TODO F4，2026-10-20）
    ("/api/v1/inquiries/{inquiry_id}/stage-log", "GET"),
    # 个人信息编辑（TODO F3，2026-10-20）
    ("/api/v1/auth/me", "PATCH"),
    ("/api/v1/auth/change-password", "POST"),
    # 客户 / 询盘补充端点
    ("/api/v1/customers/{customer_id}", "PATCH"),
    ("/api/v1/customers/{customer_id}/inquiries", "GET"),
    ("/api/v1/inquiries", "GET"),
    ("/api/v1/inquiries/{inquiry_id}", "PATCH"),
    # 报价补充端点
    ("/api/v1/export-quote/products/{product_key}/explain", "POST"),
    # 团队（三层组织）：建/加入/邀请/成员管理
    ("/api/v1/teams", "POST"),
    ("/api/v1/teams/me", "GET"),
    ("/api/v1/teams/{team_id}", "PATCH"),
    ("/api/v1/teams/{team_id}/members", "GET"),
    ("/api/v1/teams/{team_id}/members/{user_id}", "DELETE"),
    ("/api/v1/teams/{team_id}/invites", "POST"),
    ("/api/v1/teams/{team_id}/invites", "GET"),
    ("/api/v1/teams/{team_id}/invites/{invite_id}", "DELETE"),
    ("/api/v1/teams/join", "POST"),
    # 客户自助注册（含团队选择）—— 生产此前没有这条路由，注册直接 404
    ("/api/v1/auth/register", "POST"),
    # 工位订阅：我的工位 + 团队/个人开通
    ("/api/v1/me/workstations", "GET"),
    ("/api/v1/teams/{team_id}/subscriptions", "GET"),
    ("/api/v1/teams/{team_id}/subscriptions/{code}", "PUT"),
    ("/api/v1/teams/{team_id}/subscriptions/{code}", "DELETE"),
    ("/api/v1/users/{user_id}/subscriptions", "GET"),
    ("/api/v1/users/{user_id}/subscriptions/{code}", "PUT"),
    ("/api/v1/users/{user_id}/subscriptions/{code}", "DELETE"),
    # 官网数据后台权限（团队管理员授予成员）
    ("/api/v1/teams/{team_id}/members/{user_id}/console-access", "PUT"),
    # 业务客户往来记录（包含关系树）
    ("/api/v1/customers/{customer_id}/records", "GET"),
    # 平台账号治理（列表/停用/恢复；**无物理删除**）
    ("/api/v1/admin/accounts", "GET"),
    ("/api/v1/admin/accounts/{user_id}", "PATCH"),
}

# 公开路由（与 orchestrator 一致：静态常量、非敏感，前端登录前后都要取）
# 单独列出来是因为它们不应答 401 —— 断言方式与 NEW_ROUTES 不同。
PUBLIC_ROUTES: set[tuple[str, str]] = {
    ("/api/v1/enums", "GET"),
    # 登出：stateless JWT，无凭据也应答 200（与 orchestrator 同口径）。
    # 此前线上缺这条路由，前端点登出直接 404。
    ("/api/v1/auth/logout", "POST"),
}


def test_existing_routes_intact():
    assert EXISTING_ROUTES <= _routes()


def test_new_routes_registered():
    if not NEW_ROUTES:
        return
    assert NEW_ROUTES <= _routes()


# C36（2026-10-21 用户批准删除）：三条无主接口必须真的消失。
# 用**负向断言**钉住，防止日后"顺手补回"旧规格库价格入口 / 通用上传入口。
C36_DELETED_ROUTES = {
    ("/api/v1/spec/skus/{sku_id}/prices", "POST"),
    ("/api/v1/spec/prices/{price_id}", "PATCH"),
    ("/api/v1/file-objects/upload", "POST"),
}


def test_c36_deleted_routes_are_gone():
    registered = _routes()
    for path, method in sorted(C36_DELETED_ROUTES):
        assert (path, method) not in registered, (
            f"{method} {path} 已在 C36 删除（用户 2026-10-21 批准），不应重新出现"
        )


def test_new_routes_answer_auth_challenge():
    """新接口无凭据应返回 401/403（鉴权在数据库之前），而不是 404。"""
    for path, method in sorted(NEW_ROUTES):
        # 带路径参数的路由用占位值打
        probe = path.replace("{shipment_id}", "1").replace("{customer_id}", "1")
        probe = (
            probe.replace("{item_id}", "1")
            .replace("{category_id}", "1")
            .replace("{order_id}", "1")
            .replace("{schedule_id}", "1")
            .replace("{doc_id}", "1")
            .replace("{product_id}", "1")
            .replace("{seal_id}", "1")
            .replace("{shipment_id}", "1")
            .replace("{inquiry_id}", "1")
            .replace("{product_key}", "field_fence")
            .replace("{team_id}", "1")
            .replace("{invite_id}", "1")
            .replace("{user_id}", "1")
            .replace("{code}", "customers")
        )
        resp = client.request(method, probe)
        assert resp.status_code != 404, f"{method} {path} 未注册"
        assert resp.status_code in (401, 403, 422), (
            f"{method} {path} 无凭据应先被鉴权拦截，实际 {resp.status_code}"
        )


def test_public_routes_registered_and_public():
    """公开路由（如 /enums）：注册了，且不带凭据也应答 —— 与 orchestrator 同口径。"""
    for path, method in sorted(PUBLIC_ROUTES):
        assert (path, method) in _routes(), f"{method} {path} 未注册"
        resp = client.request(method, path)
        assert resp.status_code == 200, (
            f"{method} {path} 期望 200（公开），实际 {resp.status_code}"
        )


def test_stage6_orders_unauthorized():
    resp = client.get("/api/v1/orders")
    assert resp.status_code == 401
    resp = client.post("/api/v1/orders", json={"customer_name": "x"})
    assert resp.status_code == 401
