"""S3 行为对等：CRM 域（客户 / 联系人 / 询盘 / 往来记录）—— orchestrator ↔ worker。

为什么有这份文件
----------------
方案 B（单 Worker + asyncpg）的终态是**删掉 orchestrator 业务壳**，此后线上行为
只由 worker 决定。CRM 域是客户页（列表/详情/联系人/询盘）与客户往来记录树的
唯一数据来源，两侧今天必须逐条对齐；删壳那一刻若不一致，就是线上行为漂移。

本文件做两件事（范式同 `test_parity_auth.py`）
----------------------------------------------
1. **钉死 worker 当前行为**（普通用例）：路径/方法、鉴权前置顺序、请求体必填与
   校验、错误码与错误体、响应键集、状态码、team/tenant 可见性、软删语义。
2. **显式登记与 orchestrator 的差异**（不许静默放过）：
   - 行为差异 → ``@pytest.mark.xfail(strict=True, reason="PARITY-CRM-n: ...")``，
     用例断言的是 **orchestrator 口径**。今天必然 xfail（证明差异存在）；worker
     修好后会 XPASS，strict 让 XPASS 变红 ⇒ 强迫摘掉标记。**这是棘轮，不是放过。**
   - 纯查询/实现细节差异（外部行为一致）→ 普通用例里用 ``PARITY-CRM-n`` 注释点名。

不连库：HTTP 断言只覆盖「鉴权 / 校验先于取连接」的分支，以及用桩连接把 handler
跑到返回（成功/失败分支）。桩形状照抄真实表列（见 `app/db/workstation_models.py`）。

差异清单（**历史快照** —— 编号与下文用例一一对应；下列 worker 列为当时的现状，
现状见下方「2026-10-19 S3-k 收尾」。行号取 HEAD ba86e9a 快照）
-------------------------------------------------------------
| #     | 端点                              | orchestrator                                                        | worker                                                              |
|-------|-----------------------------------|---------------------------------------------------------------------|---------------------------------------------------------------------|
| CRM-1 | GET /customers                    | page_size ≤ 200（customers.py:280）                                  | ≤ 100（main.py:1132）                                               |
| CRM-2 | GET /customers                    | ORDER BY updated_at DESC（customers.py:315）                         | ORDER BY created_at DESC（main.py:1176）                             |
| CRM-3 | GET /customers                    | 无 country 参数 ⇒ 忽略（customers.py:276-283）                        | 按 country 过滤（main.py:1134,1153-1154）                            |
| CRM-4 | POST /customers                   | stage 可空，None → active（customers.py:217,339-345）                 | stage: str，显式 null → 422（main.py:932）                           |
| CRM-5 | POST /customers                   | 写 cust_stage_log「新建客户」（customers.py:367）                     | 不写阶段日志（main.py:1211-1234）                                    |
| CRM-6 | GET /customers/{id}               | contacts 投影 7 键（customers.py:406-410）                            | 原样 10 列（main.py:1251-1253,1271）                                 |
| CRM-7 | GET /customers/{id}               | stage_log 投影 5 键 + LIMIT 50（customers.py:396-401,416-420）        | 原样 8 列 + LIMIT 20（main.py:1257-1259,1273）                       |
| CRM-8 | DELETE /customers/{id}            | 非属主 → 403 NOT_OWNER（customers.py:465）                            | **无写权限校验**（main.py:1338-1365）                                 |
| CRM-9 | PATCH /customers/{id}/stage       | 非属主 → 403（customers.py:510）                                     | **无写权限校验**（main.py:1390-1418）                                 |
| CRM-10| POST /customers/{id}/contacts     | 请求体无 customer_id（customers.py:238-245）                          | **必填** customer_id（main.py:937-945）                              |
| CRM-11| POST /customers/{id}/contacts     | 响应 7 键（customers.py:556-558）                                     | 原样 10 列（main.py:1288）                                           |
| CRM-12| POST /customers/{id}/contacts     | is_primary=true 时清其它主联系人（customers.py:544-554）              | 不清（main.py:1277-1288）                                            |
| CRM-13| PATCH /customers/../contacts/{id} | 404 body {"error","code":CONTACT_NOT_FOUND}（customers.py:589）       | 404 字符串 "Contact not found"（main.py:1309-1310）                   |
| CRM-14| PATCH /customers/../contacts/{id} | exclude_unset ⇒ 显式 null 可清空字段（customers.py:590-604）          | COALESCE ⇒ null 视为「不改」（main.py:1315-1323）                     |
| CRM-15| DELETE /customers/../contacts/{id}| 联系人不存在 → 404（customers.py:627-628）                            | 恒 204（main.py:1327-1335）                                          |
| CRM-16| POST /customers/{id}/inquiries    | 请求体无 customer_id（customers.py:248-257）                          | **必填** customer_id（main.py:948-958）                              |
| CRM-17| POST /customers/{id}/inquiries    | channel 走枚举校验（customers.py:683）                                | 不校验（main.py:1368-1387）                                          |
| CRM-18| POST /customers/{id}/inquiries    | 存 lead_id（线索池转化来源）（customers.py:250,689）                  | 字段缺失 ⇒ lead_id 恒空（main.py:948-958）                            |
| CRM-19| POST /customers/{id}/inquiries    | 存 body.owner_scope（customers.py:257,684）                           | 硬编码 private（main.py:1383）                                        |
| CRM-20| POST /customers/{id}/inquiries    | 固定 status=unquoted，忽略 body.status（customers.py:693）            | 接受 body.status 任意值（main.py:1373）                               |
| CRM-21| POST /customers/{id}/inquiries    | 建询盘前校验写权限（customers.py:681）                                | **无写权限校验**（main.py:1368-1387）                                 |
| CRM-22| POST /customers/{id}/inquiries    | 响应 11 键 serializer（customers.py:703）                             | 原样整行（main.py:1387）                                             |
| CRM-23| GET /customers/{id}/inquiries     | items = row_to_inquiry 11 键（customers.py:669）                      | 多 inquiry_no_editable（ws_crm_ext.py:246-248）                      |

2026-10-19 S3-k 收尾（本文件最终状态）
-------------------------------------
上表登记的差异**全部清零**，本文件已无 `xfail(strict=True)`：
- 已对齐（改 worker 跟随 orchestrator）：
  · CRM-1 page_size 上限 200；
  · CRM-2 列表 `ORDER BY c.updated_at DESC`；
  · CRM-3 删除 worker 独有的 `?country=` 过滤 —— 前端**无消费方**（`frontend/src`
    对 `/customers` 的调用只传 q/stage/page_size），orchestrator 也没有该参数；
  · CRM-4 `CustomerCreate.stage` 可空，显式 null → active；
  · CRM-5 新建客户写第一条 `cust_stage_log`（reason「新建客户」）；
  · CRM-6/7 详情里 contacts 投影 7 键、stage_log 投影 5 键且 LIMIT 50；
  · CRM-11 新建联系人响应 7 键投影（PATCH 联系人响应同族遗漏一并收口）；
  · CRM-14 显式 null 清空字段（代码在 1bfa3a5 已修，本次只是把测试桩改成
    「第二次 UPDATE 返回已清空的行」）；
  · CRM-22 新建询盘响应走共享 `row_to_inquiry`。
- **有意保留（唯一一条）**：CRM-23 客户询盘列表项多 `inquiry_no_editable`。
  前端客户页用它控制「编号」是否可编辑（`frontend/src/app/(app)/customers/page.tsx`
  的 `Inquiry.inquiry_no_editable`，消费处 page.tsx:1060 —— 生成报价后锁号）。
  删掉这个键会让已报价询盘也能改号、破坏报价链路，故保留 worker 行为；用例改成
  普通「有意差异」断言（`test_customer_inquiries_item_has_extra_editable_flag`），
  不再用 xfail 棘轮。

对齐（无差异，作为回归被钉住）
------------------------------
- 路由面 14 条两端一致（含 GET .../records、DELETE 客户、PATCH/DELETE 联系人）；
- PATCH /customers/{id}：白名单列、`company_name → name` 映射、写权限 403（ws_crm_ext.py:166-211）；
- PATCH /inquiries/{id}：编号可改期 / 报价后锁号 / 撞号 / 非法流转 / 线索池回写 /
  写权限（ws_crm_ext.py:294-395 ↔ customers.py:730-817）；
- GET /inquiries：JOIN company_name、三层可见范围、时间倒序（ws_crm_ext.py:252-291）；
- GET /customers/{id}/records：两侧共用 `kaas_common.workstation.customer_records.build_records`；
- 软删语义（is_deleted 只写不读曾导致「删了还在」）：列表/详情/子资源一律 404/隐藏。

⚠️ 曾发现的 **共享缺陷（非两端差异）已修**：`SHARED-BUG-1`
------------------------------------------------------------
`kaas_common/workstation/number_rules.py` 的 `normalize_number` 曾引用**未定义**的
`_NUMBER_RE` / `MAX_LEN`（d0b4e20 有定义，7b21e1d 重写该文件时丢失）。orchestrator 与
worker **共用同一份内核**（两份副本逐字节相同，见 `scripts/sync-shared.ps1`），所以两侧
「改询盘/报价/订单/单证编号」的路径都会 `NameError` → 500。这不是对等差异，是共同故障。
2026-10-19 已由 Lead 补回两行常量并同步到 worker 镜像；本文件的
`test_patch_inquiry_inquiry_no_rules` 作为**常规回归**把 422/409 契约钉住
（曾以 `SHARED-BUG-1` xfail 棘轮登记，修复后按 strict 规则摘除）。

实现细节（外部行为一致，仅注释点名，不单列 xfail）
--------------------------------------------------
- worker 的客户域 SQL 一律硬编码 `DEFAULT_TENANT`，orchestrator 用 `auth.tenant_id or
  "default"`（当前 tenant 恒为 "default"，无外部差异；见 main.py:46 / customers.py:58-60）；
- worker 详情里的 contacts / inquiries / stage_log 查询**没带 tenant_id**（orchestrator
  带；customers.py:382-401），客户 id 全局唯一 ⇒ 当前无外部差异，属纵深防御缺口；
- worker stage 变更 `UPDATE customers ... WHERE id=$2` 不带 tenant（main.py:1409-1411）；
- worker 询盘编号 20 次同秒冲突后的兜底是 `-X`（main.py:998），orchestrator 用微秒
  （customers.py:175-176）—— 极端路径，无外部差异；
- worker 阶段变更 reason 会 `.strip()`（main.py:1408），orchestrator 原样落
  `body.reason`（customers.py:515）—— 只影响首尾空白，注释点名；
- 两侧 `GET /inquiries` 都不过滤「客户已软删」（JOIN 未带 is_deleted）；这是**共同**
  行为，不是偏差，但删除客户后其询盘仍会出现在总表 —— 记录在此供后续裁决。

注意：worker 侧**不**写 ``pytestmark = pytest.mark.unit``（该环境没注册 `unit` 标记，
验收命令是整包 pytest）。
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import ws_crm_ext  # noqa: E402
import ws_customer_records  # noqa: E402
from kaas_common.workstation.customer_records import build_records  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

_ORIGINAL_ACQUIRE = worker_main._acquire
_ORIGINAL_CRM_ACQUIRE = ws_crm_ext._acquire
_ORIGINAL_RECORDS_ACQUIRE = ws_customer_records._acquire
_ORIGINAL_CRM_DB = ws_crm_ext.db

_NOW = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)

# ── 路由面（orchestrator 侧来源：app/api/customers.py + customer_records.py）──
# 14 条；多一条/少一条都是漂移（route-parity.py 只管「worker 缺不缺」，这里管「恰好」）。
ORCH_CRM_ROUTES = {
    ("/api/v1/customers", "GET"),
    ("/api/v1/customers", "POST"),
    ("/api/v1/customers/{customer_id}", "GET"),
    ("/api/v1/customers/{customer_id}", "PATCH"),
    ("/api/v1/customers/{customer_id}", "DELETE"),
    ("/api/v1/customers/{customer_id}/stage", "PATCH"),
    ("/api/v1/customers/{customer_id}/contacts", "POST"),
    ("/api/v1/customers/{customer_id}/contacts/{contact_id}", "PATCH"),
    ("/api/v1/customers/{customer_id}/contacts/{contact_id}", "DELETE"),
    ("/api/v1/customers/{customer_id}/inquiries", "GET"),
    ("/api/v1/customers/{customer_id}/inquiries", "POST"),
    ("/api/v1/customers/{customer_id}/records", "GET"),
    ("/api/v1/inquiries", "GET"),
    ("/api/v1/inquiries/{inquiry_id}", "PATCH"),
    # 2026-10-22（设计 §8）：询盘详情 = 报价历史(1:N) + 关联订单 + 阶段流水。
    # 询盘成为独立工位后必须能单独打开一条看全链路，而不是只能从客户页钻。
    ("/api/v1/inquiries/{inquiry_id}", "GET"),
    # TODO F4（2026-10-20）：worker 新增的询盘阶段历史端点（orchestrator 已删壳，
    # 这是"落库+事件驱动"的一部分；路由面锁死 worker 实际注册面，新端点必须登记）。
    ("/api/v1/inquiries/{inquiry_id}/stage-log", "GET"),
}

# orchestrator `row_to_customer` / `row_to_inquiry`（共享内核）的键集 —— 两端必须逐字一致
_CUSTOMER_KEYS = {
    "id", "company_name", "abbr", "country", "address", "default_port",
    "credit_level", "stage", "manual_stage", "notes", "created_at", "updated_at",
}
_INQUIRY_KEYS = {
    "id", "customer_id", "inquiry_no", "lead_id", "channel", "category_id",
    "product_name_raw", "quantity", "quantity_unit", "application",
    # 2026-10-22（设计 §5）：询盘多产品行（迁移 202610220001 的 items）
    "items",
    "status",
    # TODO F4（2026-10-20）：阶段落库后序列化新增两键（迁移 202610200003）
    "stage", "stage_updated_at",
    "created_at",
}
# 2026-10-22（设计 §8）：GET /inquiries 每项额外带的"后来怎样了"计数。
# 只对**列表**端点生效，详情/客户子列表不带（详情本来就有 quotes/orders 全量）。
_INQUIRY_LIST_EXTRA_KEYS = {"company_name", "quote_count", "order_count",
                            "latest_quote_at"}
# 子资源行的**投影**键集：orchestrator customers.py:406-410 / 416-420 / 556-558
# 与 worker 的 `_contact_api` / `_stage_log_api` 用的是同一组键（PARITY-CRM-6/7/11）。
_ORCH_CONTACT_KEYS = {
    "id", "name", "position", "phone", "email", "whatsapp", "is_primary",
}
_ORCH_STAGE_LOG_KEYS = {"id", "from_stage", "to_stage", "reason", "created_at"}

# 账号：ADMIN 看全部；MEMBER 属于团队 1（不是数据属主）；TEAMMATE 同团队 1（也不是属主）
ADMIN = {
    "id": 1, "email": "root@qa.test", "display_name": "根", "account_type": "internal",
    "role": "system_admin", "status": "active", "team_id": None,
}
MEMBER = {
    "id": 2, "email": "member@qa.test", "display_name": "成员",
    "account_type": "customer", "role": "user", "status": "active", "team_id": 1,
}
TEAMMATE = {
    "id": 3, "email": "mate@qa.test", "display_name": "同事",
    "account_type": "customer", "role": "user", "status": "active", "team_id": 1,
}


# ── 桩：asyncpg 连接（_acquire 路径）与 platform/db（db.* 路径）──────────────

class _StubTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _StubConn:
    """冒充 `_acquire()` 吐出的 asyncpg 连接；按方法各自一条结果队列。"""

    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []
        self.executed: list[tuple[str, tuple]] = []

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
        self.executed.append((sql, args))
        return "UPDATE 1"

    def transaction(self):
        return _StubTxn()

    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.calls)

    def executed_sql(self) -> str:
        return "\n".join(sql for sql, _ in self.executed)


class _StubDb:
    """冒充 `platform/db.py`（ws_crm_ext 在模块级缓存了 `db = _main.db`）。

    与 `_StubConn` 的差别：每个方法第一个参数是 request，且 fetchrow/fetch 接受 `table=`。
    """

    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, _request, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"

    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.calls)


@contextmanager
def _patched(*, conn=None, db=None, user=None):
    """把三条 `_acquire`（main / ws_crm_ext / ws_customer_records）与 ws_crm_ext.db
    换成桩，并可选注入当前用户；退出时全部归位。"""
    conn = conn if conn is not None else _StubConn()

    @asynccontextmanager
    async def fake_acquire(_request):
        yield conn

    worker_main._acquire = fake_acquire
    ws_crm_ext._acquire = fake_acquire
    ws_customer_records._acquire = fake_acquire
    if db is not None:
        ws_crm_ext.db = db
    if user is not None:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        worker_main._acquire = _ORIGINAL_ACQUIRE
        ws_crm_ext._acquire = _ORIGINAL_CRM_ACQUIRE
        ws_customer_records._acquire = _ORIGINAL_RECORDS_ACQUIRE
        ws_crm_ext.db = _ORIGINAL_CRM_DB
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _as(user: dict) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


@pytest.fixture(autouse=True)
def _clean_state():
    yield
    worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _routes() -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for route in worker_main.app.routes:
        for method in getattr(route, "methods", None) or set():
            out.add((route.path, method))
    return out


# ── 造数（列形状 = app/db/workstation_models.py 真实表列）────────────────────

def _customer_row(**over):
    row = {
        "id": 3, "tenant_id": "default", "code": None, "name": "ACME",
        "company_name": "ACME", "abbr": "ACM", "plan": "free", "status": "active",
        "country": "US", "address": None, "default_port": None, "credit_level": None,
        "stage": "active", "manual_stage": "active", "stage_display": "active",
        "notes": None, "created_by": "2", "owner_id": "2", "owner_scope": "private",
        "team_id": 1, "legacy_cust_id": None, "is_deleted": False, "deleted_at": None,
        "created_at": _NOW, "updated_at": _NOW,
    }
    row.update(over)
    return row


def _contact_row(**over):
    row = {
        "id": 5, "tenant_id": "default", "customer_id": 3, "name": "John",
        "position": "Buyer", "phone": "+1 555", "email": "john@acme.test",
        "whatsapp": None, "wechat": None, "is_primary": True, "created_at": _NOW,
    }
    row.update(over)
    return row


def _inquiry_row(**over):
    row = {
        "id": 7, "tenant_id": "default", "customer_id": 3, "lead_id": None,
        "inquiry_no": "INQ-US-ACM-20261019120000", "channel": "email",
        "category_id": None, "product_name_raw": "牛栏网", "quantity": 10,
        "quantity_unit": "roll", "application": None, "status": "unquoted",
        "notes": None, "inquiry_seq": None, "spec_snapshot": None,
        "created_by": "2", "created_at": _NOW, "updated_at": _NOW,
        "owner_id": "2", "owner_scope": "private", "team_id": 1,
    }
    row.update(over)
    return row


def _stage_log_row(**over):
    row = {
        "id": 9, "tenant_id": "default", "customer_id": 3,
        "from_stage": "active", "to_stage": "inactive", "changed_by": "2",
        "reason": "客户关停", "created_at": _NOW,
    }
    row.update(over)
    return row


# ════════════════════════════════════════════════════════════════════════════
# 0. 路由面 / 鉴权前置
# ════════════════════════════════════════════════════════════════════════════

def test_crm_route_surface_is_exactly_orchestrators():
    """CRM 域**恰好**这 14 条（两端逐一对应；多/少一条都是漂移）。"""
    crm_routes = {
        pair for pair in _routes()
        if pair[0].startswith(("/api/v1/customers", "/api/v1/inquiries"))
    }
    assert crm_routes == ORCH_CRM_ROUTES


def test_all_crm_routes_require_credentials_first():
    """鉴权先于取连接/取 body：无凭据一律 401，不是 404/422/405。

    （错误体形状：PARITY-DIFF-16 已于 2026-10-19 修复 —— worker 现在与 orchestrator
    同口径返回 {"error","message"}；本域只断言鉴权前的状态码与 envelope 形状。）
    """
    for path, method in sorted(ORCH_CRM_ROUTES):
        probe = path.replace("{customer_id}", "1").replace("{inquiry_id}", "1")
        resp = client.request(method, probe)
        assert resp.status_code == 401, (method, path, resp.status_code, resp.text)
        detail = resp.json()["detail"]
        assert detail["error"] == "unauthorized" and detail["message"], (method, path)


# ════════════════════════════════════════════════════════════════════════════
# 1. GET /api/v1/customers（列表）
# ════════════════════════════════════════════════════════════════════════════

def test_customers_list_shape_and_team_scope():
    """`{items,total,page,page_size}` + 共享 serializer 12 键 + 三层可见范围。

    PARITY-CRM-2 已对齐：列表按 `updated_at DESC`（见下面只钉排序的用例）。
    """
    conn = _StubConn(fetchval=[1], fetch=[[_customer_row()]])
    with _patched(conn=conn, user=MEMBER):
        resp = client.get("/api/v1/customers")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"items", "total", "page", "page_size"}
    assert body["total"] == 1
    assert body["page"] == 1 and body["page_size"] == 20
    item = body["items"][0]
    assert set(item) == _CUSTOMER_KEYS
    assert item["company_name"] == "ACME"
    assert item["stage"] == "active" and item["manual_stage"] == "active"

    sql = conn.sql()
    assert "c.is_deleted = false" in sql          # 软删的客户不进列表
    assert "c.tenant_id = $1" in sql
    # 本团队可见：owner 我 / 租户共享 / team_id = 我的团队（与 dev scope_filter 同序）
    assert "(c.owner_id = $2 OR c.owner_scope = 'tenant' OR c.team_id = $3)" in sql


def test_customers_list_admin_has_no_scope_clause():
    """管理员（system_admin，含历史 admin）看全部 ⇒ 列表 SQL 不加归属条件。"""
    conn = _StubConn(fetchval=[0], fetch=[[]])
    with _patched(conn=conn, user=ADMIN):
        resp = client.get("/api/v1/customers")
    assert resp.status_code == 200
    assert "is_deleted = false" in conn.sql()
    assert "owner_id = $" not in conn.sql()


def test_customers_list_rejects_unknown_stage_enum():
    """`stage` 走共享枚举校验（customers.py:293 / main.py:1143）：非法值 422。"""
    with _patched(conn=_StubConn(), user=ADMIN):
        resp = client.get("/api/v1/customers?stage=lead")
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "INVALID_ENUM" and detail["field"] == "customer_stage"


def test_customers_list_pagination_lower_bounds_are_422():
    """两端 page ≥ 1、page_size ≥ 1 都是 Query 约束 → 422（customers.py:279-280）。"""
    for query in ("page=0", "page_size=0"):
        with _patched(conn=_StubConn(), user=ADMIN):
            resp = client.get(f"/api/v1/customers?{query}")
        assert resp.status_code == 422, (query, resp.text)


def test_customers_list_ignores_unknown_country_param():
    """PARITY-CRM-3 已对齐（2026-10-19）：worker 不再有 `country` 过滤。

    orchestrator 的查询参数只有 q/stage/page/page_size（customers.py:276-283）；
    worker 原多一个 `country ILIKE` 过滤，同一 URL 会在两侧返回不同集合。
    前端**无消费方**（`frontend/src` 里对 `/customers` 的调用只传 q / stage /
    page_size，见 customers/page.tsx:114-127 与 use-upstream.ts:110-150），
    故按 orchestrator 对齐：传 country 被静默忽略、返回全部。
    """
    conn = _StubConn(fetchval=[1], fetch=[[_customer_row()]])
    with _patched(conn=conn, user=ADMIN):
        resp = client.get("/api/v1/customers?country=US")
    assert resp.status_code == 200, resp.text
    assert "c.country ILIKE" not in conn.sql()
    assert resp.json()["total"] == 1


def test_customers_list_accepts_page_size_200():
    """PARITY-CRM-1 已对齐：page_size 上限 200（customers.py:280 / main.py）。

    上限必须与 orchestrator / MSW mock 同口径（mock 钳位也写 200，见
    `frontend/src/mocks/handlers.ts:746-749`）；`use-upstream.ts` 导出的
    `useCustomerOptions()` 就按 page_size=200 拉全量（当前页面走的是
    `useCustomerSearch`，默认 20）。上限 100 时 >100 的客户拉不全。
    """
    conn = _StubConn(fetchval=[0], fetch=[[]])
    with _patched(conn=conn, user=ADMIN):
        resp = client.get("/api/v1/customers?page_size=200")
    assert resp.status_code == 200, resp.text
    assert resp.json()["page_size"] == 200


def test_customers_list_orders_by_updated_at():
    """PARITY-CRM-2 已对齐：列表 ORDER BY updated_at DESC（customers.py:315 / main.py）。

    前端列表副标题展示「更新于 <updated_at>」（customers/page.tsx:1253），
    MSW mock 也按 updated_at 倒序（mocks/handlers.ts:738-743）——
    两侧排序必须一致，否则同一批客户在 mock 与线上顺序不同。
    """
    conn = _StubConn(fetchval=[0], fetch=[[]])
    with _patched(conn=conn, user=ADMIN):
        client.get("/api/v1/customers")
    sql = conn.sql()
    assert "ORDER BY c.updated_at DESC" in sql
    assert "ORDER BY c.created_at" not in sql


# ════════════════════════════════════════════════════════════════════════════
# 2. POST /api/v1/customers（新建）
# ════════════════════════════════════════════════════════════════════════════

def test_create_customer_requires_company_or_contact():
    """公司名与联系人至少一个 → 422，错误体与 orchestrator 逐字一致（customers.py:330-337）。"""
    for payload in ({}, {"company_name": "   "}, {"contact_name": ""}):
        with _patched(conn=_StubConn(), user=MEMBER):
            resp = client.post("/api/v1/customers", json=payload)
        assert resp.status_code == 422, (payload, resp.text)
        assert resp.json()["detail"] == {
            "error": "missing_identity",
            "code": "CUSTOMER_IDENTITY_REQUIRED",
            "detail": "公司名称和联系人至少填写一个",
        }


def test_create_customer_returns_shared_serializer_and_anti_forgery():
    """201 + 12 键；owner_id/owner_scope/team_id 一律取服务端身份（§10.3）。

    对齐：customers.py:346-356 / main.py:1210-1224（body 里的 owner_id 等被忽略）。
    body 里显式塞 account_type/role 也不影响归属列。
    """
    conn = _StubConn(
        fetchrow=[_customer_row(stage="inactive", stage_display="inactive")],
    )
    with _patched(conn=conn, user={**MEMBER, "team_id": 1}):
        resp = client.post(
            "/api/v1/customers",
            json={
                "company_name": "  ACME  ", "abbr": "ACM", "stage": "inactive",
                "owner_id": "999", "team_id": 99, "account_type": "internal",
            },
        )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == _CUSTOMER_KEYS
    assert body["company_name"] == "ACME"          # 两端都 strip
    assert body["stage"] == "inactive"

    insert_sql, args = next(
        (s, a) for s, a in conn.calls if "INSERT INTO customers" in s
    )
    assert "RETURNING *, name AS company_name" in insert_sql
    assert args[1] == "ACME"                       # name = strip 后的公司名
    assert args[2] == "ACM"                        # abbr 归一（大写）
    assert args[3] == "free" and args[4] == "active"   # plan/status NOT NULL 必须显式写
    assert args[9] == "inactive"                   # 手动阶段
    assert args[11] == "2" and args[12] == "2"    # created_by / owner_id = 当前用户
    assert args[13] == "private"                   # owner_scope 缺省
    assert args[14] == 1                           # team_id = 当前团队


def test_create_customer_contact_only_creates_primary_contact():
    """只给联系人：name 用联系人名做展示名，并落一条 is_primary=true 的联系人。

    对齐：customers.py:359-366 / main.py:1225-1233（两端 SQL 都硬编码 true）。
    """
    conn = _StubConn(fetchrow=[_customer_row(name="John", company_name="John")])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers",
            json={"contact_name": " John ", "contact_phone": " 123 ", "contact_email": " j@x.test "},
        )

    assert resp.status_code == 201, resp.text
    assert resp.json()["company_name"] == "John"
    contact_sql, contact_args = next(
        (s, a) for s, a in conn.executed if "INSERT INTO cust_contacts" in s
    )
    assert "true" in contact_sql
    assert contact_args == ("default", 3, "John", "123", "j@x.test")


def test_create_customer_rejects_bad_abbr_and_owner_scope():
    """abbr 非 2-6 位字母数字 → 422 INVALID_CUSTOMER_ABBR（customers.py:150-160）。"""
    with _patched(conn=_StubConn(), user=MEMBER):
        resp = client.post(
            "/api/v1/customers", json={"company_name": "ACME", "abbr": "A!"}
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_CUSTOMER_ABBR"

    with _patched(conn=_StubConn(), user=MEMBER):
        resp = client.post(
            "/api/v1/customers", json={"company_name": "ACME", "owner_scope": "world"}
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_create_customer_rejects_legacy_manual_stage():
    """「已下单」/旧单据阶段不能手写（validate_manual_stage，两端同源）。"""
    for bad in ("ordered", "won", "lead", "lost"):
        with _patched(conn=_StubConn(), user=MEMBER):
            resp = client.post(
                "/api/v1/customers", json={"company_name": "ACME", "stage": bad}
            )
        assert resp.status_code == 422, (bad, resp.text)
        assert resp.json()["detail"]["code"] == "INVALID_CUSTOMER_STAGE"


def test_create_customer_stage_null_falls_back_to_active():
    """PARITY-CRM-4 已对齐：显式 `stage: null` 视为缺省 → active。

    orchestrator `CustomerCreate.stage: Optional[str] = "active"`，`body.stage or
    "active"`（customers.py:217,339）。worker 原来 `stage: str` ⇒ 显式 null 直接
    422，同一份前端请求在两侧一个成功一个报错。
    """
    conn = _StubConn(fetchrow=[_customer_row()])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers", json={"company_name": "ACME", "stage": None}
        )
    assert resp.status_code == 201, resp.text
    assert resp.json()["manual_stage"] == "active"
    insert_sql, args = next(
        (s, a) for s, a in conn.calls if "INSERT INTO customers" in s
    )
    assert args[9] == "active"          # 落库的手动阶段


def test_create_customer_writes_first_stage_log():
    """PARITY-CRM-5 已对齐：新建客户写一条 `cust_stage_log`（customers.py:367）。

    客户详情「阶段历史」的第一条就是它（from=None → to=active，reason「新建客户」）；
    不写的话新客户的历史页签是空的，用户会以为系统没记录。
    """
    conn = _StubConn(fetchrow=[_customer_row()])
    with _patched(conn=conn, user=MEMBER):
        client.post("/api/v1/customers", json={"company_name": "ACME"})
    log_sql, log_args = next(
        (s, a) for s, a in conn.executed if "INSERT INTO cust_stage_log" in s
    )
    assert "from_stage, to_stage" in log_sql
    assert log_args == ("default", 3, None, "active", "2", "新建客户")


# ════════════════════════════════════════════════════════════════════════════
# 3. GET /api/v1/customers/{customer_id}（详情）
# ════════════════════════════════════════════════════════════════════════════

def test_customer_detail_assembles_contacts_inquiries_stage_log():
    """顶层 = 客户 12 键 + contacts/inquiries/stage_log；询盘带 inquiry_no_editable。

    PARITY-CRM-6/7 已对齐：contacts 投影 7 键、stage_log 投影 5 键 + LIMIT 50
    （customers.py:396-420）；`inquiry_no_editable` 是 CRM-23 的**有意保留**扩展，
    前端客户页用它锁号（见文件头「收尾」说明）。
    """
    conn = _StubConn(
        fetchrow=[_customer_row()],
        fetch=[[_contact_row()], [_inquiry_row()], [_stage_log_row()]],
        fetchval=[1],          # 该询盘已被报价引用 ⇒ 编号锁定
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.get("/api/v1/customers/3")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == _CUSTOMER_KEYS | {"contacts", "inquiries", "stage_log"}
    assert body["company_name"] == "ACME"

    contact = body["contacts"][0]
    assert set(contact) == _ORCH_CONTACT_KEYS          # PARITY-CRM-6（7 键投影）
    assert contact["name"] == "John"
    # 投影掉的库内列一律不出现在响应里（曾把 tenant_id / customer_id 整行吐出去）
    assert "tenant_id" not in contact and "customer_id" not in contact
    assert "wechat" not in contact

    inquiry = body["inquiries"][0]
    assert set(inquiry) == _INQUIRY_KEYS | {"inquiry_no_editable"}
    assert inquiry["inquiry_no_editable"] is False

    log = body["stage_log"][0]
    assert set(log) == _ORCH_STAGE_LOG_KEYS            # PARITY-CRM-7（5 键投影）
    assert log["to_stage"] == "inactive"
    assert log["created_at"] == _NOW.isoformat()       # 与 orchestrator 同：isoformat 字符串
    assert "changed_by" not in log

    sql = conn.sql()
    assert "c.is_deleted = false" in sql
    assert "LIMIT 50" in sql                           # PARITY-CRM-7（与 orchestrator 同 50）
    # PARITY-CRM-7：worker 的子查询**没带 tenant_id**（orchestrator 带，customers.py:382-401）
    assert "FROM cust_contacts WHERE customer_id=$1" in sql


def test_customer_detail_invisible_or_deleted_is_404():
    """别家团队 / 软删除的客户：详情 404，不泄露存在性（两端同口径）。"""
    for row in (None, _customer_row(team_id=2, owner_id="99")):
        conn = _StubConn(fetchrow=[row])
        with _patched(conn=conn, user=MEMBER):
            resp = client.get("/api/v1/customers/3")
        assert resp.status_code == 404, (row, resp.text)
        assert resp.json()["detail"] == {
            "error": "not_found", "code": "CUSTOMER_NOT_FOUND",
        }
        # 不可见时不再查子资源（不泄露存在性）
        assert len(conn.calls) == 1


def test_customer_detail_projects_contacts_to_seven_keys():
    """PARITY-CRM-6 已对齐：联系人投影 7 键（customers.py:406-410）。

    投影键集 = 前端 `Contact` 接口（customers/page.tsx:74-82）。
    """
    conn = _StubConn(
        fetchrow=[_customer_row()],
        fetch=[[_contact_row()], [], []],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.get("/api/v1/customers/3")
    assert resp.status_code == 200, resp.text
    assert set(resp.json()["contacts"][0]) == _ORCH_CONTACT_KEYS


def test_customer_detail_projects_stage_log_and_limit_50():
    """PARITY-CRM-7 已对齐：stage_log 投影 5 键 + LIMIT 50（customers.py:396-420）。"""
    conn = _StubConn(
        fetchrow=[_customer_row()],
        fetch=[[], [], [_stage_log_row()]],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.get("/api/v1/customers/3")
    assert resp.status_code == 200, resp.text
    assert set(resp.json()["stage_log"][0]) == _ORCH_STAGE_LOG_KEYS
    assert "LIMIT 50" in conn.sql()


# ════════════════════════════════════════════════════════════════════════════
# 4. PATCH /api/v1/customers/{customer_id}（档案更新 · 无差异，回归用）
# ════════════════════════════════════════════════════════════════════════════

def test_patch_customer_maps_company_name_to_name_column():
    """`company_name` 在库里叫 `name`（customers.py:441-444 / ws_crm_ext.py:63-72,189-192）。"""
    db = _StubDb(fetchrow=[_customer_row(), _customer_row(name="ACME 2", company_name="ACME 2")])
    with _patched(db=db, user=MEMBER):
        resp = client.patch("/api/v1/customers/3", json={"company_name": "ACME 2"})

    assert resp.status_code == 200, resp.text
    assert set(resp.json()) == _CUSTOMER_KEYS
    assert "SET name = $1" in db.sql()
    assert "SET company_name" not in db.sql()


def test_patch_customer_write_access_403_for_teammate():
    """同团队可见 ≠ 可改：非属主 403 NOT_OWNER（customers.py:93-101 / ws_crm_ext.py:179）。"""
    db = _StubDb(fetchrow=[_customer_row(owner_id="99", team_id=1)])
    with _patched(db=db, user=TEAMMATE):
        resp = client.patch("/api/v1/customers/3", json={"notes": "x"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == {
        "error": "forbidden", "code": "NOT_OWNER", "detail": "只能修改自己账号的数据",
    }
    assert len(db.calls) == 1      # 只有取客户那一条，没有 UPDATE


def test_patch_customer_validates_enums_before_update():
    """owner_scope 走枚举校验（customers.py:436-437 / ws_crm_ext.py:182-183）。"""
    db = _StubDb(fetchrow=[_customer_row()])
    with _patched(db=db, user=MEMBER):
        resp = client.patch("/api/v1/customers/3", json={"owner_scope": "world"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"

    db = _StubDb(fetchrow=[_customer_row()])
    with _patched(db=db, user=MEMBER):
        resp = client.patch("/api/v1/customers/3", json={"abbr": "A!"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_CUSTOMER_ABBR"


def test_patch_customer_empty_body_does_not_update():
    """空 body：两端都不发 UPDATE，原样回显（customers.py:435-447 / ws_crm_ext.py:193-195）。"""
    db = _StubDb(fetchrow=[_customer_row()])
    with _patched(db=db, user=MEMBER):
        resp = client.patch("/api/v1/customers/3", json={})
    assert resp.status_code == 200
    assert "UPDATE customers" not in db.sql()


# ════════════════════════════════════════════════════════════════════════════
# 5. DELETE /api/v1/customers/{customer_id}（软删）
# ════════════════════════════════════════════════════════════════════════════

def test_delete_customer_blocked_by_open_orders_same_body():
    """有开启中的订单 → 409 OPEN_ORDERS_EXIST + 订单清单（customers.py:466-481 / main.py:1348-1361）。"""
    conn = _StubConn(
        fetchrow=[_customer_row()],
        fetch=[[{"id": 9, "order_no": "SO-1", "status": "confirmed"}]],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.delete("/api/v1/customers/3")

    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "OPEN_ORDERS_EXIST"
    assert detail["open_orders"] == [
        {"id": 9, "order_no": "SO-1", "status": "confirmed"},
    ]
    assert "UPDATE customers SET is_deleted" not in conn.sql()


def test_delete_customer_without_open_orders_soft_deletes():
    """无开启中订单 → 204，只标记 is_deleted/deleted_at，不物理删除（两端同口径）。"""
    conn = _StubConn(fetchrow=[_customer_row()], fetch=[[]])
    with _patched(conn=conn, user=MEMBER):
        resp = client.delete("/api/v1/customers/3")

    assert resp.status_code == 204
    assert resp.content == b""
    assert "UPDATE customers SET is_deleted=true, deleted_at=now()" in conn.sql()
    assert "DELETE FROM customers" not in conn.sql()


def test_delete_customer_teammate_is_forbidden():
    """已修 2026-10-19：同团队非属主删除客户 → 403 NOT_OWNER（PARITY-CRM-8）。"""
    conn = _StubConn(fetchrow=[_customer_row(owner_id="99", team_id=1)], fetch=[[]])
    with _patched(conn=conn, user=TEAMMATE):
        resp = client.delete("/api/v1/customers/3")

    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_OWNER"
    assert "UPDATE customers SET is_deleted=true" not in conn.sql()


def test_parity_crm_8_delete_customer_non_owner_is_403():
    conn = _StubConn(fetchrow=[_customer_row(owner_id="99", team_id=1)], fetch=[[]])
    with _patched(conn=conn, user=TEAMMATE):
        resp = client.delete("/api/v1/customers/3")
    assert resp.status_code == 403


# ════════════════════════════════════════════════════════════════════════════
# 6. PATCH /api/v1/customers/{customer_id}/stage（手动阶段）
# ════════════════════════════════════════════════════════════════════════════

def test_stage_invalid_value_422_precedes_customer_lookup():
    """手写阶段先校验、再取客户（customers.py:502-508 / main.py:1398-1404）⇒ 无 DB 也 422。"""
    conn = _StubConn()
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/customers/3/stage", json={"stage": "ordered"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_CUSTOMER_STAGE"
    assert conn.calls == []


def test_stage_change_returns_manual_and_display_and_logs_reason():
    """改沉寂 → stage/manual_stage=inactive、closed_inquiries=[]，并落 cust_stage_log。

    PARITY-CRM-note：worker 对 reason 做 `.strip()`（main.py:1408），orchestrator 原样
    落 body.reason（customers.py:515）；这里钉 worker 现状（全空白 ⇒ None）。
    """
    conn = _StubConn(
        fetchrow=[
            _customer_row(stage="active", stage_display="active"),
            _customer_row(stage="inactive", stage_display="inactive"),
        ],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch(
            "/api/v1/customers/3/stage",
            json={"stage": "inactive", "reason": "  客户关停  "},
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == _CUSTOMER_KEYS | {"closed_inquiries"}
    assert body["stage"] == "inactive" and body["manual_stage"] == "inactive"
    assert body["closed_inquiries"] == []

    update_sql, update_args = next(
        (s, a) for s, a in conn.executed if s.startswith("UPDATE customers SET stage")
    )
    assert update_args == ("inactive", 3)
    log_sql, log_args = next(
        (s, a) for s, a in conn.executed if "INSERT INTO cust_stage_log" in s
    )
    assert log_args == ("default", 3, "active", "inactive", "2", "客户关停")
    # 2026-10-18 口径：询盘/订单阶段不再联动客户阶段 ⇒ 不写 closed_inquiries 到 DB
    assert "UPDATE cust_inquiries" not in conn.executed_sql()


def test_stage_change_non_owner_is_forbidden():
    """已修 2026-10-19：同团队非属主改阶段 → 403 NOT_OWNER（PARITY-CRM-9）。"""
    conn = _StubConn(
        fetchrow=[
            _customer_row(owner_id="99", team_id=1, stage="active", stage_display="active"),
            _customer_row(owner_id="99", team_id=1, stage="inactive", stage_display="inactive"),
        ],
    )
    with _patched(conn=conn, user=TEAMMATE):
        resp = client.patch("/api/v1/customers/3/stage", json={"stage": "inactive"})
    assert resp.status_code == 403
    assert "UPDATE customers SET stage" not in conn.executed_sql()


def test_parity_crm_9_stage_change_non_owner_is_403():
    conn = _StubConn(
        fetchrow=[
            _customer_row(owner_id="99", team_id=1),
            _customer_row(owner_id="99", team_id=1, stage="inactive"),
        ],
    )
    with _patched(conn=conn, user=TEAMMATE):
        resp = client.patch("/api/v1/customers/3/stage", json={"stage": "inactive"})
    assert resp.status_code == 403


# ════════════════════════════════════════════════════════════════════════════
# 7. 联系人（POST / PATCH / DELETE）
# ════════════════════════════════════════════════════════════════════════════

def test_add_contact_returns_projected_row():
    """PARITY-CRM-11 已对齐：POST 201 返回 7 键投影（customers.py:556-558）。

    已修 2026-10-19：写权限与客户一致（非属主 403）；本测试用属主 MEMBER 验证响应形状。
    """
    conn = _StubConn(fetchrow=[_customer_row(), _contact_row(name="Mary")])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post("/api/v1/customers/3/contacts", json={"customer_id": 3, "name": "Mary"})

    assert resp.status_code == 201, resp.text
    assert set(resp.json()) == _ORCH_CONTACT_KEYS
    assert resp.json()["name"] == "Mary"
    assert "INSERT INTO cust_contacts" in conn.sql()


def test_update_contact_404_body_is_contact_not_found():
    """已修 2026-10-19：404 body 与 orchestrator 对齐（PARITY-CRM-13）。"""
    conn = _StubConn(fetchrow=[_customer_row(), None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/customers/3/contacts/5", json={"name": "X"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "not_found", "code": "CONTACT_NOT_FOUND"}


def test_update_contact_returns_projected_row():
    """PATCH 联系人响应也是 7 键投影（CRM-11 的同族遗漏，2026-10-19 一并收口）。

    orchestrator 的 `update_contact` 与 `create_contact` 返回同一份 7 键投影
    （customers.py:606-608 / 556-558）；worker 原先只有 POST 是整行、PATCH 也整行，
    现在两处都走 `_contact_api`。
    """
    conn = _StubConn(
        fetchrow=[_customer_row(), _contact_row(), _contact_row(name="X")],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/customers/3/contacts/5", json={"name": "X"})
    assert resp.status_code == 200, resp.text
    assert set(resp.json()) == _ORCH_CONTACT_KEYS
    assert resp.json()["name"] == "X"


def test_delete_missing_contact_is_404():
    """已修 2026-10-19：联系人不存在 → 404 CONTACT_NOT_FOUND（PARITY-CRM-15）。"""
    conn = _StubConn(fetchrow=[_customer_row()])
    with _patched(conn=conn, user=MEMBER):
        resp = client.delete("/api/v1/customers/3/contacts/5")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "CONTACT_NOT_FOUND"
    assert "DELETE FROM cust_contacts" not in conn.sql()


def test_parity_crm_10_add_contact_without_customer_id():
    """已修 2026-10-19：body 不再要求 customer_id（PARITY-CRM-10）。"""
    conn = _StubConn(fetchrow=[_customer_row(), _contact_row()])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post("/api/v1/customers/3/contacts", json={"name": "Mary"})
    assert resp.status_code == 201


def test_parity_crm_12_add_primary_contact_unsets_others():
    conn = _StubConn(fetchrow=[_customer_row(), _contact_row(is_primary=True)])
    with _patched(conn=conn, user=MEMBER):
        client.post(
            "/api/v1/customers/3/contacts",
            json={"customer_id": 3, "name": "Mary", "is_primary": True},
        )
    assert "UPDATE cust_contacts SET is_primary=false" in conn.sql()


def test_parity_crm_13_update_missing_contact_404_body():
    conn = _StubConn(fetchrow=[_customer_row(), None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/customers/3/contacts/5", json={"name": "X"})
    assert resp.json()["detail"] == {"error": "not_found", "code": "CONTACT_NOT_FOUND"}


def test_update_contact_explicit_null_clears_phone():
    """PARITY-CRM-14 已对齐：显式 null 清空字段（customers.py:590-604）。

    代码在 1bfa3a5 已从 COALESCE 改成「按 exclude_unset 的列直接 SET」；本用例此前
    仍 xfail，只因测试桩**第三次 fetchrow 返回的还是旧行**（模拟 COALESCE 的返回值）。
    现在桩改成「UPDATE ... RETURNING * 返回已清空的行」，棘轮按 strict 规则摘除。
    """
    conn = _StubConn(
        fetchrow=[
            _customer_row(),                # 1. 取客户（可见性/写权限）
            _contact_row(phone="+1 555"),   # 2. 取联系人
            _contact_row(phone=None),       # 3. UPDATE ... RETURNING *（已清空）
        ],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/customers/3/contacts/5", json={"phone": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["phone"] is None
    update_sql, update_args = next(
        (s, a) for s, a in conn.calls if s.startswith("UPDATE cust_contacts SET")
    )
    assert "phone=$2" in update_sql and "COALESCE" not in update_sql
    assert update_args == (5, None)


def test_parity_crm_15_delete_missing_contact_is_404():
    conn = _StubConn(fetchrow=[_customer_row()])
    with _patched(conn=conn, user=MEMBER):
        resp = client.delete("/api/v1/customers/3/contacts/5")
    assert resp.status_code == 404


# ════════════════════════════════════════════════════════════════════════════
# 8. 询盘（POST / GET per-customer / GET all / PATCH）
# ════════════════════════════════════════════════════════════════════════════

def test_add_inquiry_ignores_forged_status():
    """已修 2026-10-19：body.status 被忽略，恒写 unquoted（PARITY-CRM-20）。

    PARITY-CRM-22 已对齐：响应走共享 `row_to_inquiry` 投影（见下方断言键集）。
    """
    conn = _StubConn(
        fetchrow=[_customer_row(), _inquiry_row(status="unquoted")],
        fetchval=[None],                      # 询盘编号同秒冲突探测：无冲突
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers/3/inquiries",
            json={"customer_id": 3, "channel": "email", "status": "lost"},
        )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == _INQUIRY_KEYS
    assert body["status"] == "unquoted"       # 伪造的 lost 被忽略

    insert_sql, args = next(
        (s, a) for s, a in conn.calls if "INSERT INTO cust_inquiries" in s
    )
    assert "'unquoted'" in insert_sql
    assert args[0] == "default" and args[1] == 3
    assert args[3] == "email"                 # channel
    assert args[13] == "private"              # owner_scope 缺省 private（响应已投影掉该列）


def test_add_inquiry_body_does_not_require_customer_id():
    """已修 2026-10-19：body 不再要求 customer_id（orchestrator 契约，PARITY-CRM-16）。"""
    conn = _StubConn(fetchrow=[_customer_row(), _inquiry_row()], fetchval=[None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post("/api/v1/customers/3/inquiries", json={"channel": "email"})
    assert resp.status_code == 201, resp.text


def test_customer_inquiries_list_has_editable_flag_and_status_filter():
    """`{items,total}`；每项 = row_to_inquiry + inquiry_no_editable（ws_crm_ext.py:216-249）。

    PARITY-CRM-23（**有意保留**）：orchestrator 同端点没有 inquiry_no_editable
    （customers.py:669），worker 多这个键 —— 前端客户页用它控制「编号」是否可编辑
    （customers/page.tsx 的 `Inquiry.inquiry_no_editable`，消费处 page.tsx:1060）。
    删键会让已报价询盘也能改号、破坏报价链路，故保留（见文件头「收尾」说明）。
    """
    db = _StubDb(fetchrow=[_customer_row()], fetch=[[_inquiry_row()]], fetchval=[1])
    with _patched(db=db, user=MEMBER):
        resp = client.get("/api/v1/customers/3/inquiries?status=unquoted")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"items", "total"} and body["total"] == 1
    item = body["items"][0]
    assert set(item) == _INQUIRY_KEYS | {"inquiry_no_editable"}
    assert item["inquiry_no_editable"] is False
    assert "ORDER BY created_at DESC" in db.sql()

    # 非法 status → 422（共享枚举），且先判客户可见性（404 优先于 422）——
    # 与 orchestrator 同序（customers.py:658-666）。
    db = _StubDb(fetchrow=[None])
    with _patched(db=db, user=MEMBER):
        resp = client.get("/api/v1/customers/3/inquiries?status=won")
    assert resp.status_code == 404

    db = _StubDb(fetchrow=[_customer_row()])
    with _patched(db=db, user=MEMBER):
        resp = client.get("/api/v1/customers/3/inquiries?status=won")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_all_inquiries_list_shape_scope_and_order():
    """`{items,total}`，每项 = row_to_inquiry + company_name；三层可见 + 客户内倒序。

    对齐：customers.py:706-727 / ws_crm_ext.py:252-291（含 team 条件）。
    """
    db = _StubDb(fetch=[[{**_inquiry_row(), "company_name": "ACME"}]])
    with _patched(db=db, user=MEMBER):
        resp = client.get("/api/v1/inquiries")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"items", "total"} and body["total"] == 1
    item = body["items"][0]
    assert set(item) == _INQUIRY_KEYS | _INQUIRY_LIST_EXTRA_KEYS
    assert item["company_name"] == "ACME"

    sql = db.sql()
    assert "JOIN customers c ON i.customer_id = c.id" in sql
    assert "(i.owner_id = $2 OR i.owner_scope = 'tenant' OR i.team_id = $3)" in sql
    assert "ORDER BY i.customer_id, i.created_at DESC" in sql

    # 管理员不加归属条件；status/customer_id 过滤都走参数绑定
    db = _StubDb(fetch=[[]])
    with _patched(db=db, user=ADMIN):
        client.get("/api/v1/inquiries?status=closed&customer_id=3")
    sql = db.sql()
    assert "i.owner_id = $" not in sql
    assert "i.status = $2" in sql and "i.customer_id = $3" in sql


def test_patch_inquiry_illegal_transition_409():
    """状态机：quoted → unquoted 非法（customers.py:788-800 / ws_crm_ext.py:354-370）。"""
    conn = _StubConn(fetchrow=[_inquiry_row(status="quoted")], fetchval=[None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/inquiries/7", json={"status": "unquoted"})

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ILLEGAL_TRANSITION"
    assert "UPDATE cust_inquiries" not in conn.sql()


def test_patch_inquiry_close_syncs_lead_without_touching_customer_stage():
    """关闭询盘：写 status + 回写线索池，**不**联动客户阶段（2026-10-18 口径，两端一致）。

    对齐：customers.py:782-807（sync_inquiry_status）+ main.py 注释 L1385-1386 / ws_crm_ext.py:146-161。
    """
    inq = _inquiry_row(status="unquoted", lead_id=77)
    conn = _StubConn(
        fetchrow=[inq, _inquiry_row(status="closed", lead_id=77)],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/inquiries/7", json={"status": "closed"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "closed"
    executed = conn.executed_sql()
    assert "UPDATE lead_candidates" in executed
    assert "inquiry_status IS DISTINCT FROM $1" in executed
    sync_sql, sync_args = next(
        (s, a) for s, a in conn.executed if "UPDATE lead_candidates" in s
    )
    assert sync_args == ("lost", "default", 77)     # closed → lost（§7.2 映射）
    assert "cust_stage_log" not in executed
    assert "UPDATE customers SET stage" not in executed


def test_patch_inquiry_inquiry_no_rules():
    """编号：非法 422 / 已报价锁号 409 / 撞号 409 —— 与 orchestrator 同错误体。

    历史：这条路径曾因共享内核 `number_rules.normalize_number` 引用未定义的
    `_NUMBER_RE` / `MAX_LEN`（7b21e1d 重写时丢失）而 NameError → 500（orchestrator
    与 worker 共用同一份内核，两侧同时中枪）。2026-10-19 已补回常量并在两侧同步，
    本用例转为**常规回归**，把 422/409 契约钉死。
    """
    # 非法编号（含空格）
    conn = _StubConn(fetchrow=[_inquiry_row()])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/inquiries/7", json={"inquiry_no": "BAD NO"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_INQUIRY_NO"

    # 已生成报价 → 锁号
    conn = _StubConn(fetchrow=[_inquiry_row()], fetchval=[1])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/inquiries/7", json={"inquiry_no": "INQ-NEW"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "INQUIRY_NO_LOCKED"

    # 撞号
    conn = _StubConn(fetchrow=[_inquiry_row()], fetchval=[None, 1])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/inquiries/7", json={"inquiry_no": "INQ-NEW"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "INQUIRY_NO_TAKEN"


def test_patch_inquiry_visibility_and_write_access():
    """不可见 → 404 INQUIRY_NOT_FOUND；同团队非属主 → 403 NOT_OWNER（与 orchestrator 同体）。"""
    conn = _StubConn(fetchrow=[_inquiry_row(team_id=2, owner_id="99")])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/inquiries/7", json={"status": "closed"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "not_found", "code": "INQUIRY_NOT_FOUND"}

    conn = _StubConn(fetchrow=[_inquiry_row(team_id=1, owner_id="99")])
    with _patched(conn=conn, user=TEAMMATE):
        resp = client.patch("/api/v1/inquiries/7", json={"status": "closed"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == {
        "error": "forbidden", "code": "NOT_OWNER", "detail": "只能修改自己账号的数据",
    }


def test_patch_inquiry_empty_body_returns_serialized_row():
    """空 body：两端都不发 UPDATE，原样回显且是共享 serializer 形状（无差异）。"""
    conn = _StubConn(fetchrow=[_inquiry_row()])
    with _patched(conn=conn, user=MEMBER):
        resp = client.patch("/api/v1/inquiries/7", json={})
    assert resp.status_code == 200
    assert set(resp.json()) == _INQUIRY_KEYS
    assert "UPDATE cust_inquiries" not in conn.sql()


def test_parity_crm_16_add_inquiry_without_customer_id():
    conn = _StubConn(fetchrow=[_customer_row(), _inquiry_row()], fetchval=[None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post("/api/v1/customers/3/inquiries", json={"channel": "email"})
    assert resp.status_code == 201


def test_parity_crm_17_add_inquiry_rejects_unknown_channel():
    conn = _StubConn(fetchrow=[_customer_row(), _inquiry_row()], fetchval=[None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers/3/inquiries",
            json={"customer_id": 3, "channel": "telepathy"},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_parity_crm_18_add_inquiry_persists_lead_id():
    conn = _StubConn(
        fetchrow=[_customer_row(), _inquiry_row(lead_id=77)],
        fetchval=[None],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers/3/inquiries",
            json={"customer_id": 3, "channel": "email", "lead_id": 77},
        )
    assert resp.json()["lead_id"] == 77


def test_parity_crm_19_add_inquiry_honors_owner_scope():
    """PARITY-CRM-19：body.owner_scope 落库（响应是 row_to_inquiry 投影，不含该列）。

    投影后响应里没有 owner_scope（与 orchestrator 一致），故断言 INSERT 实参。
    """
    conn = _StubConn(
        fetchrow=[_customer_row(), _inquiry_row(owner_scope="tenant")],
        fetchval=[None],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers/3/inquiries",
            json={"customer_id": 3, "channel": "email", "owner_scope": "tenant"},
        )
    assert resp.status_code == 201, resp.text
    assert "owner_scope" not in resp.json()
    _, args = next(
        (s, a) for s, a in conn.calls if "INSERT INTO cust_inquiries" in s
    )
    assert args[13] == "tenant"


def test_parity_crm_20_add_inquiry_status_is_always_unquoted():
    conn = _StubConn(
        fetchrow=[_customer_row(), _inquiry_row(status="unquoted")],
        fetchval=[None],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers/3/inquiries",
            json={"customer_id": 3, "channel": "email", "status": "lost"},
        )
    assert resp.json()["status"] == "unquoted"


def test_parity_crm_21_add_inquiry_non_owner_is_403():
    conn = _StubConn(
        fetchrow=[_customer_row(owner_id="99", team_id=1), _inquiry_row(lead_id=None)],
        fetchval=[None],
    )
    with _patched(conn=conn, user=TEAMMATE):
        resp = client.post(
            "/api/v1/customers/3/inquiries", json={"customer_id": 3, "channel": "email"}
        )
    assert resp.status_code == 403


def test_add_inquiry_returns_serializer_shape():
    """PARITY-CRM-22 已对齐：建询盘响应 = 共享 `row_to_inquiry` 投影（customers.py:703）。

    投影掉 `tenant_id` / `owner_id` / `owner_scope` / `updated_at` 等库内列。
    """
    conn = _StubConn(fetchrow=[_customer_row(), _inquiry_row()], fetchval=[None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.post(
            "/api/v1/customers/3/inquiries", json={"customer_id": 3, "channel": "email"}
        )
    assert resp.status_code == 201, resp.text
    assert set(resp.json()) == _INQUIRY_KEYS


def test_customer_inquiries_item_has_extra_editable_flag():
    """PARITY-CRM-23（**有意差异 · 保留 worker 行为**）：多 `inquiry_no_editable`。

    证据（前端有消费方）：`frontend/src/app/(app)/customers/page.tsx` 的
    `Inquiry.inquiry_no_editable`（第 90 行定义）在 1060 行控制「编号」编辑入口；
    该值来自「是否已生成报价」（已报价 ⇒ 锁号）。orchestrator customers.py:669
    不返回这个键 —— 删掉它前端就只能默认编号可改，已报价询盘也能改号。
    故本用例断言 worker 现行为（row_to_inquiry 的键 + inquiry_no_editable），
    而不是 orchestrator 口径；**不是** xfail，是明确登记的有意差异。
    """
    db = _StubDb(fetchrow=[_customer_row()], fetch=[[_inquiry_row()]], fetchval=[None])
    with _patched(db=db, user=MEMBER):
        resp = client.get("/api/v1/customers/3/inquiries")
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert set(item) == _INQUIRY_KEYS | {"inquiry_no_editable"}
    # 反向自证：确实比 orchestrator 多一个键
    assert set(item) - _INQUIRY_KEYS == {"inquiry_no_editable"}
    assert item["inquiry_no_editable"] is True     # 无报价引用 ⇒ 编号可改


# ════════════════════════════════════════════════════════════════════════════
# 9. GET /api/v1/customers/{customer_id}/records（往来记录树 · 无差异）
# ════════════════════════════════════════════════════════════════════════════

def test_customer_records_tree_matches_shared_contract():
    """两侧共用 `build_records`：同一批行必须装配出**逐字相同**的树。"""
    quotes = [{
        "id": 4, "quote_no": "QUO-4", "status": "accepted", "currency": "USD",
        "total_amount": Decimal("12300.00"), "created_at": _NOW,
    }]
    orders = [{
        "id": 1, "order_no": "ORD-1", "quote_id": 4, "status": "confirmed",
        "currency": "USD", "total_amount": Decimal("12300.00"), "created_at": _NOW,
    }]
    docs = [{
        "id": 12, "doc_no": "QUO-4", "doc_type": "quotation", "quote_id": 4,
        "order_id": None, "status": "issued", "currency": "USD",
        "total_amount": Decimal("12300.00"), "created_at": _NOW,
    }]
    conn = _StubConn(
        fetchrow=[_customer_row()],
        fetch=[[dict(r) for r in quotes], [dict(r) for r in orders], [dict(r) for r in docs]],
    )
    with _patched(conn=conn, user=MEMBER):
        resp = client.get("/api/v1/customers/3/records")

    assert resp.status_code == 200, resp.text
    expected = build_records(
        {**_customer_row(), "id": 3},
        [dict(r) for r in quotes], [dict(r) for r in orders], [dict(r) for r in docs],
    )
    assert resp.json() == expected
    body = resp.json()
    assert set(body) == {"customer", "counts", "quotes", "direct"}
    assert body["customer"] == {"id": 3, "name": "ACME", "team_id": 1}
    assert body["counts"] == {"quotes": 1, "orders": 1, "documents": 1}
    assert body["quotes"][0]["documents"][0]["doc_no"] == "QUO-4"
    assert [o["order_no"] for o in body["quotes"][0]["orders"]] == ["ORD-1"]
    assert body["direct"] == {"orders": [], "documents": []}
    # 查询按客户收口，单据不再单独按人过滤（客户可见 ⇒ 整条业务链可见，两端一致）
    sql = conn.sql()
    assert "FROM quote_orders WHERE customer_id=$1 AND tenant_id=$2" in sql
    assert "FROM orders WHERE customer_id=$1 AND tenant_id=$2" in sql
    assert "FROM trade_docs WHERE customer_id=$1 AND tenant_id=$2" in sql


def test_customer_records_invisible_customer_is_404():
    """不可见 / 已软删客户 → 404（与详情同口径，不泄露存在性）。"""
    conn = _StubConn(fetchrow=[None])
    with _patched(conn=conn, user=MEMBER):
        resp = client.get("/api/v1/customers/3/records")
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "not_found", "code": "CUSTOMER_NOT_FOUND"}
    assert len(conn.calls) == 1
