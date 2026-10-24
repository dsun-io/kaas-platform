"""S3 行为对等：报价 / 订单域（orchestrator ↔ worker）。

为什么有这份文件
----------------
方案 B（单 Worker + asyncpg）的终态是**删掉 orchestrator 业务壳**，此后线上行为
只由 worker 决定。报价单与订单是「合同/单证的上游」——金额、状态机、客户闸门、
付款计划、应收台账任何一处漂移，都会直接印到对外单据上，而且删壳那一刻再也没有
orchestrator 侧可以对照。所以这两个域必须今天就把两侧行为逐条摆在测试里。

本文件做两件事
--------------
1. **钉死 worker 当前行为**（普通用例）：路径/方法、请求体必填与校验、错误码与
   错误体、响应键集、金额字段命名与类型、状态机合法/非法流转、404/409/422 语义、
   鉴权前置顺序。改坏任何一条都会红。
2. **显式登记与 orchestrator 的差异**（不许静默放过）：
   - 语义差异 → ``@pytest.mark.xfail(strict=True, reason="PARITY-QUOTE-n ...")``，
     用例断言的是 **orchestrator 口径**。今天必然 xfail（证明差异存在）；worker 修好
     后会 XPASS，strict 让 XPASS 变红 ⇒ 强迫摘掉标记。**这是棘轮，不是"放过"。**
   - 纯响应体文案/键顺序差异（状态码语义一致）→ 普通用例里用 ``PARITY-QUOTE-n``
     注释点名。

真源与不变量（本文件据此判断"对不对"，不自己发明口径）
-----------------------------------------------------
- 金额/行项/状态机序列化与状态机表都是**共享内核**
  ``kaas_common/workstation/{quote_serializers,order_serializers,state_machines}.py``
  —— 两端同一份源码，因此响应键集与金额类型（NUMERIC → float）由内核保证；
  本文件断言 worker 确实**走了**内核，而不是自己拼响应。
- 算价引擎 ``kaas_common/export_quote`` 用**真身**（sync-shared 镜像），不桩。
- 比对对象（HEAD 快照）：
  - orchestrator 报价单：``app/api/quote_orders.py``
  - orchestrator 订单/付款计划/应收：``app/api/orders.py``
  - orchestrator 算价：``app/api/export_quote.py``
  - worker 报价单/算价：``src/quote_api.py``
  - worker 订单/付款计划/应收：``src/main.py``（orders 段）

差异清单（编号与下文 xfail 用例一一对应；行号取 HEAD 快照）
-----------------------------------------------------------
| #    | 端点 / 行为                | orchestrator                                          | worker                                                        |
|------|----------------------------|-------------------------------------------------------|---------------------------------------------------------------|
| Q1   | 所有受保护端点 401 体      | `{"error","message"}`（core/auth.py:207-213）          | 字符串 detail（main.py:137-150）                               |
| Q2   | 报价枚举 `closed`          | QUOTE_STATUS 含 closed（domain/enums.py:32）           | `_QUOTE_STATUS` 无 closed（quote_api.py:260）⇒ 422               |
| Q3   | 订单/应收/参考价分页越界   | Query(ge/le) ⇒ 422（orders.py:197-198,565-566；quote_orders.py:639） | 静默钳位 ⇒ 200（main.py:3078-3079,3578-3579；quote_api.py:1795） |
| Q4   | 报价列表 `?customer_id=`   | `Optional[int]` ⇒ 非数字 422（quote_orders.py:403）    | `Optional[str]` ⇒ 原样进 SQL（quote_api.py:1617）                |
| Q5   | 建报价：缺客户 + 缺成本    | 先 CUSTOMER_REQUIRED（quote_orders.py:524-529）        | 先 COST_REQUIRED（quote_api.py:1698 先于 1705 客户闸门）         |
| Q6   | 报价行项模型字段           | 17 项（quote_orders.py:71-93）                          | 11 项，缺 policy/price/weight/volume/image 覆盖（quote_api.py:1089-1103） |
| Q7   | 订单列表 `?status=` 非法   | validate_enum ⇒ 422（orders.py:204-205）               | 不校验，直接进 SQL ⇒ 200（main.py:3048-3055）                    |
| Q8   | 订单列表 `?customer_id=`   | 支持过滤（orders.py:207-208）                           | 无此参数（main.py:3044-3050）                                    |
| Q9   | 订单详情键集               | +quote_refs/payment_schedules/receivable（orders.py:370-377） | 仅单头 + items（main.py:3287-3290）                       |
| Q10  | 建订单 items.qty 非数字    | Pydantic Decimal ⇒ 422（orders.py:58）                  | raw dict + float() ⇒ 500（main.py:3191-3192）                    |
| Q11  | 改订单贸易条款             | 可改 6 个条款（orders.py:403-407）                      | 只改 customer_name/delivery_date/notes（main.py:3307-3317）      |
| Q12  | 改订单换客户               | 支持（orders.py:390-396）                               | 忽略 body.customer_id（main.py:3293-3317）                       |
| Q13  | 订单状态值非法/缺失        | validate_enum + Pydantic ⇒ 422（orders.py:423）         | 409 ILLEGAL_TRANSITION（main.py:3388-3395）                      |
| Q14  | 建付款计划缺 schedule_type | Pydantic 必填 ⇒ 422（orders.py:106）                    | 默认 "full" ⇒ 201（main.py:3476）                                |
| Q15  | 付款计划 ratio/amount      | 二者都可空/可同给（orders.py:475-477）                  | 强制"恰一个"⇒ 422（main.py:3481-3483）                           |
| Q16  | 改付款计划金额             | 支持 amount 改（orders.py:510-511）                     | 非 paid 分支忽略 amount（main.py:3564-3571）                     |
| Q17  | 改付款计划 status 非法值   | validate_enum ⇒ 422（orders.py:518）                    | 只拦 paid→非 paid，非法值静默不落库 ⇒ 200（main.py:3518-3523）    |
| Q18  | 应收列表项键集             | 共享序列化 12 键 + order_no/customer_name（orders.py:582-585） | 原样返回 DB 全列（main.py:3601-3605）                     |
| Q19  | 订单详情行项链集           | 共享 `row_to_order_item` 11 键（orders.py:372）         | 原样返回 DB 全列（main.py:3289）                                 |
| Q20  | 付款计划项键集             | 共享 `row_to_schedule` 14 键（orders.py:459,489）       | 原样返回 DB 全列（main.py:3434-3443）                            |
| Q21  | 应收列表可见范围           | scope_filter（orders.py:577）                           | **完全不做归属过滤**（main.py:3577-3605）                        |
| Q22  | calculate-internal 鉴权顺序| `require_tenant_admin` 是依赖 ⇒ 先 403（export_quote.py:1009） | handler 内校验 ⇒ body 先 422（quote_api.py:825）           |
| Q23  | 租户管理员（is_tenant_admin）| require_tenant_admin 放行（deps/rbac.py:35-46）       | 只认 internal + role ⇒ 403（quote_api.py:198-214）               |
| Q24  | 产品定义上游变更           | 409 SPEC_UPSTREAM_CHANGED（export_quote.py:812-818）    | 视为产品不存在、静默回退注册表 ⇒ 200（quote_api.py:618-619）     |
| Q25  | 签发入账 `customer_id`     | `str(q.customer_id)` 写 TEXT 列（quote_orders.py:383-386） | 直接绑 int ⇒ 线上 asyncpg DataError 500（quote_api.py:1589）      |

> **2026-10-19（task-6 已清零）**：上表 Q1–Q25 已全部在 worker 侧修好，
> 下文所有 `test_parity_quote_*` 都是**普通用例**（断言修复后行为），不再有 xfail 棘轮；
> 表格保留为差异来源的历史对照（「worker」列 = 修复前状态）。

另有 **两端共同**的共享内核缺陷（不是 parity 差异）：``number_rules.py`` 曾丢
``_NUMBER_RE`` / ``MAX_LEN``，导致"手改单号"在两端都 500 —— 已由 **SHARED-BUG-1**
修复（补回常量 + sync-shared 同步到 worker）。本文件保留的
``test_shared_number_rules_normalize_number_works`` 与
``test_patch_quote_no_*`` 系列是**修复后的回归**（普通用例，应当通过）。

不连库：HTTP 断言只覆盖「鉴权 / 校验 / 取号 / 事务编排」分支，以及用桩连接把
handler 跑到返回。真实 PG 写入路径见 ``tests/integration/``（本地无 PG 自动 skip）。
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import quote_api  # noqa: E402
from kaas_common.workstation import order_serializers, quote_serializers  # noqa: E402
from kaas_common.workstation.state_machines import (  # noqa: E402
    ORDER_NEXT as SHARED_ORDER_NEXT,
    QUOTE_NEXT as SHARED_QUOTE_NEXT,
)

client = TestClient(worker_main.app, raise_server_exceptions=False)

_ORIGINAL_MAIN_ACQUIRE = worker_main._acquire
_ORIGINAL_DB_ACQUIRE = worker_main.db.acquire

_NOW = datetime(2026, 10, 19, 10, 0, tzinfo=timezone.utc)
_TODAY = date(2026, 10, 19)

# ── 身份桩 ──────────────────────────────────────────────────────────────────

CUSTOMER = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False,
}
INTERNAL_ADMIN = {
    "id": 1, "email": "root@qa.test", "display_name": "管理员",
    "account_type": "internal", "role": "system_admin", "status": "active",
    "team_id": None, "console_access": False,
}
TENANT_ADMIN = {  # users.is_tenant_admin=TRUE：orchestrator 放行，worker 不认
    "id": 7, "email": "tenant-admin@qa.test", "display_name": "租户管理员",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "is_tenant_admin": True,
}

# ── 共享内核给出的响应键集（两端同一份源码，不手抄）──────────────────────────

_QUOTE_KEYS = set(quote_serializers.row_to_quote({}))
_QUOTE_ITEM_KEYS = set(quote_serializers.row_to_item({}))
_ORDER_KEYS = set(order_serializers.row_to_order({}))
_ORDER_ITEM_KEYS = set(order_serializers.row_to_order_item({}))
_SCHEDULE_KEYS = set(order_serializers.row_to_schedule({}))
_RECEIVABLE_KEYS = set(order_serializers.row_to_receivable({}))


# ── 桩连接 ──────────────────────────────────────────────────────────────────

class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """按调用顺序吐预设结果，并记录全部 SQL（含绑定参数）。

    三种查询方法各自一条队列：``fetchrow`` / ``fetchval`` / ``fetch``。
    """

    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"

    def transaction(self):
        return _FakeTxn()

    # ── 断言助手 ──
    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.calls)

    def statements(self) -> list[str]:
        return [sql for sql, _ in self.calls]

    def first(self, needle: str) -> tuple[str, tuple]:
        return next(
            (sql, args) for sql, args in self.calls if needle in sql
        )


@contextmanager
def _patched(conn, user=None):
    """替换连接工厂（main._acquire 与 platform/db.acquire 两个入口）并可选注入用户。"""

    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    worker_main._acquire = fake_acquire
    worker_main.db.acquire = fake_acquire
    if user is not None:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        worker_main._acquire = _ORIGINAL_MAIN_ACQUIRE
        worker_main.db.acquire = _ORIGINAL_DB_ACQUIRE
        if user is not None:
            worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _as(user: dict) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


@pytest.fixture(autouse=True)
def _clean_state():
    """每个用例独立：依赖覆盖清空（连接工厂由 _patched / monkeypatch 负责归位）。"""
    worker_main.app.dependency_overrides.clear()
    yield
    worker_main.app.dependency_overrides.clear()
    worker_main._acquire = _ORIGINAL_MAIN_ACQUIRE
    worker_main.db.acquire = _ORIGINAL_DB_ACQUIRE


def _routes() -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for route in worker_main.app.routes:
        for method in getattr(route, "methods", None) or set():
            out.add((route.path, method))
    return out


# ── 造数 ────────────────────────────────────────────────────────────────────

def _customer_row(**over):
    row = {
        "id": 3, "name": "ACME 贸易", "abbr": "ACME", "country": "US",
        "team_id": 2, "tenant_id": "default", "is_deleted": False,
        "owner_id": "5", "owner_scope": "private",
    }
    row.update(over)
    return row


def _quote_row(**over):
    row = {
        "id": 11, "quote_no": "QUO-US-ACME-20261019000000",
        "customer_id": 3, "customer_name": "ACME 贸易",
        "inquiry_id": 9, "status": "draft", "currency": "USD",
        "total_amount": Decimal("100.00"),
        "valid_until": None, "notes": None,
        "fx_rate": Decimal("7.1"), "fx_rate_date": _TODAY,
        "tax_archive_id": None, "tax_archive_code": None,
        "tax_archive_name": None, "tax_snapshot": None,
        "created_at": _NOW, "created_by": "5",
        "owner_id": "5", "owner_scope": "private",
        "incoterm": None, "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
        "destination_country": None, "destination_region": None,
        "carrier": None, "freight_valid_from": None, "freight_valid_to": None,
        "team_id": 2, "tenant_id": "default",
    }
    row.update(over)
    return row


def _item_row(**over):
    row = {
        "id": 1, "quote_order_id": 11, "sku_id": None,
        "product_name": "field_fence", "spec_snapshot": None,
        "qty": Decimal("10"), "qty_unit": "ROLLS",
        "unit_price": Decimal("2.5"), "currency": "USD",
        "line_amount": Decimal("25.00"), "sort_order": 0,
        "policy_override": None, "price_source": "auto",
        "cost_override": Decimal("1.2"), "price_override": None,
        "weight_override": None, "volume_override": None,
        "image_url": None, "cost_breakdown": {"profit": 3.0},
        "created_at": _NOW,
    }
    row.update(over)
    return row


def _order_row(**over):
    row = {
        "id": 21, "order_no": "ORD-US-ACME-20261019000000",
        "customer_id": 3, "customer_name": "ACME 贸易",
        "status": "pending", "currency": "USD",
        "total_amount": Decimal("100.00"),
        "order_date": _NOW, "delivery_date": None, "notes": None,
        "fx_rate": None, "fx_rate_date": None,
        "created_at": _NOW, "owner_id": "5", "owner_scope": "private",
        "incoterm": None, "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
        "team_id": 2, "tenant_id": "default", "quote_id": None,
        # 来源三元组 + 确认痕迹（迁移 202610220004）：默认 direct / 无询盘 / 未确认
        "source_type": "direct", "source_channel": None, "inquiry_id": None,
        "confirmed_at": None, "confirmed_by": None, "confirmed_source": None,
    }
    row.update(over)
    return row


def _schedule_row(**over):
    row = {
        "id": 31, "order_id": 21, "trade_doc_id": None,
        "schedule_type": "deposit", "ratio": Decimal("0.3"),
        "amount": Decimal("250.00"), "currency": "USD",
        "due_date": _TODAY, "actual_date": None, "status": "pending",
        "fx_rate": None, "exchange_gain_loss": None, "notes": None,
        "created_at": _NOW, "updated_at": _NOW,
        "owner_id": "5", "owner_scope": "private", "team_id": 2,
        "tenant_id": "default",
    }
    row.update(over)
    return row


def _receivable_row(**over):
    row = {
        "id": 41, "order_id": 21, "currency": "USD",
        "total_amount": Decimal("100.00"), "fx_rate": Decimal("7.1"),
        "fx_rate_date": _TODAY, "base_currency": "CNY",
        "base_amount": Decimal("710.00"), "received_amount": Decimal("0"),
        "exchange_gain_loss": None, "status": "unpaid",
        "created_at": _NOW, "updated_at": _NOW,
        "owner_id": "5", "owner_scope": "private", "team_id": 2,
        "tenant_id": "default",
    }
    row.update(over)
    return row


# ════════════════════════════════════════════════════════════════════════════
# 0. 路由面：路径 / 方法（与 orchestrator 现行实现逐条对齐）
# ════════════════════════════════════════════════════════════════════════════

QUOTE_ROUTES = {
    ("/api/v1/quotes", "GET"),
    ("/api/v1/quotes", "POST"),
    ("/api/v1/quotes/batch", "POST"),
    ("/api/v1/quotes/reference-price", "GET"),
    ("/api/v1/quotes/cost-reference", "GET"),
    # 2026-10-24（A 项）：内核新增「某客户+某产品最近一次报价行英文名」只读端点。
    # orchestrator 无对应实现（零迁移偏好查询，前端默认值用）；按 worker 实际注册登记。
    ("/api/v1/quotes/product-name-preference", "GET"),
    ("/api/v1/quotes/{quote_id}", "GET"),
    ("/api/v1/quotes/{quote_id}", "PATCH"),
    ("/api/v1/quotes/{quote_id}/items", "PUT"),
}


# P3 步骤3（2026-10-24）：以下 GET handler 已删除（门面已放量，off 回退改为回滚代码）；
# 内核不再注册这些路由 ⇒ 从「期望路由面/鉴权矩阵」里减去，而不是放宽断言。
QUOTE_ROUTES -= {
    ("/api/v1/quotes", "GET"),
    ("/api/v1/quotes/reference-price", "GET"),
    ("/api/v1/quotes/cost-reference", "GET"),
    ("/api/v1/quotes/{quote_id}", "GET"),
}
ORDER_ROUTES = {
    ("/api/v1/orders", "GET"),
    ("/api/v1/orders", "POST"),
    ("/api/v1/orders/{order_id}", "GET"),
    ("/api/v1/orders/{order_id}", "PATCH"),
    ("/api/v1/orders/{order_id}/status", "POST"),
    ("/api/v1/orders/{order_id}/payment-schedules", "GET"),
    ("/api/v1/orders/{order_id}/payment-schedules", "POST"),
    ("/api/v1/payment-schedules/{schedule_id}", "PATCH"),
    ("/api/v1/receivables", "GET"),
    # 2026-10-22（设计 §13.3）：实收登记 + 订单随单附件（orchestrator 无对应实现，
    # 属用户新增能力；路由面按 worker 实际注册登记，防止漂移）。
    ("/api/v1/orders/{order_id}/receipts", "GET"),
    ("/api/v1/orders/{order_id}/receipts", "POST"),
    ("/api/v1/orders/{order_id}/files", "GET"),
    ("/api/v1/orders/{order_id}/files", "POST"),
    # 2026-10-22（设计 §6.1）：已确认订单明细变更审批（M1-e）。
    ("/api/v1/orders/{order_id}/item-change-requests", "GET"),
    ("/api/v1/orders/{order_id}/item-change-requests", "POST"),
    ("/api/v1/orders/{order_id}/item-change-requests/{rid}/approve", "POST"),
    ("/api/v1/orders/{order_id}/item-change-requests/{rid}/reject", "POST"),
}


def test_quote_route_surface_matches_orchestrator():
    """报价单恰好这 9 条（orchestrator `quote_orders.py` 8 条 + 内核新增英文名偏好 1 条；
    多/少都是漂移）。"""
    assert {p for p in _routes() if p[0].startswith("/api/v1/quotes")} == QUOTE_ROUTES


def test_order_route_surface_matches_orchestrator():
    """订单/付款计划/应收恰好这 9 条（orchestrator `orders.py` 全量）。"""
    actual = {
        p for p in _routes()
        if p[0].startswith("/api/v1/orders") or p[0].startswith("/api/v1/payment-schedules")
        or p[0].startswith("/api/v1/receivables")
    }
    assert actual == ORDER_ROUTES


def test_export_quote_core_route_surface_covers_orchestrator():
    """算价核心端点齐全（worker 多出 import/explain 的合并路由，属部署差异，不要求相等）。"""
    routes = _routes()
    for pair in {
        ("/api/v1/export-quote/products", "GET"),
        ("/api/v1/export-quote/products/{product_key}/formulas", "GET"),
        ("/api/v1/export-quote/products/{product_key}/spec", "GET"),
        ("/api/v1/export-quote/terms/template", "GET"),
        ("/api/v1/export-quote/calculate", "POST"),
        ("/api/v1/export-quote/calculate-internal", "POST"),
        ("/api/v1/export-quote/verify", "POST"),
    }:
        assert pair in routes, f"缺少 orchestrator 已有端点 {pair}"


# ════════════════════════════════════════════════════════════════════════════
# 1. 鉴权前置（未登录 / 鉴权先于 body 校验）
# ════════════════════════════════════════════════════════════════════════════

def test_all_quote_endpoints_require_credentials():
    """报价域全部端点未登录 → 401（不是 404/422），且不触库。"""
    requests = [
        ("post", "/api/v1/quotes", {"items": [{"product_name": "x"}]}),
        ("post", "/api/v1/quotes/batch", {"groups": []}),
        ("patch", "/api/v1/quotes/1", {"status": "sent"}),
        ("put", "/api/v1/quotes/1/items", {"items": []}),
    ]
    for method, path, body in requests:
        resp = getattr(client, method)(path, json=body) if body is not None \
            else getattr(client, method)(path)
        assert resp.status_code == 401, (method, path, resp.text)
        # 已修 2026-10-19（PARITY-QUOTE-1）：401 体与 orchestrator 同口径
        # （core/auth.py:207-221 的 `{error,message}`，不再是裸字符串）。
        detail = resp.json()["detail"]
        assert detail["error"] == "unauthorized" and detail["message"]


def test_all_order_endpoints_require_credentials():
    """订单/付款计划/应收全部端点未登录 → 401，且不触库。"""
    requests = [
        ("get", "/api/v1/orders", None),
        ("post", "/api/v1/orders", {"customer_id": 3}),
        ("get", "/api/v1/orders/21", None),
        ("patch", "/api/v1/orders/21", {"notes": "x"}),
        ("post", "/api/v1/orders/21/status", {"status": "confirmed"}),
        ("get", "/api/v1/orders/21/payment-schedules", None),
        ("post", "/api/v1/orders/21/payment-schedules",
         {"schedule_type": "deposit", "ratio": 0.3}),
        ("patch", "/api/v1/payment-schedules/31", {"status": "paid"}),
        ("get", "/api/v1/receivables", None),
    ]
    for method, path, body in requests:
        resp = getattr(client, method)(path, json=body) if body is not None \
            else getattr(client, method)(path)
        assert resp.status_code == 401, (method, path, resp.text)


def test_auth_precedes_body_validation():
    """鉴权/身份依赖先于 body 解析：坏 body + 无 token 是 401（不是 422）。

    两端一致（orchestrator 的 get_auth_context 也是依赖）。
    """
    resp = client.post("/api/v1/quotes", json={"items": [{"product_name": "x"}]})
    assert resp.status_code == 401
    resp = client.post("/api/v1/orders", json={"items": "not-a-list"})
    assert resp.status_code == 401
    resp = client.post("/api/v1/orders/21/status", json={"status": "bogus"})
    assert resp.status_code == 401


# ════════════════════════════════════════════════════════════════════════════
# 2. GET /api/v1/quotes —— 列表 / 分页 / 筛选
# ════════════════════════════════════════════════════════════════════════════


# ════════════════════════════════════════════════════════════════════════════
# 3. POST /api/v1/quotes —— 创建
# ════════════════════════════════════════════════════════════════════════════

def _create_quote_conn(items=(), quote_row=None, customer_row=None, trade_doc_id=500):
    """建单成功路径的桩：fx → 客户 → 询盘 → 报价 → 报价单（1:1 自动产出）。"""
    row = quote_row or _quote_row(total_amount=Decimal("49.99"))
    return _FakeConn(
        fetchrow=[
            None,                                  # _lock_fx_rate（USD 取 fx_rates）
            customer_row or _customer_row(),       # 客户闸门
            {"id": 77},                            # 自动建询盘 RETURNING id
            row,                                   # INSERT quote_orders RETURNING *
            None,                                  # 已有报价单？无
            {"id": trade_doc_id},                  # INSERT trade_docs RETURNING id
        ],
        fetchval=[None],                           # quote_no 取号不冲突
    )


_CREATE_QUOTE_BODY = {
    "customer_id": 3,
    "currency": "USD",
    "items": [
        {"product_name": "field_fence", "qty": 10, "unit_price": 2.5,
         "line_amount": 24.99},                    # line_amount 优先
        {"product_name": "field_fence", "qty": 10, "unit_price": 2.5},  # 10×2.5
    ],
}


def test_create_quote_missing_customer_is_422_customer_required():
    """两端一致：缺 customer_id → 422 CUSTOMER_REQUIRED（不是 422 字段级 detail）。"""
    conn = _FakeConn(fetchrow=[None])   # fx 汇率查询（在建单前锁定汇率）
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/quotes", json={"items": []})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "CUSTOMER_REQUIRED" and detail["field"] == "customer_id"


def test_create_quote_invalid_currency_is_422_invalid_enum():
    """两端一致：币种白名单外 → 422 INVALID_ENUM（含 allowed 列表）。"""
    conn = _FakeConn()
    with _patched(conn, CUSTOMER):
        resp = client.post(
            "/api/v1/quotes", json={**_CREATE_QUOTE_BODY, "currency": "BTC"})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "INVALID_ENUM" and detail["field"] == "currency"
    assert "BTC" in detail["allowed"] or "USD" in detail["allowed"]
    assert conn.calls == []  # 校验先于取连接


def test_create_quote_invalid_owner_scope_is_422():
    """两端一致：owner_scope 只允许 private|tenant。"""
    _as(CUSTOMER)
    resp = client.post(
        "/api/v1/quotes", json={**_CREATE_QUOTE_BODY, "owner_scope": "world"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_create_quote_cost_required_when_spec_snapshot_given():
    """两端一致：带规格快照却没手填成本 → 422 COST_REQUIRED（禁止回退默认成本）。"""
    _as(CUSTOMER)
    resp = client.post("/api/v1/quotes", json={
        "customer_id": 3,
        "items": [{"product_name": "field_fence", "qty": 1,
                   "spec_snapshot": {"product_key": "field_fence"}}],
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "COST_REQUIRED"


def test_parity_quote_5_quote_create_error_precedence():
    """缺客户 + 缺成本：orchestrator 报 CUSTOMER_REQUIRED（quote_orders.py:524-529 在 _build_items 之前）。"""
    _as(CUSTOMER)
    resp = client.post("/api/v1/quotes", json={
        "items": [{"product_name": "field_fence", "qty": 1,
                   "spec_snapshot": {"product_key": "field_fence"}}],
    })
    assert resp.json()["detail"]["code"] == "CUSTOMER_REQUIRED"


def test_create_quote_customer_not_found_404():
    """客户闸门：不存在 / 不可见 / 别家团队 → 404 CUSTOMER_NOT_FOUND（不泄露存在性）。"""
    conn = _FakeConn(fetchrow=[None, None])   # fx 无记录；客户查不到
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/quotes", json={"customer_id": 99, "items": []})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"


def test_create_quote_success_shape_amount_and_ledger_doc():
    """201；响应 = 共享内核键集；合计优先 line_amount；同事务产出报价单（1:1）。"""
    conn = _create_quote_conn()
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/quotes", json=_CREATE_QUOTE_BODY)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == _QUOTE_KEYS
    assert body["status"] == "draft"
    assert body["item_count"] == 2
    assert isinstance(body["total_amount"], float)      # 金额字段是 float 不是 Decimal/str
    assert isinstance(body["fx_rate"], float)

    insert_sql, insert_args = conn.first("INSERT INTO quote_orders")
    assert Decimal(str(insert_args[6])) == Decimal("49.99")  # 24.99 + 10×2.5
    # 业务事实「每个报价都有对应的报价单」：同一事务内写 trade_docs(quotation)
    trade_doc_sql, _trade_doc_args = conn.first("INSERT INTO trade_docs")
    assert "'quotation'" in trade_doc_sql
    assert "ON CONFLICT (doc_no) DO NOTHING" in trade_doc_sql
    # 行项落库走 quote_order_items（两行两条）
    assert sum("INSERT INTO quote_order_items" in s for s in conn.statements()) == 2


def test_create_quote_persists_selected_english_name_into_quotation_items():
    """A 项：用户本单选中的英文名原样落 quote_order_items，并进 quotation 的
    trade_doc_items（同一事务）；快照里的 product_key 是产品身份，不是名字。"""
    conn = _create_quote_conn()
    body = {**_CREATE_QUOTE_BODY, "items": [{
        "product_name": "Field Fence",
        "qty": 10, "unit_price": 2.5, "line_amount": 25,
        "cost_override": 1.2,
        "spec_snapshot": {"product_key": "field_fence", "specification": "2m x 3m"},
    }]}
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/quotes", json=body)
    assert resp.status_code == 201, resp.text

    _, item_args = conn.first("INSERT INTO quote_order_items")
    # (tenant_id, quote_order_id, sku_id, product_name, spec_snapshot, ...)
    assert item_args[3] == "Field Fence"
    # 报价单（quotation）行项同源：英文名跟着进单证快照，不改写
    _, doc_args = conn.first("INSERT INTO trade_doc_items")
    assert doc_args[2] == "Field Fence"


def test_create_quote_empty_items_allowed_total_null():
    """两端一致：空单可建（先建单再逐行加产品），但合计留空而不是 0。"""
    conn = _create_quote_conn(quote_row=_quote_row(total_amount=None))
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/quotes", json={"customer_id": 3, "items": []})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["total_amount"] is None
    assert body["item_count"] == 0
    _, insert_args = conn.first("INSERT INTO quote_orders")
    assert insert_args[6] is None


def test_create_quote_item_currency_validated():
    """两端一致：行项币种也进白名单校验。"""
    _as(CUSTOMER)
    resp = client.post("/api/v1/quotes", json={
        "customer_id": 3,
        "items": [{"product_name": "x", "qty": 1, "currency": "XYZ"}],
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["field"] == "currency"


def test_create_quote_item_insert_persists_override_fields():
    """已修 2026-10-19（PARITY-QUOTE-6）：行项的 6 个覆盖字段真正落库。

    orchestrator `_build_items`（quote_orders.py:259-274）会落
    policy_override / price_source / price_override / weight_override /
    volume_override / image_url；worker 原先 INSERT 只写 6 个字段，覆盖字段全丢。
    """
    conn = _create_quote_conn()
    with _patched(conn, CUSTOMER):
        resp = client.post(
            "/api/v1/quotes",
            json={"customer_id": 3, "items": [{
                "product_name": "x", "qty": 1, "unit_price": 2,
                "price_source": "overridden", "price_override": 9.5,
                "weight_override": 1.1, "volume_override": 0.2,
                "policy_override": {"profit_value": 0.2},
                "image_url": "https://example.com/a.png",
            }]},
        )
    assert resp.status_code == 201, resp.text
    insert_sql, insert_args = next(
        (s, a) for s, a in conn.calls if "INSERT INTO quote_order_items" in s)
    for field in ("policy_override", "price_source", "price_override",
                  "weight_override", "volume_override", "image_url"):
        assert field in insert_sql
    assert "overridden" in insert_args       # price_source
    assert Decimal("9.5") in insert_args or 9.5 in insert_args


def test_parity_quote_6_quote_item_model_covers_override_fields():
    expected = {
        "sku_id", "product_name", "spec_snapshot", "qty", "qty_unit",
        "unit_price", "currency", "line_amount", "sort_order",
        "policy_override", "price_source", "cost_override", "price_override",
        "weight_override", "volume_override", "image_url", "cost_breakdown",
    }
    assert expected <= set(quote_api._QuoteItemIn.model_fields)


# ════════════════════════════════════════════════════════════════════════════
# 4. GET /api/v1/quotes/{quote_id} —— 详情
# ════════════════════════════════════════════════════════════════════════════


# ════════════════════════════════════════════════════════════════════════════
# 5. PATCH /api/v1/quotes/{quote_id} —— 改单 / 状态机
# ════════════════════════════════════════════════════════════════════════════

def test_patch_quote_404_precedes_body_enum_validation():
    """两端一致：单子不存在时先 404，不先报"状态值非法"（worker 注释亦如此声明）。"""
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/999", json={"status": "bogus"})
    assert resp.status_code == 404


def test_patch_quote_illegal_transition_400():
    """两端一致：draft → accepted 非法，400 INVALID_STATUS_TRANSITION（含 allowed）。"""
    conn = _FakeConn(fetchrow=[_quote_row()])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/11", json={"status": "accepted"})
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["code"] == "INVALID_STATUS_TRANSITION"
    assert detail["error"] == "invalid_transition"


def test_patch_quote_closed_is_transition_error():
    """已修 2026-10-19（PARITY-QUOTE-2）：`closed` 是合法状态，但不是 draft 的可达目标。

    修好枚举后 PATCH draft→closed 走状态机 ⇒ 400 INVALID_STATUS_TRANSITION
    （与 orchestrator 同一语义：值合法，流转非法）。
    """
    conn = _FakeConn(fetchrow=[_quote_row()])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/11", json={"status": "closed"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_STATUS_TRANSITION"


def test_parity_quote_2_patch_quote_closed_is_transition_error():
    conn = _FakeConn(fetchrow=[_quote_row()])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/11", json={"status": "closed"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_STATUS_TRANSITION"


def test_patch_quote_sent_records_ledger_in_same_txn():
    """draft→sent 签发：同一事务写「报价记录」台账（source=quote_issued，一张单一条）。"""
    updated = _quote_row(status="sent")
    conn = _FakeConn(
        fetchrow=[_quote_row(), updated, None, {"id": 500}],
        fetchval=[0],
        fetch=[[_item_row()], [_item_row()]],
    )
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/11", json={"status": "sent"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "sent"
    # dev 侧同一处用默认 item_count=0（逐字照抄），响应不回填行数
    assert body["item_count"] == 0

    ledger_sql, ledger_args = conn.first("INSERT INTO quotations")
    assert "INSERT INTO quotations" in ledger_sql
    # 台账来源标记（参数化）+ 未使用的列不写
    assert ledger_args[2] == "other"      # 整单一条 → other 类目
    assert ledger_args[10] == "quote_issued"
    assert ledger_args[-1] == "5"         # created_by：int user_id → VARCHAR（显式 str）
    # 已修 2026-10-19（PARITY-QUOTE-25）：customer_id 显式转 str 再绑 TEXT 列，
    # 否则线上 asyncpg 会 DataError（500）。
    assert ledger_args[1] == "3"
    assert "schema_version" in ledger_sql  # NOT NULL 且无 DB 默认值，必须显式写 1
    # 「报价单」本身也补齐（老报价没有对应报价单时签发即补一张）
    assert "INSERT INTO trade_docs" in conn.sql()


def test_parity_quote_25_ledger_customer_id_is_text():
    updated = _quote_row(status="sent")
    conn = _FakeConn(
        fetchrow=[_quote_row(), updated, None, {"id": 500}],
        fetchval=[0],
        fetch=[[_item_row()], [_item_row()]],
    )
    with _patched(conn, CUSTOMER):
        client.patch("/api/v1/quotes/11", json={"status": "sent"})
    _sql, ledger_args = conn.first("INSERT INTO quotations")
    assert ledger_args[1] == "3"   # quotations.customer_id 是 TEXT 列


def test_patch_quote_write_access_forbidden_403():
    """同团队可见 ≠ 可改：别人名下的单（owner_scope=tenant 可见）→ 403 NOT_OWNER。"""
    row = _quote_row(owner_id="99", owner_scope="tenant")
    conn = _FakeConn(fetchrow=[row])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/11", json={"notes": "x"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_OWNER"


_VALID_NEW_QUOTE_NO = "QUO-US-ACME-20261019999999"


def test_shared_number_rules_normalize_number_works():
    """共享内核编号规则（SHARED-BUG-1 已修）：常量 `_NUMBER_RE`/`MAX_LEN` 已补回。

    此前 kernel 引用未定义名 ⇒ 任何"手改单号"在**两端**都 NameError→500。
    修复后这里钉住规则本身：合法编号原样返回、空/超长/空白编号抛 NumberError。
    """
    from kaas_common.workstation.number_rules import (
        MAX_LEN, NumberError, normalize_number,
    )

    assert normalize_number("  QUO-1  ") == "QUO-1"     # 去首尾空白
    assert normalize_number("报价-张工") == "报价-张工"   # 允许中文
    assert MAX_LEN == 64
    for bad in ("", "   ", "a" * (MAX_LEN + 1), "has space"):
        with pytest.raises(NumberError):
            normalize_number(bad)


def test_patch_quote_no_locked_409():
    """已有下游单证 ⇒ 改号 409 QUOTE_NO_LOCKED（编号锁定；两端一致）。"""
    conn = _FakeConn(fetchrow=[_quote_row()], fetchval=[1])
    with _patched(conn, CUSTOMER):
        resp = client.patch(
            "/api/v1/quotes/11", json={"quote_no": _VALID_NEW_QUOTE_NO})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "QUOTE_NO_LOCKED"


def test_patch_quote_no_taken_409():
    """改号撞号 ⇒ 409 QUOTE_NO_TAKEN；先查下游（无）再查占用。"""
    conn = _FakeConn(fetchrow=[_quote_row()], fetchval=[None, None, 1])
    with _patched(conn, CUSTOMER):
        resp = client.patch(
            "/api/v1/quotes/11", json={"quote_no": _VALID_NEW_QUOTE_NO})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "QUOTE_NO_TAKEN"


def test_patch_quote_no_invalid_422():
    """编号不合法 → 422 INVALID_QUOTE_NO（NumberError 翻译；两端一致）。"""
    conn = _FakeConn(fetchrow=[_quote_row()], fetchval=[])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/11", json={"quote_no": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_QUOTE_NO"


def test_patch_quote_no_success_updates_number():
    """无下游、不撞号 ⇒ 改号成功（SHARED-BUG-1 修复后才可能通过）。"""
    renamed = _quote_row(quote_no=_VALID_NEW_QUOTE_NO)
    conn = _FakeConn(
        fetchrow=[_quote_row(), renamed],
        fetchval=[None, None, None],
    )
    with _patched(conn, CUSTOMER):
        resp = client.patch(
            "/api/v1/quotes/11", json={"quote_no": _VALID_NEW_QUOTE_NO})
    assert resp.status_code == 200, resp.text
    assert resp.json()["quote_no"] == _VALID_NEW_QUOTE_NO
    assert "quote_no=$3" in conn.first("UPDATE quote_orders SET")[0]


def test_patch_quote_invalid_currency_422():
    """两端一致：改币种同样走白名单。"""
    conn = _FakeConn(fetchrow=[_quote_row()])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/quotes/11", json={"currency": "BTC"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["field"] == "currency"


# ════════════════════════════════════════════════════════════════════════════
# 6. PUT /api/v1/quotes/{quote_id}/items —— 行项整批替换
# ════════════════════════════════════════════════════════════════════════════

def test_replace_items_not_draft_409_not_editable():
    """两端一致：非 draft 不可改行项，409 QUOTE_NOT_EDITABLE。"""
    conn = _FakeConn(fetchrow=[_quote_row(status="sent")])
    with _patched(conn, CUSTOMER):
        resp = client.put("/api/v1/quotes/11/items", json={"items": []})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "QUOTE_NOT_EDITABLE"


def test_replace_items_empty_clears_total_to_null():
    """两端一致：整批替换成空 → total_amount 留空（不是 0）。"""
    conn = _FakeConn(fetchrow=[_quote_row(), None], fetch=[[]])
    with _patched(conn, CUSTOMER):
        resp = client.put("/api/v1/quotes/11/items", json={"items": []})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"id": 11, "total_amount": None, "items": []}
    update_sql, update_args = conn.first("UPDATE quote_orders SET total_amount")
    assert update_args[-1] is None


def test_replace_items_cost_required_422():
    """两端一致：带规格快照却没成本 → 422 COST_REQUIRED。"""
    conn = _FakeConn(fetchrow=[_quote_row()], fetch=[[]])
    with _patched(conn, CUSTOMER):
        resp = client.put("/api/v1/quotes/11/items", json={"items": [
            {"product_name": "x", "qty": 1, "spec_snapshot": {"product_key": "x"}},
        ]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "COST_REQUIRED"


def test_replace_items_success_shape_and_sync_doc():
    """201→200：返回 {id,total_amount,items}；draft 报价单同步行项/合计。"""
    rows = [_item_row(id=1), _item_row(id=2, line_amount=Decimal("50.00"))]
    conn = _FakeConn(
        fetchrow=[_quote_row(), {"id": 500}],
        fetch=[rows],
    )
    with _patched(conn, CUSTOMER):
        resp = client.put("/api/v1/quotes/11/items", json={"items": [
            {"product_name": "field_fence", "qty": 10, "unit_price": 2.5,
             "line_amount": 25},
            {"product_name": "field_fence", "qty": 10, "unit_price": 5},
        ]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"id", "total_amount", "items"}
    assert body["total_amount"] == 75.0
    assert len(body["items"]) == 2
    assert "DELETE FROM quote_order_items" in conn.sql()
    assert "DELETE FROM trade_doc_items" in conn.sql()   # 同步它那张报价单
    assert "UPDATE trade_docs SET total_amount" in conn.sql()


def test_replace_items_404():
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.put("/api/v1/quotes/999/items", json={"items": []})
    assert resp.status_code == 404


# ════════════════════════════════════════════════════════════════════════════
# 7. POST /api/v1/quotes/batch —— 批量报价
# ════════════════════════════════════════════════════════════════════════════

def test_batch_quote_empty_groups_422():
    """两端一致：空批 422 EMPTY_BATCH（handled 校验，非 Pydantic）。"""
    _as(CUSTOMER)
    resp = client.post("/api/v1/quotes/batch", json={"groups": []})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "EMPTY_BATCH"


def test_batch_quote_too_large_422():
    """两端一致：单批最多 200 组。"""
    _as(CUSTOMER)
    groups = [{"customer_id": 3, "inquiry_id": i} for i in range(201)]
    resp = client.post("/api/v1/quotes/batch", json={"groups": groups})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "BATCH_TOO_LARGE"


def test_batch_quote_group_failure_is_collected_not_raised():
    """单组失败不拖垮整批：201 + created/failed 分离（两端同一实现语义）。"""
    conn = _FakeConn(fetchrow=[None, None])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/quotes/batch", json={
            "groups": [{"customer_id": 99, "inquiry_id": 1}],
        })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["created"] == [] and body["total"] == 1
    assert body["failed"][0]["code"] == "CUSTOMER_NOT_FOUND"
    assert body["failed"][0]["customer_id"] == "99"


def test_batch_quote_group_requires_ids_pydantic_422():
    """两端一致：group 缺 customer_id/inquiry_id → Pydantic 422（列表型 detail）。"""
    _as(CUSTOMER)
    resp = client.post("/api/v1/quotes/batch", json={"groups": [{"customer_id": 3}]})
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], list)


# ════════════════════════════════════════════════════════════════════════════
# 8. 参考价 / 成本参考价
# ════════════════════════════════════════════════════════════════════════════


# ════════════════════════════════════════════════════════════════════════════
# 9. GET /api/v1/orders —— 列表
# ════════════════════════════════════════════════════════════════════════════

def test_list_orders_shape_and_scope():
    """列表 = {items,total,page,page_size}；项 = 共享内核订单键集；非管理员下推可见范围。"""
    conn = _FakeConn(fetchval=[1], fetch=[[_order_row()]])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders?page=1&page_size=20")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"items", "total", "page", "page_size"}
    assert body["total"] == 1
    # P0-A A1：列表行比详情多一个聚合键（待批明细变更数，列表角标用），
    # 详情/创建/更新的公共契约仍是 row_to_order 原键集（见 test_get_order_*）。
    assert set(body["items"][0]) == _ORDER_KEYS | {"pending_item_change_count"}
    assert body["items"][0]["pending_item_change_count"] == 0
    assert isinstance(body["items"][0]["total_amount"], float)
    # 取**列表**语句（count 语句也是 "FROM orders WHERE"，故以带别名 o 的列表查询定位）
    list_sql, list_args = conn.first("FROM orders o WHERE")
    assert "owner_id = $" in list_sql and "team_id = $" in list_sql
    assert "5" in [str(a) for a in list_args] and 2 in list_args


def test_list_orders_worker_q_search_extension():
    """worker 扩展：`q` 按客户名/订单号模糊搜（orchestrator 无此参数，多出的不算漂移）。"""
    conn = _FakeConn(fetchval=[0], fetch=[[]])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders?q=ACME")
    assert resp.status_code == 200
    list_sql, list_args = conn.first("FROM orders o WHERE")
    assert "customer_name ILIKE $" in list_sql and "order_no ILIKE $" in list_sql
    assert "%ACME%" in list_args


def test_parity_quote_8_list_orders_invalid_status_422():
    conn = _FakeConn(fetchval=[0], fetch=[])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders?status=bogus")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_parity_quote_9_list_orders_customer_filter():
    conn = _FakeConn(fetchval=[0], fetch=[])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders?customer_id=3")
    assert resp.status_code == 200
    assert "customer_id" in conn.first("FROM orders o WHERE")[0]


def test_parity_quote_3_list_orders_rejects_out_of_range_pagination():
    conn = _FakeConn(fetchval=[0], fetch=[])
    with _patched(conn, CUSTOMER):
        assert client.get("/api/v1/orders?page=0").status_code == 422
        assert client.get("/api/v1/orders?page_size=999").status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# 10. GET /api/v1/orders/{order_id} —— 详情
# ════════════════════════════════════════════════════════════════════════════

def test_get_order_404_string_detail():
    """worker 现状：404 detail 是字符串，orchestrator 是对象（错误体差异，状态码一致）。

    orchestrator orders.py:160-161 → {"error":"not_found","code":"ORDER_NOT_FOUND"}；
    worker main.py:3278 → 字符串 "ORDER_NOT_FOUND"。
    """
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders/999")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ORDER_NOT_FOUND"


def test_get_order_detail_shape():
    """已修 2026-10-19（PARITY-QUOTE-9/19）：详情 = 共享内核订单键集 + 四个关联块。

    - items 走共享 `row_to_order_item` 的 11 键（金额一律 float、无内部列）；
    - 补齐 quote_refs / payment_schedules / receivable（orchestrator orders.py:370-377）。
    """
    conn = _FakeConn(
        fetchrow=[_order_row()],
        fetch=[[_item_row()], [], [], []],
    )
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders/21")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == _ORDER_KEYS | {
        # 2026-10-22（设计 §13.3）：实收登记直接进详情，前端不用再发第二个请求
        "items", "quote_refs", "payment_schedules", "receipts", "receivable"}
    item = body["items"][0]
    assert set(item) == _ORDER_ITEM_KEYS         # 精确 11 键（与 orchestrator 同）
    assert item["qty"] == 10.0 and isinstance(item["qty"], float)
    assert body["quote_refs"] == []
    assert body["payment_schedules"] == []
    assert body["receivable"] is None


def test_parity_quote_9_order_detail_includes_links_and_schedules():
    conn = _FakeConn(fetchrow=[_order_row()], fetch=[[_item_row()], [], [], []])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders/21")
    assert {"quote_refs", "payment_schedules", "receivable"} <= set(resp.json())


def test_parity_quote_19_order_items_projection():
    conn = _FakeConn(fetchrow=[_order_row()], fetch=[[_item_row()]])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders/21")
    assert set(resp.json()["items"][0]) == _ORDER_ITEM_KEYS


# ════════════════════════════════════════════════════════════════════════════
# 11. POST /api/v1/orders —— 创建（手动 / 报价转化）
# ════════════════════════════════════════════════════════════════════════════

def test_create_order_missing_customer_422():
    """worker：缺客户 → 422 CUSTOMER_REQUIRED（orchestrator 侧会走到
    `ck_orders_has_customer` 约束 → 500；这里钉 worker 更好的显式校验）。"""
    conn = _FakeConn()
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders", json={"items": []})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "CUSTOMER_REQUIRED"


def test_create_order_invalid_customer_id_422():
    """worker：非数字 customer_id 显式 422 INVALID_CUSTOMER_ID（不静默取 0）。"""
    conn = _FakeConn()
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders", json={"customer_id": "cust-1"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_CUSTOMER_ID"


def test_create_order_invalid_owner_scope_422():
    """两端一致（共享枚举）：owner_scope 非法 → 422。"""
    _as(CUSTOMER)
    resp = client.post(
        "/api/v1/orders", json={"customer_id": 3, "owner_scope": "world"})
    assert resp.status_code == 422


def test_create_order_quote_not_found_404():
    """报价来源不存在 → 404 QUOTE_NOT_FOUND（同一错误体）。"""
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders", json={"quote_order_id": 999})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "QUOTE_NOT_FOUND"


def test_create_order_from_rejected_quote_409():
    """两端一致：rejected/expired/cancelled 的报价不可转化 → 409 QUOTE_NOT_CONVERTIBLE。"""
    conn = _FakeConn(fetchrow=[_quote_row(status="rejected")])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders", json={"quote_order_id": 11})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "QUOTE_NOT_CONVERTIBLE"


def test_create_order_from_quote_inherits_and_accepts():
    """报价转订单：客户/币种/行项/条款继承，落 orders.quote_id，报价置 accepted。"""
    quote = _quote_row(status="sent", incoterm="FOB", currency="EUR",
                       customer_id=3, quote_no="QUO-US-ACME-1")
    created = _order_row(currency="EUR", incoterm="FOB",
                         total_amount=Decimal("25.00"),
                         source_type="inquiry", source_channel="alibaba",
                         inquiry_id=9)
    conn = _FakeConn(
        # 第 3 条 = 「报价自带询盘 → 查渠道」的查询（设计 §3.2）
        fetchrow=[quote, _customer_row(), {"channel": "alibaba"}, created],
        fetchval=[None],
        fetch=[[_item_row()]],          # 未给行项 → 复制报价行项
    )
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders", json={"quote_order_id": 11})

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["currency"] == "EUR" and body["incoterm"] == "FOB"
    # 询盘转化单的来源三元组（迁移 202610220004）
    assert body["source_type"] == "inquiry"
    assert body["source_channel"] == "alibaba"
    assert body["inquiry_id"] == 9
    insert_sql, insert_args = conn.first("INSERT INTO orders")
    assert insert_args[4] == "EUR"                    # 继承币种
    assert insert_args[13] == "FOB"                   # 继承贸易条款（incoterm）
    assert insert_args[9] == 11                       # orders.quote_id
    assert "UPDATE quote_orders SET status='accepted'" in conn.sql()
    assert "INSERT INTO order_items" in conn.sql()


def test_create_order_from_quote_inherits_selected_english_name():
    """A 项：报价转订单时 product_name 原样继承（用户选的英文名，不回退默认名）。"""
    quote = _quote_row(status="sent", customer_id=3, currency="USD")
    created = _order_row(currency="USD")
    conn = _FakeConn(
        fetchrow=[quote, _customer_row(), {"channel": None}, created],
        fetchval=[None],
        fetch=[[_item_row(product_name="Field Fence",
                          spec_snapshot={"product_key": "field_fence"})]],
    )
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders", json={"quote_order_id": 11})
    assert resp.status_code == 201, resp.text
    _, insert_args = conn.first("INSERT INTO order_items")
    # (tenant_id, order_id, sku_id, product_name, ...)
    assert insert_args[3] == "Field Fence"


def test_parity_quote_10_create_order_bad_item_qty_is_422():
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders", json={
            "customer_id": 3,
            "items": [{"product_name": "x", "qty": "abc", "unit_price": 2}],
        })
    assert resp.status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# 12. PATCH /api/v1/orders/{order_id}
# ════════════════════════════════════════════════════════════════════════════

def test_patch_order_updates_notes_and_delivery():
    """可改字段生效（notes/delivery_date/customer_name），响应为共享内核键集。"""
    updated = _order_row(notes="催货", delivery_date=_NOW)
    conn = _FakeConn(fetchrow=[_order_row(), updated])
    with _patched(conn, CUSTOMER):
        resp = client.patch(
            "/api/v1/orders/21", json={"notes": "催货", "delivery_date": "2026-10-19T00:00:00"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["notes"] == "催货"
    set_sql, set_args = conn.first("UPDATE orders SET")
    # 2026-10-19（PARITY-QUOTE-11/12）：改为按「实际传入字段」动态拼 SET
    # （COALESCE 会把 null 当"不改"，无法表达显式改客户/条款）。
    assert "notes = $" in set_sql and "delivery_date = $" in set_sql


def test_patch_order_404_string_detail():
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/orders/999", json={"notes": "x"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ORDER_NOT_FOUND"


def test_patch_order_write_forbidden_403():
    """可见但非本人（owner_scope=tenant）→ 403 NOT_OWNER。"""
    conn = _FakeConn(fetchrow=[_order_row(owner_id="99", owner_scope="tenant")])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/orders/21", json={"notes": "x"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_OWNER"


def test_parity_quote_11_patch_order_trade_terms():
    updated = _order_row(incoterm="FOB")
    conn = _FakeConn(fetchrow=[_order_row(), updated])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/orders/21", json={"incoterm": "FOB"})
    assert resp.status_code == 200
    assert "incoterm = $" in conn.first("UPDATE orders SET")[0]


def test_parity_quote_12_patch_order_change_customer():
    updated = _order_row(customer_id=9, customer_name="新客户")
    conn = _FakeConn(fetchrow=[_order_row(), _customer_row(id=9, name="新客户"), updated])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/orders/21", json={"customer_id": 9})
    assert resp.status_code == 200
    assert "customer_id" in conn.first("UPDATE orders SET")[0]


# ════════════════════════════════════════════════════════════════════════════
# 13. POST /api/v1/orders/{order_id}/status —— 状态机
# ════════════════════════════════════════════════════════════════════════════

def test_order_status_machine_uses_shared_table():
    """F2-1：worker 直接用共享内核 ORDER_NEXT（单一真源），producing 只允许 → shipped。"""
    # 同一个对象：worker 不再保留第二份本地表（此前两份内容不同 ⇒ 409 allowed 与共享表漂移）
    assert worker_main.ORDER_NEXT is SHARED_ORDER_NEXT
    assert SHARED_ORDER_NEXT["producing"] == ("shipped",)
    assert "cancelled" not in SHARED_ORDER_NEXT["producing"]
    # 其余档位未变（pending/confirmed 仍可取消）
    assert SHARED_ORDER_NEXT["pending"] == ("confirmed", "cancelled")
    assert SHARED_ORDER_NEXT["confirmed"] == ("producing", "cancelled")
    assert SHARED_ORDER_NEXT["shipped"] == ("completed",)
    # 报价状态机：worker 本地表的**可流转项**与共享内核除 closed 外逐字一致 ——
    # closed 就是 Q2 差异根因（共享内核有 closed 键，worker 表没有）。
    assert quote_api._QUOTE_NEXT == {
        k: v for k, v in SHARED_QUOTE_NEXT.items() if v
    }
    assert "closed" in SHARED_QUOTE_NEXT


def test_order_status_illegal_transition_409():
    """两端一致：pending → shipped 非法，409 ILLEGAL_TRANSITION（含 from/to/allowed）。"""
    conn = _FakeConn(fetchrow=[_order_row(status="pending")])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={"status": "shipped"})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "ILLEGAL_TRANSITION"
    assert detail["from"] == "pending" and detail["to"] == "shipped"
    assert detail["allowed"] == ["confirmed", "cancelled"]


def test_order_status_unknown_value_is_422_invalid_enum():
    """已修 2026-10-19（PARITY-QUOTE-13）：未知/缺失状态先 422。

    orchestrator orders.py:423 先 validate_enum(order_status)（且 Pydantic
    StatusChange.status 必填）⇒ 422 INVALID_ENUM；worker 原先把它们当
    "非法流转"报 409，状态码语义完全不同。
    """
    conn = _FakeConn(fetchrow=[_order_row(status="pending")])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={"status": "bogus"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"

    conn = _FakeConn(fetchrow=[_order_row(status="pending")])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={})
    assert resp.status_code == 422


def test_parity_quote_13_order_status_values_validated():
    """已修 2026-10-19（PARITY-QUOTE-13）：未知值/缺 status 都是 422。

    orchestrator：`StatusChange.status` 必填（Pydantic ⇒ 缺省 422）且
    `validate_enum("order_status", ...)`（orders.py:423 ⇒ 未知值 422 INVALID_ENUM）。
    """
    conn = _FakeConn(fetchrow=[_order_row(status="pending")])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={"status": "bogus"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"

    conn = _FakeConn(fetchrow=[_order_row(status="pending")])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={})
    assert resp.status_code == 422


def test_order_status_same_status_is_noop_200():
    """两端一致：目标 == 当前 视为幂等（不报非法流转）。"""
    row = _order_row(status="confirmed")
    conn = _FakeConn(fetchrow=[row, row])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={"status": "confirmed"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "confirmed"


def test_order_status_pending_confirmed_locks_fx_and_creates_receivable():
    """§10.2：pending→confirmed 重锁汇率 + 建应收台账（幂等，先查后插）。

    2026-10-22（设计 §5.1）：确认改成**一条** UPDATE（status + fx + 确认三件套），
    人工确认与「定金到账联动确认」共用同一个 `_apply_order_confirmation`。
    """
    pending = _order_row(status="pending")
    confirmed = _order_row(status="confirmed", fx_rate=Decimal("7.1"),
                           fx_rate_date=_TODAY,
                           confirmed_source="manual", confirmed_by="3")
    conn = _FakeConn(
        # ① 读订单 ② 锁汇率 ③ 查应收（无→建）④ 收尾重读订单
        fetchrow=[pending, {"rate": Decimal("7.1"), "rate_date": _TODAY}, None, confirmed],
        fetch={"": []},
    )
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={"status": "confirmed"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "confirmed"
    insert_sql, insert_args = conn.first("INSERT INTO receivables")
    assert insert_args[3] == Decimal("100.00")     # total_amount
    # 确认痕迹：人工确认 ⇒ confirmed_source=manual（与定金联动的 deposit_receipt 区分）
    # 参数序：$3 now / $4 fx_rate / $5 fx_rate_date / $6 confirmed_at /
    #         $7 confirmed_by / $8 confirmed_source
    confirm_sql, confirm_args = conn.first("UPDATE orders SET status='confirmed'")
    assert confirm_args[7] == "manual"
    assert "confirmed_at" in confirm_sql and "confirmed_by" in confirm_sql


def test_order_status_pending_cancelled_does_not_create_receivable():
    """取消不建应收（只有确认才建）。"""
    pending = _order_row(status="pending")
    cancelled = _order_row(status="cancelled")
    conn = _FakeConn(fetchrow=[pending, cancelled])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={"status": "cancelled"})
    assert resp.status_code == 200
    assert "INSERT INTO receivables" not in conn.sql()


def test_order_status_producing_cannot_be_cancelled():
    """F2-1 口径收敛：producing 只允许 → shipped（与共享内核 ORDER_NEXT 一致）。

    决策理由（任务 F2-1）：worker 是生产内核，它的行为就是前端 409 `allowed` 的契约；
    共享表此前多放一条 producing→cancelled 却永远不生效 ⇒ 以 worker 为准对齐，
    并把 worker 改为直接 import 共享表（以后要放开只改 kaas_common 一处）。
    """
    conn = _FakeConn(fetchrow=[_order_row(status="producing")])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/21/status", json={"status": "cancelled"})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "ILLEGAL_TRANSITION"
    assert detail["from"] == "producing" and detail["to"] == "cancelled"
    assert detail["allowed"] == ["shipped"]
    # 不允许的流转不得写库
    assert "UPDATE orders SET status" not in conn.sql()


def test_order_status_404():
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.post("/api/v1/orders/999/status", json={"status": "confirmed"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "order_not_found"}


# ════════════════════════════════════════════════════════════════════════════
# 14. 付款计划（GET/POST orders/{id}/payment-schedules、PATCH payment-schedules/{id}）
# ════════════════════════════════════════════════════════════════════════════

def test_list_schedules_shape_and_404_body():
    """列表 {items,total}；item 精确等于共享 `row_to_schedule` 14 键（Q20 已修）；404 体同口径。"""
    conn = _FakeConn(
        fetchrow=[_order_row()],
        fetch=[[_schedule_row()]],
    )
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders/21/payment-schedules")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert set(item) == _SCHEDULE_KEYS            # 精确 14 键（不再透出内部列）
    assert isinstance(item["amount"], float)
    assert isinstance(item["ratio"], float)

    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders/999/payment-schedules")
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "order_not_found"}


def test_parity_quote_20_schedule_item_projection():
    conn = _FakeConn(fetchrow=[_order_row()], fetch=[[_schedule_row()]])
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/orders/21/payment-schedules")
    assert set(resp.json()["items"][0]) == _SCHEDULE_KEYS


def test_create_schedule_with_ratio_computes_amount():
    """ratio 模式：amount = total × ratio（0.01 四舍五入），status 默认 pending。"""
    conn = _FakeConn(
        fetchrow=[_order_row(), _schedule_row(amount=Decimal("30.00"))],
    )
    with _patched(conn, CUSTOMER):
        resp = client.post(
            "/api/v1/orders/21/payment-schedules",
            json={"schedule_type": "deposit", "ratio": 0.3},
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert _SCHEDULE_KEYS <= set(body)          # 内核键集都在（另有 DB 原始列，见 Q20）
    assert body["amount"] == 30.0
    assert body["status"] == "pending"
    insert_sql, insert_args = conn.first("INSERT INTO payment_schedules")
    assert insert_args[2] == "deposit"
    assert Decimal(str(insert_args[4])) == Decimal("30.00")   # 100 × 0.3
    assert "'pending'" in insert_sql


def test_create_schedule_invalid_type_422():
    """两端一致（状态码）：未知 schedule_type → 422（错误体不同，见下文注）。"""
    conn = _FakeConn(fetchrow=[_order_row()])
    with _patched(conn, CUSTOMER):
        resp = client.post(
            "/api/v1/orders/21/payment-schedules",
            json={"schedule_type": "half", "amount": 10},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"error": "bad_schedule_type"}


def test_parity_quote_14_create_schedule_requires_type():
    conn = _FakeConn(fetchrow=[_order_row(), _schedule_row()])
    with _patched(conn, CUSTOMER):
        resp = client.post(
            "/api/v1/orders/21/payment-schedules", json={"amount": 10})
    assert resp.status_code == 422


def test_parity_quote_15_create_schedule_ratio_amount_rules():
    """已修 2026-10-19（PARITY-QUOTE-15）：ratio/amount 都可空、也可同给。

    orchestrator orders.py:475-477：amount 显式给时优先，没给且给了 ratio 才按
    订单合计补算；两者都不给也允许建（金额后补）。
    """
    conn_both = _FakeConn(
        fetchrow=[_order_row(), _schedule_row(amount=Decimal("10"))])
    with _patched(conn_both, CUSTOMER):
        both = client.post("/api/v1/orders/21/payment-schedules",
                           json={"schedule_type": "deposit", "ratio": 0.3, "amount": 10})
    assert both.status_code == 201, both.text
    assert both.json()["amount"] == 10.0             # 显式 amount 优先于 ratio 计算
    _, args_both = conn_both.first("INSERT INTO payment_schedules")
    assert Decimal(str(args_both[4])) == Decimal("10")
    assert Decimal(str(args_both[3])) == Decimal("0.3")   # ratio 仍原样落库

    conn_neither = _FakeConn(
        fetchrow=[_order_row(), _schedule_row(amount=None)])
    with _patched(conn_neither, CUSTOMER):
        neither = client.post("/api/v1/orders/21/payment-schedules",
                              json={"schedule_type": "deposit"})
    assert neither.status_code == 201, neither.text
    assert neither.json()["amount"] is None
    _, args_neither = conn_neither.first("INSERT INTO payment_schedules")
    assert args_neither[4] is None


def test_patch_schedule_amount_update_persists():
    """已修 2026-10-19（PARITY-QUOTE-16）：非 paid 分支也能改金额。

    断言点：UPDATE 语句里带 `amount=COALESCE`，且响应返回新金额。
    """
    conn = _FakeConn(fetchrow=[_schedule_row(),
                               {"owner_id": "5", "owner_scope": "private"},
                               _schedule_row(amount=Decimal("500"))])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/payment-schedules/31", json={"amount": 500})
    assert resp.status_code == 200
    update_sql = conn.first("UPDATE payment_schedules SET")[0]
    assert "amount=COALESCE" in update_sql
    assert resp.json()["amount"] == 500.0    # 新值已生效


def test_parity_quote_16_patch_schedule_amount():
    """已修 2026-10-19（PARITY-QUOTE-16）：非 paid 状态可改金额（orchestrator orders.py:510-511）。"""
    conn = _FakeConn(fetchrow=[_schedule_row(), {"owner_id": "5", "owner_scope": "private"},
                               _schedule_row(amount=Decimal("500"))])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/payment-schedules/31", json={"amount": 500})
    assert resp.status_code == 200
    assert resp.json()["amount"] == 500.0


def test_patch_schedule_unknown_status_422():
    """已修 2026-10-19（PARITY-QUOTE-17）：非法 status → 422 INVALID_ENUM。

    orchestrator orders.py:518 先 validate_enum(schedule_status) 再谈状态机；
    worker 原先既不报错也不落库，返回 200 + 旧值（前端误以为标记成功）。
    """
    conn = _FakeConn(fetchrow=[_schedule_row(),
                               {"owner_id": "5", "owner_scope": "private"}])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/payment-schedules/31", json={"status": "bogus"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_parity_quote_17_patch_schedule_status_validated():
    conn = _FakeConn(fetchrow=[_schedule_row(), {"owner_id": "5", "owner_scope": "private"},
                               _schedule_row()])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/payment-schedules/31", json={"status": "bogus"})
    assert resp.status_code == 422


def test_patch_schedule_paid_cannot_revert_409():
    """两端一致（状态码）：已收款不可回退 pending → 409 ILLEGAL_TRANSITION。"""
    paid = _schedule_row(status="paid", actual_date=_TODAY, fx_rate=Decimal("7.2"))
    conn = _FakeConn(fetchrow=[paid, {"owner_id": "5", "owner_scope": "private"}])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/payment-schedules/31", json={"status": "pending"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ILLEGAL_TRANSITION"


def test_patch_schedule_mark_paid_updates_receivable_and_gain_loss():
    """标记收款：写实际汇率、汇兑损益，并累计应收 received_amount/status。"""
    pending = _schedule_row()
    paid = _schedule_row(status="paid", actual_date=_TODAY, fx_rate=Decimal("7.2"),
                         exchange_gain_loss=Decimal("25.00"))
    conn = _FakeConn(
        fetchrow=[pending, {"owner_id": "5", "owner_scope": "private"},
                  {"fx_rate": Decimal("7.1")}, {"fx_rate": Decimal("7.1")}, paid],
    )
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/payment-schedules/31",
                            json={"status": "paid", "fx_rate": 7.2,
                                  "actual_date": "2026-10-19"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "paid"
    # 汇兑损益 = 250 × (7.2 − 7.1) = 25.00
    assert "UPDATE receivables SET received_amount" in conn.sql()
    paid_sql, paid_args = conn.first("UPDATE payment_schedules SET status='paid'")
    assert Decimal(str(paid_args[4])) == Decimal("25.00")


def test_patch_schedule_404():
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, CUSTOMER):
        resp = client.patch("/api/v1/payment-schedules/999", json={"status": "paid"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "schedule_not_found"}


# ════════════════════════════════════════════════════════════════════════════
# 15. GET /api/v1/receivables —— 应收台账
# ════════════════════════════════════════════════════════════════════════════

def test_list_receivables_shape_matches_shared_projection():
    """已修 2026-10-19（PARITY-QUOTE-18）：item = 共享应收序列化 12 键 + join 两字段。

    orchestrator orders.py:582-585 用 `row_to_receivable` 后拼
    order_no/customer_name；worker 原先原样返回 DB 全列（内部列全透出）。
    """
    conn = _FakeConn(
        fetch=[[_receivable_row(order_no="ORD-1", customer_name="ACME")]],
        fetchval=[1],
    )
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/receivables")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"items", "total", "page", "page_size"}
    item = body["items"][0]
    assert set(item) == _RECEIVABLE_KEYS | {"order_no", "customer_name"}
    assert item["order_no"] == "ORD-1" and item["customer_name"] == "ACME"
    assert isinstance(item["base_amount"], float)   # 金额一律 float


def test_list_receivables_invalid_status_422():
    """两端同为 422，错误体不同（worker {"error":"bad_receivable_status"}）。"""
    _as(CUSTOMER)
    resp = client.get("/api/v1/receivables?status=bogus")
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"error": "bad_receivable_status"}


def test_parity_quote_18_receivable_item_projection():
    conn = _FakeConn(
        fetch=[[_receivable_row(order_no="ORD-1", customer_name="ACME")]],
        fetchval=[1],
    )
    with _patched(conn, CUSTOMER):
        resp = client.get("/api/v1/receivables")
    assert set(resp.json()["items"][0]) == _RECEIVABLE_KEYS | {"order_no", "customer_name"}


def test_parity_quote_3_list_receivables_page_bounds():
    conn = _FakeConn(fetch=[[]], fetchval=[0])
    with _patched(conn, CUSTOMER):
        assert client.get("/api/v1/receivables?page_size=999").status_code == 422


def test_parity_quote_21_receivables_scope_filter():
    """已修 2026-10-19：应收列表按归属过滤（PARITY-QUOTE-21，越权读全部已堵）。"""
    conn = _FakeConn(fetch=[[]], fetchval=[0])
    with _patched(conn, CUSTOMER):
        client.get("/api/v1/receivables")
    list_sql = conn.first("FROM receivables")[0]
    assert "owner_id" in list_sql


# ════════════════════════════════════════════════════════════════════════════
# 16. 算价（/export-quote）—— 共享引擎真身，钉请求形状与鉴权语义
# ════════════════════════════════════════════════════════════════════════════

_CALC_BODY = {
    "product_key": "field_fence",
    "fx_rate": 7.1,
    "orders": [{"total": 1000, "unit": "m"}],
}


@contextmanager
def _patched_db_fetch(rows):
    """把 platform/db.fetch 换成固定返回（算价只读 tenant_products / 定价数据）。"""

    async def fake_fetch(request, sql, *args, table=None):
        return rows

    original = worker_main.db.fetch
    worker_main.db.fetch = fake_fetch
    try:
        yield
    finally:
        worker_main.db.fetch = original


def test_calculate_customer_view_shape_and_amount_types():
    """客户视图：{meta,view,customer,customer_en}；不含 internal；金额是 float、汇率是 str。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.post("/api/v1/export-quote/calculate", json=_CALC_BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"meta", "view", "customer", "customer_en"}
    assert body["view"] == "customer"
    assert "internal" not in body
    # 汇率/币种口径来自共享引擎 quote_meta（fx_rate 是字符串，金额是 float）
    assert body["meta"]["currency"] == "CNY"
    assert body["meta"]["quote_currency"] == "USD"
    assert body["meta"]["fx_rate"] == "7.1"
    assert isinstance(body["meta"]["validity_days"], int)
    view = body["customer"]
    assert set(view) == {"view", "header", "rows", "decimals",
                         "horizontal_header", "vertical_header", "vertical_data"}
    assert view["view"] == "customer"
    assert len(view["decimals"]) == len(view["header"])
    for row in view["rows"]:
        for value in row:
            assert value is None or isinstance(value, (str, int, float))


