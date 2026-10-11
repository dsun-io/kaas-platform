"""工位订阅判定规则的单测（共享内核，两端同一份）。

授权模型：业务**不以租户鉴权**，边界是"这个团队/个人开通了哪些工位"。
"""
import pytest

from kaas_common.workstation import subscriptions as subs

pytestmark = pytest.mark.unit


def test_workstation_of_maps_path_prefixes():
    assert subs.workstation_of("/api/v1/customers") == "customers"
    assert subs.workstation_of("/api/v1/customers/12") == "customers"
    assert subs.workstation_of("/api/v1/customers/12/inquiries") == "customers"
    assert subs.workstation_of("/api/v1/inquiries") == "customers"
    assert subs.workstation_of("/api/v1/trade-docs/3/render-data") == "trade-docs"
    assert subs.workstation_of("/api/v1/tenant/company-seals") == "trade-docs"
    assert subs.workstation_of("/api/v1/orders/9/payment-schedules") == "orders"
    assert subs.workstation_of("/api/v1/export-quote/products") == "quotes"
    assert subs.workstation_of("/api/v1/shipments") == "shipments"
    assert subs.workstation_of("/api/v1/leads") == "leadgen"


def test_prefix_match_respects_boundaries():
    """/api/v1/order 不能把 /api/v1/orders-x 也算成 orders 工位。"""
    assert subs.workstation_of("/api/v1/orders-x") is None
    assert subs.workstation_of("/api/v1/customers-archive") is None
    assert subs.workstation_of("/health") is None


def test_always_allowed_covers_self_service_paths():
    """账号/团队/订阅类必须永远放行 —— 锁了用户就没法"去开通工位"。"""
    for path in ("/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/teams",
                 "/api/v1/teams/1/invites", "/api/v1/teams/1/subscriptions",
                 "/api/v1/me/workstations", "/api/v1/admin/tenants", "/health"):
        assert subs.is_always_allowed(path) is True, path
    # 业务工位不在放行名单里
    assert subs.is_always_allowed("/api/v1/customers") is False


def test_has_workstation_rules():
    # full_chain = 全工位套餐
    for ws in subs.all_workstations():
        assert subs.has_workstation({subs.FULL_CHAIN}, ws) is True
    # 单独开通的工位
    assert subs.has_workstation({"customers"}, "customers") is True
    assert subs.has_workstation({"customers"}, "orders") is False
    # 什么工位都没有
    assert subs.has_workstation(set(), "customers") is False
    assert subs.has_workstation(None, "customers") is False
    # 不属于任何工位的路径（workstation=None）不拦
    assert subs.has_workstation(set(), None) is True


def test_normalize_codes():
    assert subs.normalize_codes([" Customers ", "FULL_CHAIN", "", None]) == {
        "customers", "full_chain"}
    assert subs.normalize_codes(None) == frozenset()


def test_workstation_list_matches_frontend_keys():
    """工位 key 必须与前端契约 `shared/contracts/workstations.ts` 对齐。"""
    expected = {"customers", "quotes", "orders", "trade-docs", "shipments",
                "leadgen", "outreach", "intel", "research"}
    assert set(subs.all_workstations()) == expected
