"""客户 ↔ 单据关联 + 客户往来记录树（`/records`）的回归测试。

本文件由 `tests/test_customer_documents.py` 改造而来（2026-10-11）
------------------------------------------------------------------
旧端点 `GET /api/v1/customers/{id}/documents`（"报价 / 订单 / 单证 **三个平行列表**"
的旧形状）已删除：业务确认客户粒度看的是**包含关系树**，端点
`GET /api/v1/customers/{id}/records` 取代了它（前端只按 /records 解析：
`frontend/src/lib/customer/customer-records.ts`）。契约与设计见
`docs/CUSTOMER_DOCUMENTS_VIEW.md`，装配逻辑在共享内核
`kaas_common/workstation/customer_records.py`（orchestrator 与 worker 共用一份）。

原文件里针对 `/documents` 的断言怎么处置的
------------------------------------------
**迁移到 `/records` 树上（覆盖不降级）**：
1. "客户粒度能查到该客户的报价/订单/单证" → 树上的 `quotes` / `direct` / `counts`，
   并额外钉住包含关系（报价下的订单、订单下的单证、只归属客户的 direct）；
2. "不可见客户 → 404，不泄露它的单据" → 同一场景，改打 `/records`；
3. "已软删客户 → 404"；
4. "没有单据的客户 → 空结果 + 计数 0（不是 404、也不是缺字段）"。

**删除（在树结构下不再适用，故不留）**：
- **三个平行列表的形状断言**：`body["quotes"] / ["orders"] / ["trade_docs"]` 三个
  平铺数组、以及"单证在平铺列表里直接带 id/doc_no/doc_type/status/created_at"这类
  逐字段断言。树里单证挂在**它的父**（报价单 / 订单 / `direct`）下，没有平铺的
  `trade_docs` key；而且这正是要废弃的旧形状 —— 把它搬到树上就等于把旧契约又钉回来。
- 旧形状的 `counts` 键名（`quotes` / `orders` / `trade_docs`）：树是
  `quotes` / `orders` / `documents`。
- 被删掉的两个断言的**等价覆盖**仍在，只是换了宿主：字段级契约（`total_amount`
  空值留空而不是 0、金额 Decimal 必须序列化成字符串、直接父缺失时落 `direct`
  而不是消失）由 `tests/test_customer_records_tree.py` 的单测逐条钉住；
  worker 侧同契约见 `backend/worker/tests/test_customer_records.py`。

本文件另外两条与 `/documents` 端点**无关**的覆盖一并保留（它们是"客户能查到单据"
的前提，删掉就是真降级）：
- 迁移 202610110009 的语义（脏 customer_id → NULL、按客户名回填、行数一条不少）；
- 新建/改单时的客户引用强校验（不存在 / 已软删 / **看不见的客户** → 404。
  2026-10-11 起口径是内核 `visible_to` 的"能看见 ⟺ 能引用"，
  不再是简单的"团队必须相等" —— 所以用例显式造"属主也不是我"的客户）。
"""
import importlib.util
import json
from pathlib import Path

import pytest
from sqlalchemy import select, text

from app.core.auth import AuthContext
from app.db.models import Customer, Team
from app.db.workstation_links import Order, QuoteOrder, TradeDoc
from app.main import app
from app.middleware.auth import AuthContextMiddleware
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db

TENANT = "default"
MY_TEAM = 9101
OTHER_TEAM = 9102
USER_ID = 7

# 临时数据统一带这个前缀，跑完按它清理（用完即删，不给测试库留垃圾）
QA = "qa_custlink"

MIGRATION_FILE = "202610110009_link_docs_to_customer.py"
MIGRATION_PATH = Path(__file__).resolve().parents[1] / "alembic" / "versions" / MIGRATION_FILE

# 迁移前的版本号（本次迁移的 down_revision）
PREV_REV = "202610110008"

ITEM = {
    "product_name": "Field Fence 1.5m", "qty": 100, "qty_unit": "roll",
    "unit_price": 52.5, "line_amount": 5250.0, "source": "manual",
}


# ── 注入"本团队"账号 ─────────────────────────────────────────────────────────
#
# conftest 的默认注入账号**没有 team_id**（team_id=None），而本文件的用例
# 正是要验证"客户必须属于本团队" —— 没有团队就无从验证。这里在 conftest 的
# mock 之上再盖一层（autouse，保证早于 client/db_session 完成注入）。

