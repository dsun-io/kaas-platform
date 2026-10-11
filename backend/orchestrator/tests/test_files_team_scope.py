"""`files.py` 的**文件对象**团队谓词（P7 剩余 · task-24）。

口径与 task-23 一致（同一把尺 `product_scope` / 同一个 `is_admin_role`）：

| 情形 | 期望 | 依据 |
|---|---|---|
| 本团队行 | 200 / 改得动 | Q6 |
| 别团队行 | **404**（与"不存在"同一个码，不泄露存在性） | Q6 + §1.5 |
| 历史 `team_id IS NULL` | **仅管理员**（非管理员 404） | D3/D4 |
| 无团队的普通账号 | **403 `NO_TEAM`** | §1.5 次序 |
| 成员写路径 | SQL 必须带 `team_id` 谓词 | Q6 |

两类用例：
1. **行为**（HTTP 层，假库**按谓词过滤**）—— 含**阳性对照**（换本团队身份 ⇒ 200），
   以免"404"其实只是"路径写错"；
2. **静态审计** —— 把 `files.py` 里每一处 `file_objects` SQL 读/写点扫一遍，
   要求它带上团队谓词（或落在**显式允许清单**里并写明理由）。这条替代"逐条手点"，
   且以后有人新增落点忘记加谓词时会**直接红**。

⚠️ 不需要 Postgres：假库**模拟** `WHERE team_id=...` 的过滤效果。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.auth import AuthContext, get_auth_context
from app.main import app

pytestmark = pytest.mark.unit

TENANT = "default"
TEAM_A = 11
TEAM_B = 22
ADMIN = "system_admin"
MEMBER = "user"

FILES_PY = Path(__file__).resolve().parents[1] / "app" / "api" / "files.py"


# ── 假库：**按团队谓词过滤**（这样 404 才是真的被过滤掉，而不是路径错）─────────

class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None

    @property
    def rowcount(self):
        return len(self._rows)


class _FilteringFakeDB:
    """`file_objects` 的一行，按 SQL 里的 `team_id=:team` 参数决定是否"存在"。"""

    def __init__(self, row):
        self._row = row
        self.calls: list[tuple[str, dict]] = []

    def _visible(self, params: dict) -> bool:
        team = params.get("team", "__absent__")
        if team == "__absent__":
            return True                      # 管理员：不加谓词 ⇒ 全可见
        return team is not None and self._row["team_id"] == team

    async def execute(self, stmt, params=None):
        sql = " ".join(str(stmt).split())
        params = dict(params or {})
        self.calls.append((sql, params))
        if sql.upper().startswith("SELECT"):
            return _Result([self._row] if self._visible(params) else [])
        # UPDATE/DELETE：不可见 ⇒ 影响 0 行（调用方据此 404）
        return _Result([self._row] if self._visible(params) else [])

    @property
    def last(self) -> tuple[str, dict]:
        return self.calls[-1]


@pytest.fixture
async def env():
    from app.db.session import get_db_session

    state: dict = {"auth": None, "db": None}

    async def _override_db():
        yield state["db"]

    app.dependency_overrides[get_db_session] = _override_db
    app.dependency_overrides[get_auth_context] = lambda: state["auth"]
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    def use(*, role=MEMBER, team_id=TEAM_A, row_team_id=TEAM_A):
        state["auth"] = AuthContext(user_id=1, account_type="internal", role=role,
                                    tenant_id=TENANT, team_id=team_id)
        state["db"] = _FilteringFakeDB({
            "id": 7, "tenant_id": TENANT, "team_id": row_team_id, "owner_type": "product",
            "owner_id": "field_fence", "kind": "product_photo", "is_current": True,
            "content_type": "image/png", "file_name": "p.png", "content": None,
            "object_key": "media/7.png", "storage": "s3", "name": "产品图",
        })
        return state["db"]

    try:
        yield client, use
    finally:
        await client.aclose()
        app.dependency_overrides.pop(get_db_session, None)
        app.dependency_overrides.pop(get_auth_context, None)


# ── 1. 行级端点：本团队 200/204，别团队 404（含阳性对照）────────────────────

CONTENT = "/api/v1/file-objects/7/content"
RETIRE = "/api/v1/file-objects/7"


class TestRowEndpoints:
    @pytest.mark.asyncio
    async def test_本团队读本体_200或404取字节(self, env):
        """本团队 ⇒ 行**可见**（谓词匹配）。字节可由 inline/S3 决定，
        所以这里只断言"没有被判成不可见"——即不是 FILE_NOT_FOUND。"""
        client, use = env
        use(team_id=TEAM_A, row_team_id=TEAM_A)
        resp = await client.get(CONTENT)
        detail = resp.json().get("detail") if resp.status_code != 200 else None
        assert resp.status_code in (200, 404), resp.text
        if detail:
            assert detail["code"] == "FILE_BODY_NOT_FOUND", detail   # 不是"看不见"，是"没字节"

    @pytest.mark.asyncio
    async def test_别团队读本体_404(self, env):
        client, use = env
        use(team_id=TEAM_A, row_team_id=TEAM_B)
        resp = await client.get(CONTENT)
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "FILE_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_阳性对照_同一行换成本团队就可见(self, env):
        """同样一行（team=B），B 团队自己读 ⇒ 不再是 404 ⇒ 证明上面的 404 是被谓词挡的。"""
        client, use = env
        use(team_id=TEAM_B, row_team_id=TEAM_B)
        resp = await client.get(CONTENT)
        detail = resp.json().get("detail") if resp.status_code != 200 else None
        assert not (detail and detail["code"] == "FILE_NOT_FOUND"), resp.text

    @pytest.mark.asyncio
    async def test_别团队下线_404(self, env):
        client, use = env
        use(team_id=TEAM_A, row_team_id=TEAM_B)
        resp = await client.delete(RETIRE)
        assert resp.status_code == 404, resp.text

    @pytest.mark.asyncio
    async def test_本团队下线_204(self, env):
        client, use = env
        use(team_id=TEAM_A, row_team_id=TEAM_A)
        resp = await client.delete(RETIRE)
        assert resp.status_code == 204, resp.text

    @pytest.mark.asyncio
    async def test_别团队改名_404(self, env):
        client, use = env
        use(team_id=TEAM_A, row_team_id=TEAM_B)
        resp = await client.patch(RETIRE, json={"name": "改个名"})
        assert resp.status_code == 404, resp.text

    @pytest.mark.asyncio
    async def test_本团队改名_200(self, env):
        client, use = env
        db = use(team_id=TEAM_A, row_team_id=TEAM_A)
        resp = await client.patch(RETIRE, json={"name": "新名字"})
        assert resp.status_code == 200, resp.text
        # 写路径也必须带谓词（不只读路径）
        update_sql = [s for s, _ in db.calls if s.upper().startswith("UPDATE")]
        assert update_sql, db.calls
        assert all(re.search(r"\bteam_id\s*=\s*:team\b", s) for s in update_sql), update_sql

    @pytest.mark.asyncio
    async def test_历史NULL行_普通成员404_管理员200(self, env):
        client, use = env
        use(role=MEMBER, team_id=TEAM_A, row_team_id=None)
        assert (await client.get(CONTENT)).status_code == 404
        client2, use2 = env
        use2(role=ADMIN, team_id=None, row_team_id=None)
        resp = await client2.get(CONTENT)
        detail = resp.json().get("detail") if resp.status_code != 200 else None
        assert not (detail and detail["code"] == "FILE_NOT_FOUND"), resp.text

    @pytest.mark.asyncio
    async def test_无团队_403_NO_TEAM(self, env):
        client, use = env
        use(role=MEMBER, team_id=None, row_team_id=TEAM_A)
        resp = await client.get(CONTENT)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"]["code"] == "NO_TEAM"

    @pytest.mark.asyncio
    async def test_列表带团队谓词_且管理员不带(self, env):
        client, use = env
        db = use(role=MEMBER, team_id=TEAM_A)
        await client.get("/api/v1/file-objects?owner_type=product&owner_id=field_fence")
        sql, params = db.last
        assert re.search(r"\bteam_id\s*=\s*:team\b", sql), sql
        assert params["team"] == TEAM_A

        client2, use2 = env
        db2 = use2(role=ADMIN, team_id=None)
        await client2.get("/api/v1/file-objects?owner_type=product&owner_id=field_fence")
        sql2, params2 = db2.last
        assert not re.search(r"\bteam_id\b", sql2.split("WHERE", 1)[1]), sql2
        assert "team" not in params2


# ── 2. 静态审计：每一处 file_objects SQL 都要带谓词（除显式允许项）────────────

#: 允许**不带**谓词的落点（键 = SQL 片段；值 = 理由）。加进去必须写理由。
_ALLOWED_WITHOUT_PREDICATE: dict[str, str] = {}


def _sql_sites(src: str) -> list[tuple[int, str]]:
    """找出每一处 `... FROM/INTO/UPDATE file_objects`，连同**前后 14 行**一起返回。

    为什么按"行窗口"扫而不是只看字符串常量：本文件的团队谓词是**拼在调用处**的
    （`text("… WHERE x=:v" f"{team_sql}")`，或先 `sql += _frag` 再 `text(sql)`），
    所以常量本身**看不到**谓词 —— 只看 Constant 会**全部假阳性**（第一版就是这么红的）。
    窗口扫描等价于"人肉复核时会看的那几行"。
    """
    lines = src.splitlines()
    out = []
    for i, line in enumerate(lines):
        if re.search(r"\b(FROM|INTO|UPDATE)\s+file_objects", line, re.I):
            out.append((i + 1, "\n".join(lines[i:i + 14])))
    return out


class TestStaticAudit:
    def test_每处file_objects读写都带团队谓词或落在允许清单(self):
        src = FILES_PY.read_text(encoding="utf-8")
        sites = _sql_sites(src)
        assert len(sites) >= 10, f"只扫到 {len(sites)} 处，审计可能没跑在预期对象上"
        offenders = []
        for lineno, window in sites:
            first = window.splitlines()[0]
            if re.search(r"\bINSERT\s+INTO\s+file_objects", first, re.I):
                # 写入的规则不是"带谓词"，而是 **必须把 team 写进去**
                # （Q1=B：新写入强制带 team；否则都落进 team_key=0 桶）
                if not re.search(r"\(tenant_id,\s*team_id", window):
                    offenders.append(f"L{lineno}: INSERT 没写 team_id —— {first.strip()}")
                continue
            if re.search(r"team_sql|_frag|team_id\s*=\s*:team|_team_scope", window):
                continue
            if any(key in window for key in _ALLOWED_WITHOUT_PREDICATE):
                continue
            offenders.append(f"L{lineno}: {first.strip()}")
        assert not offenders, "以下 file_objects 落点没有团队谓词：\n" + "\n".join(offenders)

    def test_允许清单每条都有理由(self):
        for key, why in _ALLOWED_WITHOUT_PREDICATE.items():
            assert why.strip(), key

    def test_审计本身有效_漏谓词的窗口会被抓到(self):
        """阳性对照（针对审计逻辑）：确认它不是"永远返回空 offenders"。"""
        fake_src = (
            "async def x(db):\n"
            "    return await db.execute(text(\n"
            "        'SELECT a FROM file_objects WHERE tenant_id=:t'), {'t': 1})\n"
        )
        sites = _sql_sites(fake_src)
        assert len(sites) == 1
        _lineno, window = sites[0]
        assert not re.search(r"team_sql|_frag|team_id\s*=\s*:team|_team_scope", window)

    def test_审计对写入的规则是必须带team_id(self):
        fake_src = (
            "async def x(db):\n"
            "    return await db.execute(text(\n"
            "        'INSERT INTO file_objects (tenant_id, owner_type) VALUES (:t,:ot)'), {})\n"
        )
        _lineno, window = _sql_sites(fake_src)[0]
        assert not re.search(r"\(tenant_id,\s*team_id", window)