def test_calculate_internal_forbidden_for_customer_403():
    """成本视图只对内部管理员开放（接口级红线）。"""
    _as(CUSTOMER)
    resp = client.post("/api/v1/export-quote/calculate-internal", json=_CALC_BODY)
    assert resp.status_code == 403
    assert resp.json()["detail"] == {
        "error": "forbidden", "message": "内部核算视图需要租户管理员权限"}


def test_calculate_internal_ok_for_internal_admin():
    """内部管理员：200 且多出 internal 视图（含成本/税额列）。"""
    with _patched_db_fetch([]):
        _as(INTERNAL_ADMIN)
        resp = client.post("/api/v1/export-quote/calculate-internal", json=_CALC_BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["view"] == "internal"
    assert set(body) == {"meta", "view", "customer", "customer_en", "internal"}
    assert body["internal"]["view"] == "internal"
    assert len(body["internal"]["rows"]) == len(body["customer"]["rows"])


def test_parity_quote_22_calculate_internal_authz_precedes_body():
    _as(CUSTOMER)
    resp = client.post("/api/v1/export-quote/calculate-internal", json={})
    assert resp.status_code == 403


def test_parity_quote_23_tenant_admin_can_use_internal_view():
    with _patched_db_fetch([]):
        _as(TENANT_ADMIN)
        resp = client.post("/api/v1/export-quote/calculate-internal", json=_CALC_BODY)
    assert resp.status_code == 200, resp.text


def test_calculate_missing_fx_rate_422():
    """两端一致：fx_rate 必填（Pydantic）→ 422 列表型 detail。"""
    _as(CUSTOMER)
    body = {k: v for k, v in _CALC_BODY.items() if k != "fx_rate"}
    resp = client.post("/api/v1/export-quote/calculate", json=body)
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], list)