def _install_auth(*, account_type: str = "internal", team_id: int = MY_TEAM):
    async def _dispatch(self, request, call_next):
        if any(request.url.path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
            return await call_next(request)
        request.state.auth = AuthContext(
            user_id=USER_ID, account_type=account_type, role="user",
            tenant_id=TENANT, team_id=team_id,
        )
        # 真实 AuthContextMiddleware 也会写 `request.state.tenant_id`
        # （`app/middleware/auth.py`：业务不以租户做鉴权边界，固定 default）。
        # 漏掉它，下游 TenantContextMiddleware 就会对**非 internal** 账号要求
        # X-Tenant-Id header → 401 "X-Tenant-Id header is required"，
        # 于是"不可见客户 → 404"会被一个与客户可见性无关的 401 抢先顶掉。
        request.state.tenant_id = TENANT
        return await call_next(request)

    old = AuthContextMiddleware.dispatch
    AuthContextMiddleware.dispatch = _dispatch
    app.middleware_stack = None
    return old


@pytest.fixture(autouse=True)
def _team_scoped_auth():
    old = _install_auth()
    yield
    AuthContextMiddleware.dispatch = old
    app.middleware_stack = None


# ── 迁移语义（临时 schema 里跑迁移自己的函数）────────────────────────────────

_LOADED: dict = {}


def _migration():
    """按文件路径加载迁移模块（alembic/versions 不是包，import 不进来）。"""
    if "mod" not in _LOADED:
        spec = importlib.util.spec_from_file_location("mig_202610110009", MIGRATION_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _LOADED["mod"] = module
    return _LOADED["mod"]


SCHEMA = "qa_custlink_mig"

# 迁移前的表结构：customer_id 是 **TEXT、无外键**（真实历史形态）
SCRATCH_DDL = f"""
CREATE SCHEMA {SCHEMA};
CREATE TABLE {SCHEMA}.customers (
    id bigserial PRIMARY KEY,
    tenant_id text NOT NULL,
    name text NOT NULL,
    team_id bigint,
    is_deleted boolean NOT NULL DEFAULT false
);
CREATE TABLE {SCHEMA}.quote_orders (
    id bigserial PRIMARY KEY, tenant_id text NOT NULL, quote_no text NOT NULL UNIQUE,
    customer_id text, customer_name text, team_id bigint
);
CREATE TABLE {SCHEMA}.orders (
    id bigserial PRIMARY KEY, tenant_id text NOT NULL, order_no text NOT NULL UNIQUE,
    customer_id text, customer_name text, team_id bigint
);
CREATE TABLE {SCHEMA}.trade_docs (
    id bigserial PRIMARY KEY, tenant_id text NOT NULL, doc_no text NOT NULL UNIQUE,
    customer_id text, raw_payload jsonb, team_id bigint
);
"""

# 每张表的单号列
_NO_COL = {"quote_orders": "quote_no", "orders": "order_no", "trade_docs": "doc_no"}

_INSERT_DOC = {
    "quote_orders": (
        "INSERT INTO quote_orders (tenant_id, quote_no, customer_id, customer_name, team_id)"
        " VALUES (:tenant, :no, :cid, :cname, :team)"
    ),
    "orders": (
        "INSERT INTO orders (tenant_id, order_no, customer_id, customer_name, team_id)"
        " VALUES (:tenant, :no, :cid, :cname, :team)"
    ),
    "trade_docs": (
        "INSERT INTO trade_docs (tenant_id, doc_no, customer_id, raw_payload, team_id)"
        " VALUES (:tenant, :no, :cid, CAST(:payload AS jsonb), :team)"
    ),
}


def _doc_params(table: str, no: str, cid, cname: str, team: int) -> dict:
    """一张临时单据行：单证表没有 customer_name 列，名字进 raw_payload 快照。"""
    params = {"tenant": TENANT, "no": no, "cid": cid, "team": team}
    if table == "trade_docs":
        sources = {"quote": {"customer_name": cname}} if cname else {}
        params["payload"] = json.dumps({"sources": sources, "custom": {}})
    else:
        params["cname"] = cname
    return params


async def _insert_doc(conn, table: str, suffix: str, cid, cname, team) -> None:
    await conn.execute(
        text(_INSERT_DOC[table]), _doc_params(table, f"{QA}-{table}-{suffix}", cid, cname, team))


async def _counts(conn) -> dict:
    return {t: (await conn.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one()
            for t in _INSERT_DOC}


async def _run_upgrade(conn, mig) -> None:
    """与迁移 `upgrade()` 同一套步骤（只把 op.execute 换成 conn.execute）。

    刻意复用模块里的私有函数：跑的就是**真正会上线的那段 SQL**。
    """
    for table in mig.DOC_TABLES:
        def _step(sc, t=table):
            # 数据两步只对 TEXT 列有意义（已是 bigint 时再跑，正则会因类型不匹配报错）
            if (mig._column_type(sc, t) or "text") == "text":
                mig._backfill_by_name(sc, t)
                mig._null_out_invalid(sc, t)
            mig._to_bigint(sc, t)
            mig._add_fk(sc, t)
        await conn.run_sync(_step)
        await conn.execute(text(
            f"CREATE INDEX IF NOT EXISTS {mig._index_name(table)} ON {table} (customer_id)"))


class TestMigrationSemantics:
    """三张单据表 "回填 → 清洗 → 改类型 + 外键" 的真实 SQL 验证。"""

    async def test_dirty_values_cleaned_backfilled_and_no_row_lost(self, db_engine):
        mig = _migration()
        # 迁移的接线本身也要钉住：版本号/上一条是谁
        assert mig.revision == "202610110009"
        assert mig.down_revision == PREV_REV
        assert MIGRATION_PATH.name == MIGRATION_FILE

        async with db_engine.connect() as conn:
            trans = await conn.begin()
            try:
                for stmt in SCRATCH_DDL.split(";"):
                    if stmt.strip():
                        await conn.execute(text(stmt))
                # 事务级 search_path：迁移 SQL 里的表名与 to_regclass 都落到临时 schema
                await conn.execute(text(f"SET LOCAL search_path TO {SCHEMA}"))

                live = (await conn.execute(text(
                    "INSERT INTO customers (tenant_id, name, team_id, is_deleted)"
                    " VALUES (:t, :n, :team, false) RETURNING id"),
                    {"t": TENANT, "n": f"{QA} Buyer", "team": MY_TEAM})).scalar_one()
                deleted = (await conn.execute(text(
                    "INSERT INTO customers (tenant_id, name, team_id, is_deleted)"
                    " VALUES (:t, :n, :team, true) RETURNING id"),
                    {"t": TENANT, "n": f"{QA} Deleted", "team": MY_TEAM})).scalar_one()
                # 别家团队的同名客户：team_id 不匹配 → 不许跨团队回填
                await conn.execute(text(
                    "INSERT INTO customers (tenant_id, name, team_id, is_deleted)"
                    " VALUES (:t, :n, :team, false)"),
                    {"t": TENANT, "n": f"{QA} Other Team", "team": OTHER_TEAM})
                # 同团队两条同名客户：无法判断是哪一家 → 不许回填
                await conn.execute(text(
                    "INSERT INTO customers (tenant_id, name, team_id, is_deleted)"
                    " VALUES (:t, :n, :team, false), (:t, :n, :team, false)"),
                    {"t": TENANT, "n": f"{QA} Dup", "team": MY_TEAM})

                for table in _INSERT_DOC:
                    await _insert_doc(conn, table, "backfill", "lianjia-demo",
                                      f"{QA} Buyer", MY_TEAM)
                    await _insert_doc(conn, table, "ghost", "424242",
                                      f"{QA} Nobody", MY_TEAM)
                    await _insert_doc(conn, table, "deleted", str(deleted),
                                      f"{QA} Deleted", MY_TEAM)
                    await _insert_doc(conn, table, "keep", str(live),
                                      f"{QA} Buyer", MY_TEAM)
                    await _insert_doc(conn, table, "crossteam", None,
                                      f"{QA} Other Team", MY_TEAM)
                    await _insert_doc(conn, table, "huge", "9" * 25,
                                      f"{QA} Nobody", MY_TEAM)
                    await _insert_doc(conn, table, "dup", "lianjia-demo",
                                      f"{QA} Dup", MY_TEAM)
                    await _insert_doc(conn, table, "emptyname", "lianjia-demo",
                                      "", MY_TEAM)
                # 派生单证：客户名埋在"源单证整份 payload"的再一层里
                await conn.execute(text(
                    "INSERT INTO trade_docs (tenant_id, doc_no, customer_id, raw_payload, team_id)"
                    " VALUES (:t, :no, 'lianjia-demo', CAST(:p AS jsonb), :team)"),
                    {"t": TENANT, "no": f"{QA}-trade_docs-nested", "team": MY_TEAM,
                     "p": json.dumps({"sources": {"quotation": {"sources": {
                         "quote": {"customer_name": f"{QA} Buyer"}}}}, "custom": {}})})

                before = await _counts(conn)

                # ① 跑迁移 ② 再跑一遍（幂等：重复 upgrade 不许炸、也不许改变结果）
                await _run_upgrade(conn, mig)
                await _run_upgrade(conn, mig)

                # 行数一条不少（迁移只改列/加约束，绝不删行）
                assert await _counts(conn) == before

                # 类型 + 外键（ON DELETE SET NULL）+ 索引
                for table in mig.DOC_TABLES:
                    assert (await conn.execute(text(
                        "SELECT format_type(a.atttypid, NULL) FROM pg_attribute a"
                        " WHERE a.attrelid = to_regclass(:t) AND a.attname = 'customer_id'"),
                        {"t": table})).scalar_one() == "bigint"
                    assert (await conn.execute(text(
                        "SELECT confdeltype::text FROM pg_constraint"
                        " WHERE conrelid = to_regclass(:t) AND conname = :n"),
                        {"t": table, "n": mig._fk_name(table)})).scalar_one() == "n"
                    assert (await conn.execute(text(
                        "SELECT count(*) FROM pg_indexes WHERE indexname = :n"),
                        {"n": mig._index_name(table)})).scalar_one() == 1

                # 数据结果逐行核对
                for table in mig.DOC_TABLES:
                    rows = dict((await conn.execute(text(
                        f"SELECT {_NO_COL[table]}, customer_id FROM {table}"))).all())
                    key = f"{QA}-{table}"
                    assert rows[f"{key}-backfill"] == live, f"{table} 未按客户名回填"
                    assert rows[f"{key}-ghost"] is None, f"{table} 幽灵 id 未清洗"
                    assert rows[f"{key}-deleted"] is None, f"{table} 已删客户未清洗"
                    assert rows[f"{key}-keep"] == live, f"{table} 覆盖了已有有效关联"
                    assert rows[f"{key}-crossteam"] is None, f"{table} 跨团队回填了"
                    assert rows[f"{key}-huge"] is None, f"{table} 超长数字未清洗"
                    assert rows[f"{key}-dup"] is None, f"{table} 同名多条却猜了一家"
                    assert rows[f"{key}-emptyname"] is None, f"{table} 空名字却回填了"
                assert (await conn.execute(text(
                    "SELECT customer_id FROM trade_docs WHERE doc_no = :n"),
                    {"n": f"{QA}-trade_docs-nested"})).scalar_one() == live, \
                    "单证派生链（嵌套快照）未按客户名回填"

                # ③ downgrade 路径：删外键/索引、类型改回 TEXT，行数不变
                for table in reversed(mig.DOC_TABLES):
                    await conn.execute(text(f"DROP INDEX IF EXISTS {mig._index_name(table)}"))
                    await conn.run_sync(lambda sc, t=table: mig._drop_fk(sc, t))
                    await conn.run_sync(lambda sc, t=table: mig._to_text(sc, t))
                for table in mig.DOC_TABLES:
                    assert (await conn.execute(text(
                        "SELECT format_type(a.atttypid, NULL) FROM pg_attribute a"
                        " WHERE a.attrelid = to_regclass(:t) AND a.attname = 'customer_id'"),
                        {"t": table})).scalar_one() == "text"
                assert await _counts(conn) == before
            finally:
                # 整体回滚：临时 schema 与其中的数据都不落库
                await trans.rollback()


# ── 新建单据时的客户引用校验 ─────────────────────────────────────────────────

def _create_payload(path: str, customer_id) -> dict:
    if path.endswith("/trade-docs"):
        return {"doc_type": "ci", "customer_id": customer_id, "items": [dict(ITEM)]}
    return {"customer_id": customer_id, "currency": "USD"}


async def _ensure_team(db_session, team_id: int) -> None:
    """`customers.team_id` 有外键指向 `teams` —— 造客户前先有团队。"""
    exists = (await db_session.execute(
        select(Team).where(Team.id == team_id))).scalar_one_or_none()
    if exists is None:
        db_session.add(Team(id=team_id, tenant_id=TENANT, name=f"QA Team {team_id}"))
        await db_session.flush()


async def _make_customer(db_session, *, team_id, name, is_deleted=False,
                         owner_id: str | None = None) -> Customer:
    """造一个业务客户。

    `owner_id` 默认是当前账号（`USER_ID`）：客户域的可见性判定是
    `owner_id=我 / owner_scope=tenant`（`customers.py::_scope_filter`），
    所以**别人的客户要把 owner_id 指到别人**，否则"不可见"场景根本造不出来。
    """
    await _ensure_team(db_session, team_id)
    customer = Customer(
        tenant_id=TENANT, name=name, team_id=team_id,
        owner_id=owner_id or str(USER_ID), owner_scope="private",
        is_deleted=is_deleted,
    )
    db_session.add(customer)
    await db_session.flush()
    return customer


class TestDocCustomerReference:
    DOC_PATHS = ("/api/v1/quotes", "/api/v1/orders", "/api/v1/trade-docs")

    @pytest.mark.parametrize("path", DOC_PATHS)
    async def test_unknown_customer_404(self, client, path):
        """引用不存在的客户 → 404 CUSTOMER_NOT_FOUND（不落单）。"""
        resp = await client.post(path, json=_create_payload(path, 987654321))
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"

    @pytest.mark.parametrize("path", DOC_PATHS)
    async def test_other_team_customer_404(self, client, db_session, path):
        """别人的客户（别家团队 **且** 属主不是我）→ 404，与"不存在"同一副面孔。

        为什么要显式给 `owner_id="9999"`：引用校验已经统一成
        "**能看见 ⟺ 能引用**"（`ws_common.resolve_customer_for_doc` → 内核
        `visible_to`：管理员 / `owner_scope=tenant` / `owner_id=我` / `team_id=我的团队`）。
        只把 `team_id` 设成别家团队、属主仍是自己时，客户是**可见**的 ——
        开单会被放行。可见性到底怎么判，由内核那一份规则说了算，这里只负责
        造出一个"真的看不见"的客户。
        """
        other = await _make_customer(
            db_session, team_id=OTHER_TEAM, name="别家客户", owner_id="9999")
        resp = await client.post(path, json=_create_payload(path, other.id))
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"

    @pytest.mark.parametrize("path", DOC_PATHS)
    async def test_soft_deleted_customer_404(self, client, db_session, path):
        """引用已软删的客户 → 404（软删就是"不存在"）。"""
        gone = await _make_customer(
            db_session, team_id=MY_TEAM, name="已删客户", is_deleted=True)
        resp = await client.post(path, json=_create_payload(path, gone.id))
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"

    async def test_quote_created_with_team_customer(self, client, db_session):
        """正常引用本团队客户 → 201；customer_id 落库、快照名自动填、团队随客户。"""
        mine = await _make_customer(db_session, team_id=MY_TEAM, name="My Buyer")

        resp = await client.post("/api/v1/quotes", json={
            "customer_id": mine.id, "currency": "USD",
        })
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["customer_id"] == mine.id
        assert body["customer_name"] == "My Buyer"      # 没传名字 → 取客户档案名

        row = (await db_session.execute(
            select(QuoteOrder).where(QuoteOrder.id == body["id"])
        )).scalar_one()
        assert row.customer_id == mine.id
        assert row.team_id == MY_TEAM

    async def test_order_and_trade_doc_created_with_team_customer(self, client, db_session):
        """订单与单证同样：引用本团队客户 → 201 且 customer_id 落库。"""
        mine = await _make_customer(db_session, team_id=MY_TEAM, name="My Buyer 2")

        order_resp = await client.post("/api/v1/orders", json={
            "customer_id": mine.id, "currency": "USD",
        })
        assert order_resp.status_code == 201, order_resp.text
        assert order_resp.json()["customer_id"] == mine.id
        order_row = (await db_session.execute(
            select(Order).where(Order.id == order_resp.json()["id"])
        )).scalar_one()
        assert order_row.customer_id == mine.id
        assert order_row.team_id == MY_TEAM

        doc_resp = await client.post("/api/v1/trade-docs", json={
            "doc_type": "ci", "customer_id": mine.id, "items": [dict(ITEM)],
        })
        assert doc_resp.status_code == 201, doc_resp.text
        assert doc_resp.json()["customer_id"] == mine.id
        doc_row = (await db_session.execute(
            select(TradeDoc).where(TradeDoc.id == doc_resp.json()["id"])
        )).scalar_one()
        assert doc_row.customer_id == mine.id
        assert doc_row.team_id == MY_TEAM

    async def test_order_from_quote_inherits_customer(self, client, db_session):
        """报价转化订单：客户从报价单继承，并同样过校验。"""
        mine = await _make_customer(db_session, team_id=MY_TEAM, name="My Buyer 3")
        quote = (await client.post("/api/v1/quotes", json={
            "customer_id": mine.id, "currency": "USD",
        })).json()

        resp = await client.post("/api/v1/orders", json={"quote_order_id": quote["id"]})
        assert resp.status_code == 201, resp.text
        assert resp.json()["customer_id"] == mine.id
        assert resp.json()["customer_name"] == "My Buyer 3"

    async def test_patch_relinks_customer(self, client, db_session):
        """改单时也能认领客户（历史单据被清洗成 NULL 后的救济路径）。

        为什么"没有客户的报价"要**直接落库**、不再走 POST /quotes：
        报价是业务链条的根，新建报价**必须**带客户（现行实现 `quote_orders.py`
        缺 → 422 CUSTOMER_REQUIRED，与 worker 同口径），API 已经造不出这种单了；
        但列本身仍可空（迁移 202610110009 的 `ON DELETE SET NULL`：客户被硬删后
        报价单保留、customer_id 变 NULL），所以"历史遗留的 NULL 报价"是真实存在
        的形态，认领路径必须继续可用 —— 这里直接插一行来还原它。
        """
        mine = await _make_customer(db_session, team_id=MY_TEAM, name="My Buyer 4")
        # 历史遗留：没有客户、但单据仍在（迁移后 customer_id=NULL 的真实形态）
        legacy = QuoteOrder(
            tenant_id=TENANT, quote_no=f"{QA}-QUO-LEGACY", customer_id=None,
            status="draft", currency="USD",
            owner_id=str(USER_ID), owner_scope="private", team_id=MY_TEAM,
        )
        db_session.add(legacy)
        await db_session.flush()

        resp = await client.patch(f"/api/v1/quotes/{legacy.id}",
                                  json={"customer_id": mine.id})
        assert resp.status_code == 200, resp.text
        assert resp.json()["customer_id"] == mine.id
        assert resp.json()["customer_name"] == "My Buyer 4"

        # 换客户时同样拦"看不见的客户"（别家团队 + 属主不是我）
        other = await _make_customer(
            db_session, team_id=OTHER_TEAM, name="别家客户2", owner_id="9999")
        bad = await client.patch(f"/api/v1/quotes/{legacy.id}",
                                 json={"customer_id": other.id})
        assert bad.status_code == 404
        assert bad.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"


# ── 客户往来记录树（取代旧的 /documents 三个平行列表）────────────────────────

class TestCustomerRecords:
    """`GET /api/v1/customers/{id}/records`：客户粒度能查到他的报价/订单/单证。

    覆盖点（含从旧 `/documents` 用例迁移过来的三条）：
    - **能查到该客户的单据**：报价在 `quotes`、订单在报价下或 `direct`、
      单证挂在它的父（订单/报价）下或 `direct`；
    - **计数覆盖整棵树**（含 direct），否则客户页标题栏会少算；
    - **不可见客户 → 404**、**已软删客户 → 404**（与"不存在"同一副面孔）；
    - **没有单据的客户 → 空树 + 计数 0**（不是 404、也不是缺字段）。
    """

    async def _seed(self, client, db_session):
        """一个客户 + 一条完整业务链（报价 → 订单 → 单证）+ 两条 direct 数据。"""
        mine = await _make_customer(db_session, team_id=MY_TEAM, name="Agg Buyer")

        quote = (await client.post("/api/v1/quotes", json={
            "customer_id": mine.id, "currency": "USD",
        })).json()
        # 报价转化订单：挂到该报价下（列 + 链接表都写）
        order = (await client.post("/api/v1/orders", json={
            "quote_order_id": quote["id"],
        })).json()
        # 手动新建、没有报价父对象 → direct["orders"]（用户要能查到历史）
        manual_order = (await client.post("/api/v1/orders", json={
            "customer_id": mine.id, "currency": "USD",
        })).json()
        # 挂在订单下的单证（PI/CI…）→ 该订单的 documents
        doc = (await client.post("/api/v1/trade-docs", json={
            "doc_type": "ci", "order_id": order["id"], "items": [dict(ITEM)],
        })).json()
        # 只归属客户、没有父对象的单证（导入的历史）→ direct["documents"]
        loose_doc = (await client.post("/api/v1/trade-docs", json={
            "doc_type": "ci", "customer_id": mine.id, "items": [dict(ITEM)],
        })).json()
        return mine, quote, order, manual_order, doc, loose_doc

    async def _get_tree(self, client, customer_id):
        resp = await client.get(f"/api/v1/customers/{customer_id}/records")
        assert resp.status_code == 200, resp.text
        return resp.json()

    async def test_tree_lists_quote_orders_and_docs(self, client, db_session):
        """客户粒度能查到他的报价 / 订单 / 单证，并按包含关系挂好。"""
        mine, quote, order, manual_order, doc, loose_doc = await self._seed(client, db_session)

        body = await self._get_tree(client, mine.id)

        # 客户身份：树自带被查客户（前端标题栏直接用，不再二次请求详情）
        assert body["customer"]["id"] == mine.id
        assert body["customer"]["name"] == "Agg Buyer"
        assert body["customer"]["team_id"] == MY_TEAM

        # 报价（字段取实际列名：金额是 total_amount，空单留空而不是 0）
        assert len(body["quotes"]) == 1
        q = body["quotes"][0]
        assert q["id"] == quote["id"]
        assert q["quote_no"] == quote["quote_no"]
        assert q["status"] == "accepted"   # 下一条从这里转化出订单 → 报价被置 accepted
        assert q["total_amount"] is None
        assert q["currency"] == "USD"
        assert q["created_at"]

        # 报价转化的订单 → 挂在该报价下（不是平铺列表）
        assert [o["id"] for o in q["orders"]] == [order["id"]]
        o = q["orders"][0]
        assert o["order_no"] == order["order_no"]
        assert o["status"] == "pending"
        assert o["created_at"]

        # 挂在该订单下的单证
        assert [d["id"] for d in o["documents"]] == [doc["id"]]
        assert o["documents"][0]["doc_no"] == doc["doc_no"]
        assert o["documents"][0]["doc_type"] == "ci"
        assert o["documents"][0]["status"] == "draft"
        assert o["documents"][0]["created_at"]

        # 手动建的订单 / 只归属客户的单证 → direct（必须能被查到，不能从树上消失）
        assert [x["id"] for x in body["direct"]["orders"]] == [manual_order["id"]]
        assert [x["id"] for x in body["direct"]["documents"]] == [loose_doc["id"]]
        assert body["direct"]["documents"][0]["doc_no"] == loose_doc["doc_no"]

        # counts 覆盖整棵树（含 direct）—— 旧形状里的 counts 键名 trade_docs 已换成 documents
        assert body["counts"] == {"quotes": 1, "orders": 2, "documents": 2}

    async def test_empty_customer_returns_empty_tree(self, client, db_session):
        """没有单据的客户：空树 + 计数 0（不是 404，也不是缺字段）。"""
        mine = await _make_customer(db_session, team_id=MY_TEAM, name="No Docs Buyer")

        body = await self._get_tree(client, mine.id)

        assert body["quotes"] == []
        assert body["direct"] == {"orders": [], "documents": []}
        assert body["counts"] == {"quotes": 0, "orders": 0, "documents": 0}

    async def test_invisible_customer_404(self, client, db_session):
        """不可见（别家团队、且属主不是我）的客户 → 404，绝不泄露它的往来记录。

        必须切成 **customer 账号**：`internal` 账号在客户域是"看全部"
        （`kaas_common.workstation.customer_rules.can_see_all`：account_type=internal
        即全可见），用它根本造不出"不可见"这个场景。
        """
        other = await _make_customer(
            db_session, team_id=OTHER_TEAM, name="别家聚合客户", owner_id="9999")
        old = _install_auth(account_type="customer")
        try:
            resp = await client.get(f"/api/v1/customers/{other.id}/records")
        finally:
            AuthContextMiddleware.dispatch = old
            app.middleware_stack = None
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"

    async def test_deleted_customer_404(self, client, db_session):
        gone = await _make_customer(
            db_session, team_id=MY_TEAM, name="已删聚合客户", is_deleted=True)
        resp = await client.get(f"/api/v1/customers/{gone.id}/records")
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"
