"""`product_profiles` **读路径**的团队谓词（P7/P8 的产品基础信息部分）。

背景：写入侧自 P9 起已带 `team_id`，**读取侧此前漏了** ⇒ 别家团队的"产品基础信息"
会被读到。Q6 裁决原话是"**工位人人可见，但用户创建的业务数据仅团队内部可见**"⇒
本次把后半句落到读路径上。

四条语义（照 `docs/PRODUCT_MODULE_IMPL_PLAN.md` §8.1 的裁决后版本）

| 情形 | 期望 | 依据 |
|---|---|---|
| 本团队行 | 可读（200） | Q1=B + Q6 |
| 别团队行 | **404**（不泄露存在性） | Q6 + `product_scope` 的失败语义 |
| 历史 `team_id IS NULL` | **仅管理员可见**（非管理员 404） | D3/D4 |
| 系统级**定义** | **仍人人可读**（列表照旧返回 ⇒ 两层不许压平） | Q1=B 第一句 |

判定**复用** `kaas_common.workstation.product_scope`（task-19 交付的同一把尺）——
本文件同时钉住"没有第二套判断"。

⚠️ 这些用例**不需要 Postgres**：用 `async_client` 的 ASGI 通道 + 覆盖依赖
（`get_db_session` 换假会话、`get_auth_context` 换指定身份），在 **HTTP 层**验证真实端点
的状态码与载荷 —— 比只测纯函数强（路由/依赖/序列化都真跑）。

⚠️ 两个**测试替身**上的坑（都踩过，写在这里省下一次）：
1. 覆盖 `get_db_session` 必须给**async 生成器函数本身**；给"返回 async 生成器的普通
   lambda"会拿到 `async_generator` 对象 ⇒ 端点上 `.execute()` 直接 AttributeError。
2. **不要用 monkeypatch 换 `AuthContextMiddleware.dispatch` 来注入身份**：实测在同一进程里
   会出现**错位一拍**（某个用例拿到上一个用例的身份）。改为覆盖 FastAPI 依赖
   `get_auth_context`（端点就是 `Depends(get_auth_context)`）⇒ 与中间件解耦、确定性。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.auth import AuthContext
from app.core.auth import get_auth_context            # noqa: F401  (依赖覆盖用)
from app.main import app

pytestmark = pytest.mark.unit

TENANT = "default"
TEAM_A = 11
TEAM_B = 22

PROFILE_URL = "/api/v1/products/field_fence/profile"
LIST_URL = "/api/v1/products"

ADMIN = "system_admin"       # product_scope 认的管理员角色
MEMBER = "user"              # 普通团队成员


# ── 测试替身 ────────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def scalars(self):
        # 发现层合并（2026-10-17）后端点对 tenant_products 走 ORM select，
        # 这些用例不给 tenant 行 ⇒ scalars().all() 为空即可（回落注册表）。
        return self

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class _FakeDB:
    """只实现端点用到的那一小块：`await db.execute(text(sql), params)`。

    按 SQL 里的表名分发 —— 顺便把**真的 SQL 与参数**记下来，供"谓词是否带上"的断言用。
    """

    def __init__(self, profile_rows=(), media_rows=()):
        self._profile_rows = list(profile_rows)
        self._media_rows = list(media_rows)
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, stmt, params=None):
        sql = " ".join(str(stmt).split())
        self.calls.append((sql, dict(params or {})))
        if "product_profiles" in sql:
            return _Result(self._profile_rows)
        if "file_objects" in sql:
            return _Result(self._media_rows)
        return _Result([])

    def call_for(self, table: str) -> tuple[str, dict]:
        hits = [c for c in self.calls if table in c[0]]
        assert hits, f"没有对 {table} 的查询；实际调用：{[c[0][:60] for c in self.calls]}"
        return hits[-1]


def _profile_row(team_id, info=None):
    """一行产品基础信息（含 `team_id` —— 读路径必须把它选出来才能判定）。"""
    return {
        "product_key": "field_fence",
        "info": info if info is not None else {"note": f"team-{team_id}"},
        "updated_at": datetime(2026, 10, 12, tzinfo=timezone.utc),
        "team_id": team_id,
    }


@pytest.fixture
async def env():
    """返回 `(client, use)`：`use(role=…, team_id=…, profile_rows=…)` 设定本次身份与假库。

    身份通过**依赖覆盖**注入（见模块 docstring 的坑 2），因此同一个 client 上可以
    连续切换身份而不必重建 client —— 也不会出现"错位一拍"。
    """
    from app.db.session import get_db_session

    state: dict = {"auth": None, "db": _FakeDB()}

    async def _override_db():
        yield state["db"]

    def _override_auth():
        return state["auth"]

    app.dependency_overrides[get_db_session] = _override_db
    app.dependency_overrides[get_auth_context] = _override_auth
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    def use(*, role=MEMBER, team_id=TEAM_A, profile_rows=(), media_rows=()):
        state["auth"] = AuthContext(
            user_id=1, account_type="internal", role=role, tenant_id=TENANT, team_id=team_id)
        state["db"] = _FakeDB(profile_rows=profile_rows, media_rows=media_rows)
        return state["db"]

    try:
        yield client, use
    finally:
        await client.aclose()
        app.dependency_overrides.pop(get_db_session, None)
        app.dependency_overrides.pop(get_auth_context, None)


# ── 1. 本团队行 ⇒ 可读 ─────────────────────────────────────────────────────

class TestSameTeamCanRead:
    @pytest.mark.asyncio
    async def test_本团队读自己的基础信息_200(self, env):
        client, use = env
        use(role=MEMBER, team_id=TEAM_A, profile_rows=[_profile_row(TEAM_A, {"note": "A 家的"})])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 200, resp.text
        assert resp.json()["info"] == {"note": "A 家的"}

    @pytest.mark.asyncio
    async def test_没有这一行时仍是200空info_保持原语义(self, env):
        """行不存在 ≠ 不可见：没有任何行可保护 ⇒ 维持既有 200 `{}` 语义（零回归）。"""
        client, use = env
        use(role=MEMBER, team_id=TEAM_A, profile_rows=[])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 200
        assert resp.json() == {"product_key": "field_fence", "info": {}, "updated_at": None}


# ── 2. 别团队行 ⇒ 404（核心：这条就是本次要修的漏洞）────────────────────────

class TestOtherTeamGets404:
    @pytest.mark.asyncio
    async def test_别团队读不到_404(self, env):
        client, use = env
        use(role=MEMBER, team_id=TEAM_A,
            profile_rows=[_profile_row(TEAM_B, {"note": "B 家的机密"})])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "PROFILE_NOT_FOUND"
        assert "B 家的机密" not in resp.text          # 一个字节都不许漏

    @pytest.mark.asyncio
    async def test_别团队与历史NULL对外不可区分_同一个错误码(self, env):
        """两种拒绝原因**同一个 404 码** ⇒ 不额外泄露"别家有没有存过这一行"。"""
        client, use = env
        use(role=MEMBER, team_id=TEAM_A, profile_rows=[_profile_row(TEAM_B)])
        r1 = await client.get(PROFILE_URL)
        use(role=MEMBER, team_id=TEAM_A, profile_rows=[_profile_row(None)])
        r2 = await client.get(PROFILE_URL)
        assert r1.status_code == r2.status_code == 404
        assert r1.json() == r2.json()

    @pytest.mark.asyncio
    async def test_换一个团队身份就能读到自己的行(self, env):
        """阳性对照：同样的行（team=B），B 团队自己读得到 ⇒ 上面的 404 不是"路径写错"。"""
        client, use = env
        use(role=MEMBER, team_id=TEAM_B, profile_rows=[_profile_row(TEAM_B, {"note": "B 家的"})])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 200, resp.text
        assert resp.json()["info"] == {"note": "B 家的"}


# ── 3. 历史 team_id IS NULL ⇒ 仅管理员（D3/D4）──────────────────────────────

class TestLegacyNullIsAdminOnly:
    @pytest.mark.asyncio
    async def test_普通成员读不到历史NULL行_404(self, env):
        client, use = env
        use(role=MEMBER, team_id=TEAM_A,
            profile_rows=[_profile_row(None, {"note": "历史遗留"})])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 404, resp.text
        assert "历史遗留" not in resp.text

    @pytest.mark.asyncio
    async def test_管理员能读历史NULL行_200(self, env):
        client, use = env
        use(role=ADMIN, team_id=None, profile_rows=[_profile_row(None, {"note": "历史遗留"})])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 200, resp.text
        assert resp.json()["info"] == {"note": "历史遗留"}

    @pytest.mark.asyncio
    async def test_管理员也能读别团队行_200(self, env):
        client, use = env
        use(role=ADMIN, team_id=None, profile_rows=[_profile_row(TEAM_B, {"note": "B 家的"})])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 200, resp.text


# ── 4. 访问者没有团队 ⇒ 403 NO_TEAM（§1.5 的顺序）──────────────────────────

class TestNoTeamGets403:
    @pytest.mark.asyncio
    async def test_无团队的普通账号_403_NO_TEAM(self, env):
        client, use = env
        use(role=MEMBER, team_id=None, profile_rows=[_profile_row(TEAM_A)])
        resp = await client.get(PROFILE_URL)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"]["code"] == "NO_TEAM"


# ── 5. 列表接口不泄露 + **定义仍人人可读**（Q6 两层不许压平）───────────────

def _where_clause(sql: str) -> str:
    return sql.split("WHERE", 1)[1] if "WHERE" in sql else ""


class TestListDoesNotLeakButDefinitionsStayPublic:
    @pytest.mark.asyncio
    async def test_列表的SQL带上了团队谓词(self, env):
        client, use = env
        fake = use(role=MEMBER, team_id=TEAM_A)
        await client.get(LIST_URL)
        sql, params = fake.call_for("product_profiles")
        assert re.search(r"\bteam_id\s*=\s*:team\b", sql), sql
        assert params["team"] == TEAM_A

    @pytest.mark.asyncio
    async def test_管理员不加团队谓词_以便看到历史NULL行(self, env):
        client, use = env
        fake = use(role=ADMIN, team_id=None)
        await client.get(LIST_URL)
        sql, params = fake.call_for("product_profiles")
        # ⚠️ 必须用词边界：`tenant_id` 里**含** `team_id` 子串，直接 `in` 会假阳性
        assert not re.search(r"\bteam_id\b", _where_clause(sql)), sql
        assert "team" not in params

    @pytest.mark.asyncio
    async def test_无团队账号_谓词为NULL_读不到任何团队私有行(self, env):
        client, use = env
        fake = use(role=MEMBER, team_id=None)
        await client.get(LIST_URL)
        sql, params = fake.call_for("product_profiles")
        assert re.search(r"\bteam_id\s*=\s*:team\b", sql), sql
        assert params["team"] is None                       # `= NULL` 恒不成立 ⇒ 零私有行

    @pytest.mark.asyncio
    async def test_列表里别团队的profile不会出现(self, env):
        """假库只回"可见的那些行"（真库由 SQL 谓词决定）⇒ 载荷里不该有别家内容。"""
        client, use = env
        use(role=MEMBER, team_id=TEAM_A,
            profile_rows=[{"product_key": "field_fence", "info": {"note": "A 家的"}}])
        resp = await client.get(LIST_URL)
        assert resp.status_code == 200
        item = [i for i in resp.json()["items"] if i["product_key"] == "field_fence"][0]
        assert item["profile"] == {"note": "A 家的"}
        assert "B 家的机密" not in resp.text

    @pytest.mark.asyncio
    async def test_两层不许压平_无团队账号仍能看到产品定义(self, env):
        """**Q6 的核心**：工位/定义人人可见 ⇒ 没有团队也不能把整个列表 403 掉，
        只是"用户创建的基础信息"为空。"""
        client, use = env
        use(role=MEMBER, team_id=None, profile_rows=[])
        resp = await client.get(LIST_URL)
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        assert len(items) > 0, "产品定义必须照旧返回"
        assert all(i["profile"] == {} for i in items), "私有一律为空"
        assert items[0]["name"] and "category_code" in items[0]

    @pytest.mark.asyncio
    async def test_列表的media_count也按团队过滤了(self, env):
        """`media_count` 取自 `file_objects`（同属"用户创建的产品相关信息"）。

        task-23 时它还是全租户计数，当时这条**反向钉住"还没有谓词"**；
        task-24 已把谓词补上 ⇒ 现在改为**钉住已有谓词**（含参数等于本人团队）。
        """
        client, use = env
        fake = use(role=MEMBER, team_id=TEAM_A)
        await client.get(LIST_URL)
        media_sql, media_params = fake.call_for("file_objects")
        assert re.search(r"\bteam_id\s*=\s*:team\b", media_sql), media_sql
        assert media_params["team"] == TEAM_A

    @pytest.mark.asyncio
    async def test_管理员看图片计数不加谓词(self, env):
        client, use = env
        fake = use(role=ADMIN, team_id=None)
        await client.get(LIST_URL)
        media_sql, media_params = fake.call_for("file_objects")
        assert not re.search(r"\bteam_id\b", _where_clause(media_sql)), media_sql
        assert "team" not in media_params