def test_calculate_validity_days_bounds_422():
    """两端一致：validity_days ge=1 le=365。"""
    _as(CUSTOMER)
    for days in (0, 366):
        resp = client.post(
            "/api/v1/export-quote/calculate", json={**_CALC_BODY, "validity_days": days})
        assert resp.status_code == 422, days


def test_calculate_unknown_product_400_engine_error():
    """未知产品：两端都是引擎 EngineError → 400 engine_error（不是 404）。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.post(
            "/api/v1/export-quote/calculate",
            json={**_CALC_BODY, "product_key": "no_such_product"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "engine_error"


def test_calculate_zero_orders_400_engine_error():
    """空订单量方案：引擎直接拒绝 → 400 engine_error（两端同一份引擎）。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.post(
            "/api/v1/export-quote/calculate", json={**_CALC_BODY, "orders": []})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "engine_error"


def test_calculate_non_positive_fx_rate_400_engine_error():
    """汇率 0：禁止静默当 1（否则外币价 = 本币价）→ 400 engine_error。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.post(
            "/api/v1/export-quote/calculate", json={**_CALC_BODY, "fx_rate": 0})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "engine_error"
    assert "汇率" in resp.json()["detail"]["message"]


def test_calculate_bad_profit_mode_400_pricing_error():
    """非法利润模式：引擎 PricingError → 400 pricing_error（两端同一错误码）。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.post("/api/v1/export-quote/calculate", json={
            **_CALC_BODY, "policy": {"profit_mode": "bogus", "profit_value": 0.1}})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "pricing_error"


def test_calculate_bad_terms_400_terms_error():
    """贸易术语配置有未知键：400 terms_error（拒绝静默降级成 EXW）。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.post("/api/v1/export-quote/calculate", json={
            **_CALC_BODY, "terms": {"fees": []}})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "terms_error"


def test_verify_requires_admin_and_returns_report_shape():
    """verify：customer 403；内部管理员 200（ok/checks/passes/errors/warnings）。"""
    _as(CUSTOMER)
    resp = client.post("/api/v1/export-quote/verify", json=_CALC_BODY)
    assert resp.status_code == 403

    with _patched_db_fetch([]):
        _as(INTERNAL_ADMIN)
        resp = client.post("/api/v1/export-quote/verify", json=_CALC_BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"ok", "checks", "passes", "errors", "warnings"}
    assert isinstance(body["ok"], bool)
    assert isinstance(body["checks"], int)
    assert isinstance(body["passes"], list) and body["passes"]
    assert isinstance(body["errors"], list) and isinstance(body["warnings"], list)


def test_export_quote_products_shape_matches_orchestrator():
    """产品下拉：12 键 + name_en_aliases（2026-10-24 多英文名；其余与 orchestrator 逐字一致）。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.get("/api/v1/export-quote/products")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"products", "total"}
    assert body["total"] == len(body["products"]) > 0
    assert set(body["products"][0]) == {
        "key", "name", "name_en", "name_en_aliases", "category_code",
        "combo_count", "spec_summary", "hs_codes", "cost_basis", "cost_unit",
        "params", "metric_count", "invariant_count",
    }


def test_export_quote_product_spec_unknown_404():
    """未知产品：spec 端点 404 unknown_product（两端同一错误体）。"""
    with _patched_db_fetch([]):
        _as(CUSTOMER)
        resp = client.get("/api/v1/export-quote/products/no_such_product/spec")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "unknown_product"


def test_parity_quote_24_spec_upstream_changed_409():
    """tenant_products 行的 override 基线哈希与当前产品定义不符 → orchestrator 409 人工复核。

    worker quote_api.py:618-619 直接把 `SpecUpstreamChanged` 吞成"产品不存在"，
    随后 build 回退到 Python 注册表的老定义 ⇒ 静默算出旧价。
    """
    from kaas_common.export_quote import effective_spec

    def _raise(*_a, **_k):
        raise effective_spec.SpecUpstreamChanged("baseline hash mismatch")

    rows = [{"spec": {"key": "field_fence"}, "override": {"delta": {}}, "team_id": None}]
    original = effective_spec.resolve_effective_product
    effective_spec.resolve_effective_product = _raise
    try:
        with _patched_db_fetch(rows):
            _as(INTERNAL_ADMIN)
            resp = client.post(
                "/api/v1/export-quote/calculate", json=_CALC_BODY)
    finally:
        effective_spec.resolve_effective_product = original
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "SPEC_UPSTREAM_CHANGED"
