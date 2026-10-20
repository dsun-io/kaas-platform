"""A5-W1 条款模板库 API 测试（worker 真实 HTTP 层 + 按 SQL 路由的假 db）。

复用 `_bootstrap.load_main()` 起手式（无 DB、无网络）：把 `main.db` 换成内存假实现，
再用 `TestClient` 打真实 HTTP —— 校验路由注册、pydantic 入参、权限顺序、状态码与响应形状。

覆盖（对应任务书 5）：
1. **懒种子**：首次 GET 某团队 0 条 ⇒ 6 条默认模板；再 GET 幂等（不重复种）；
   软删后不重新种（用户删空 = 有意为之）；
2. **响应契约**：`{items: [{id,name,doc_types,text_zh,text_en,sort_order,is_active}], total}`
   —— 前端设置页按这 7 个字段写，字段名/形状不能漂；
3. **权限**：成员 GET 200、写 403 `NOT_TEAM_ADMIN`；团队管理员写 200；无团队 403 `NO_TEAM`；
4. **校验**：非法 doc_type 422 `INVALID_DOC_TYPE`；空名称/双空正文/空 doc_types 422；
5. **软删**：DELETE 后列表不返回，重复 DELETE 404，PATCH 已删/不存在 404；
6. **筛选**：`?doc_type=` 只回适用的；非法枚举 422（不静默空列表）；
7. **唯一名**：同团队同名 409 `CLAUSE_NAME_TAKEN`。
"""
from __future__ import annotations

import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

# 团队成员 / 团队创建者 / 无团队账号
TEAM_ADMIN = {"id": 10, "team_id": 1, "role": "member", "account_type": "internal"}
MEMBER = {"id": 11, "team_id": 1, "role": "member", "account_type": "internal"}
NO_TEAM = {"id": 12, "team_id": None, "role": "member", "account_type": "internal"}
OTHER_TEAM = {"id": 13, "team_id": 2, "role": "member", "account_type": "internal"}

TEAMS = {1: {"id": 1, "created_by": 10, "name": "Team A"},
         2: {"id": 2, "created_by": 13, "name": "Team B"}}


class _FakeDb:
    """按 SQL 特征路由到内存表（条款模板 + teams）。"""

    def __init__(self) -> None:
        self.clauses: list[dict] = []
        self.teams: dict[int, dict] = dict(TEAMS)
        self.calls: list[tuple[str, tuple]] = []
        self._seq = 100

    # ── 工具 ──
    def _next_id(self) -> int:
        self._seq += 1
        return self._seq

    def _team_rows(self, team_id: int) -> list[dict]:
        return [dict(row) for row in self.clauses if row["team_id"] == int(team_id)]

    # ── 读 ──
    async def fetch(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        if "SELECT count(*) FROM tenant_clause_templates" in sql:
            return None
        if "FROM tenant_clause_templates" in sql:
            rows = self._team_rows(args[1])
            rows = [row for row in rows if row["is_active"]]
            if "$3 = ANY(doc_types)" in sql:
                wanted = str(args[2])
                rows = [row for row in rows if wanted in row["doc_types"]]
            rows.sort(key=lambda row: (row["sort_order"], row["id"]))
            return rows
        if "FROM teams" in sql:
            team = self.teams.get(int(args[0]))
            return [dict(team)] if team else []
        return []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        if "FROM teams" in sql:
            team = self.teams.get(int(args[0]))
            return dict(team) if team else None
        if "FROM tenant_clause_templates" in sql and "id=$3" in sql:
            for row in self.clauses:
                if (row["tenant_id"] == args[0] and row["team_id"] == int(args[1])
                        and row["id"] == int(args[2]) and row["is_active"]):
                    return dict(row)
            return None
        if "UPDATE tenant_clause_templates SET is_active=false" in sql:
            for row in self.clauses:
                if (row["id"] == int(args[2]) and row["team_id"] == int(args[1])
                        and row["is_active"]):
                    row["is_active"] = False
                    return {"id": row["id"]}
            return None
        if "UPDATE tenant_clause_templates SET" in sql:
            return self._update(args)
        if "INSERT INTO tenant_clause_templates" in sql:
            return self._insert(args)
        return None

    async def fetchval(self, request, sql, *args):
        self.calls.append((sql, args))
        if "SELECT count(*) FROM tenant_clause_templates" in sql:
            return len(self._team_rows(args[1]))
        return None

    # ── 写 ──
    async def execute(self, request, sql, *args):
        self.calls.append((sql, args))
        if "INSERT INTO tenant_clause_templates" in sql:
            self._insert(args, conflict_safe=True)
        return "OK"

    def _insert(self, args, conflict_safe: bool = False) -> dict | None:
        tenant_id, team_id, name, doc_types = args[0], int(args[1]), args[2], args[3]
        if any(row["team_id"] == team_id and row["name"] == name
               for row in self.clauses):
            if conflict_safe:
                return None
            raise RuntimeError(
                'duplicate key value violates unique constraint '
                '"uq_tenant_clause_templates_name"'
            )
        row = {
            "id": self._next_id(), "tenant_id": tenant_id, "team_id": team_id,
            "name": name, "doc_types": list(doc_types),
            "text_zh": args[4], "text_en": args[5], "sort_order": int(args[6]),
            "is_active": True,
        }
        self.clauses.append(row)
        return dict(row)

    def _update(self, args) -> dict | None:
        tenant_id, team_id, template_id = args[0], int(args[1]), int(args[2])
        for row in self.clauses:
            if row["id"] != template_id or row["team_id"] != team_id or not row["is_active"]:
                continue
            new_name = args[3]
            if new_name != row["name"] and any(
                other is not row and other["team_id"] == team_id
                and other["name"] == new_name for other in self.clauses
            ):
                raise RuntimeError(
                    'duplicate key value violates unique constraint '
                    '"uq_tenant_clause_templates_name"'
                )
            row.update({
                "name": new_name, "doc_types": list(args[4]),
                "text_zh": args[5], "text_en": args[6], "sort_order": int(args[7]),
            })
            return dict(row)
        return None


@contextmanager
def _patched(fake: _FakeDb, user: dict = TEAM_ADMIN):
    old_db = worker_main.db
    worker_main.db = fake
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield fake
    finally:
        worker_main.db = old_db
        worker_main.app.dependency_overrides.clear()


CONTRACT_FIELDS = {
    "id", "name", "doc_types", "text_zh", "text_en", "sort_order", "is_active",
}


def _create(fake: _FakeDb, **over):
    """直接往假库塞一条，跳过 HTTP（用于准备 GET 场景）。"""
    row = {
        "id": fake._next_id(), "tenant_id": "default", "team_id": 1,
        "name": "自定义条款", "doc_types": ["pi", "ci"],
        "text_zh": "中文", "text_en": "English", "sort_order": 5,
        "is_active": True,
    }
    row.update(over)
    fake.clauses.append(row)
    return row


# ── 1) 懒种子 + 契约 ──────────────────────────────────────────────────────

def test_first_get_lazily_seeds_six_defaults_and_is_idempotent():
    fake = _FakeDb()
    with _patched(fake):
        first = client.get("/api/v1/clause-templates")
        second = client.get("/api/v1/clause-templates")

    assert first.status_code == 200, first.text
    body = first.json()
    assert body["total"] == 6
    assert len(body["items"]) == 6
    assert [item["sort_order"] for item in body["items"]] == [10, 20, 30, 40, 50, 60]
    for item in body["items"]:
        assert set(item) == CONTRACT_FIELDS      # 契约字段不多不少
        assert isinstance(item["id"], int)
        assert isinstance(item["doc_types"], list) and item["doc_types"]
        assert item["is_active"] is True
        assert item["text_zh"] or item["text_en"]
    # 幂等：第二次 GET 不再插入（仍 6 条）
    assert second.status_code == 200
    assert second.json()["total"] == 6
    assert len(fake.clauses) == 6


def test_seed_does_not_resurrect_after_user_deletes_everything(monkeypatch):
    fake = _FakeDb()
    with _patched(fake):
        client.get("/api/v1/clause-templates")            # 种 6 条
        for row in list(fake.clauses):
            client.delete(f"/api/v1/clause-templates/{row['id']}")
        # 全部软删后：列表空、**不重新种**
        resp = client.get("/api/v1/clause-templates")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0}
    assert len(fake.clauses) == 6                          # 行还在（软删）
    assert all(row["is_active"] is False for row in fake.clauses)


def test_get_filters_by_doc_type_and_rejects_unknown_type():
    fake = _FakeDb()
    with _patched(fake):
        client.get("/api/v1/clause-templates")             # 触发种子
        bl = client.get("/api/v1/clause-templates", params={"doc_type": "bl"})
        pi = client.get("/api/v1/clause-templates", params={"doc_type": "pi"})
        bad = client.get("/api/v1/clause-templates", params={"doc_type": "nope"})

    assert bl.status_code == 200 and bl.json()["total"] == 1      # 只有装运条款含 bl
    assert all("bl" in item["doc_types"] for item in bl.json()["items"])
    assert pi.status_code == 200 and pi.json()["total"] == 6      # 6 条都适用 pi
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "INVALID_DOC_TYPE"


# ── 2) 权限 ───────────────────────────────────────────────────────────────

def test_member_can_read_but_not_write():
    fake = _FakeDb()
    with _patched(fake, user=MEMBER):
        read = client.get("/api/v1/clause-templates")
        write = client.post("/api/v1/clause-templates", json={
            "name": "成员乱写", "doc_types": ["pi"], "text_en": "x",
        })
    assert read.status_code == 200
    assert write.status_code == 403
    assert write.json()["detail"]["code"] == "NOT_TEAM_ADMIN"


def test_no_team_is_403_no_team():
    fake = _FakeDb()
    with _patched(fake, user=NO_TEAM):
        resp = client.get("/api/v1/clause-templates")
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NO_TEAM"


def test_admin_can_create_patch_and_delete():
    fake = _FakeDb()
    with _patched(fake):
        client.get("/api/v1/clause-templates")
        created = client.post("/api/v1/clause-templates", json={
            "name": "信用证条款", "doc_types": ["pi", "ci"],
            "text_zh": "信用证结算。", "text_en": "Payment by L/C.",
            "sort_order": 15,
        })
        assert created.status_code == 201, created.text
        item = created.json()
        assert set(item) == CONTRACT_FIELDS
        assert item["name"] == "信用证条款"
        assert item["sort_order"] == 15

        patched = client.patch(f"/api/v1/clause-templates/{item['id']}", json={
            "name": "信用证条款（可转让）", "sort_order": 5,
        })
        assert patched.status_code == 200, patched.text
        assert patched.json()["name"] == "信用证条款（可转让）"
        assert patched.json()["sort_order"] == 5
        assert patched.json()["doc_types"] == ["pi", "ci"]     # 未传字段保持

        deleted = client.delete(f"/api/v1/clause-templates/{item['id']}")
        assert deleted.status_code == 200
        assert deleted.json() == {"id": item["id"], "is_active": False}

        again = client.delete(f"/api/v1/clause-templates/{item['id']}")
        assert again.status_code == 404
        listed = client.get("/api/v1/clause-templates").json()["items"]
        assert all(row["id"] != item["id"] for row in listed)


# ── 3) 校验 ───────────────────────────────────────────────────────────────

def test_create_validations_map_to_structured_422():
    fake = _FakeDb()
    with _patched(fake):
        bad_type = client.post("/api/v1/clause-templates", json={
            "name": "坏类型", "doc_types": ["pi", "nope"], "text_en": "x",
        })
        empty_types = client.post("/api/v1/clause-templates", json={
            "name": "空类型", "doc_types": [], "text_en": "x",
        })
        empty_name = client.post("/api/v1/clause-templates", json={
            "name": "   ", "doc_types": ["pi"], "text_en": "x",
        })
        empty_text = client.post("/api/v1/clause-templates", json={
            "name": "无正文", "doc_types": ["pi"], "text_zh": " ", "text_en": "",
        })

    assert bad_type.status_code == 422
    assert bad_type.json()["detail"]["code"] == "INVALID_DOC_TYPE"
    assert empty_types.status_code == 422
    assert empty_types.json()["detail"]["code"] == "CLAUSE_DOC_TYPES_REQUIRED"
    assert empty_name.status_code == 422
    assert empty_name.json()["detail"]["code"] == "CLAUSE_NAME_REQUIRED"
    assert empty_text.status_code == 422
    assert empty_text.json()["detail"]["code"] == "CLAUSE_TEXT_REQUIRED"


def test_patch_merges_then_validates_and_404s():
    fake = _FakeDb()
    created = _create(fake)
    with _patched(fake):
        # 把 text_zh 清空、text_en 仍在 ⇒ 合法（单语）
        ok = client.patch(f"/api/v1/clause-templates/{created['id']}",
                          json={"text_zh": None})
        # 再把 text_en 也清空 ⇒ 422（至少一侧非空）
        bad = client.patch(f"/api/v1/clause-templates/{created['id']}",
                           json={"text_en": "   "})
        missing = client.patch("/api/v1/clause-templates/999999",
                               json={"name": "不存在"})
    assert ok.status_code == 200 and ok.json()["text_zh"] is None
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "CLAUSE_TEXT_REQUIRED"
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "CLAUSE_TEMPLATE_NOT_FOUND"


def test_duplicate_name_same_team_is_409():
    fake = _FakeDb()
    _create(fake, name="重复条款")
    with _patched(fake):
        resp = client.post("/api/v1/clause-templates", json={
            "name": "重复条款", "doc_types": ["pi"], "text_en": "dup",
        })
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "CLAUSE_NAME_TAKEN"


def test_team_isolation_read_only_sees_own_team():
    fake = _FakeDb()
    _create(fake, team_id=1, name="A 团队条款")
    _create(fake, team_id=2, name="B 团队条款")
    with _patched(fake, user=OTHER_TEAM):
        resp = client.get("/api/v1/clause-templates")
    names = [item["name"] for item in resp.json()["items"]]
    assert names == ["B 团队条款"]


def test_patch_by_other_team_admin_cannot_touch_foreign_row():
    fake = _FakeDb()
    foreign = _create(fake, team_id=2, name="B 团队的条款")
    with _patched(fake, user=OTHER_TEAM):
        resp = client.patch(f"/api/v1/clause-templates/{foreign['id']}",
                            json={"name": "越权改名"})
    # B 团队管理员改 B 团队的行是允许的；这里验证"A 团队"改不到 B 的行
    assert resp.status_code == 200  # 同团队（OTHER_TEAM 属于团队 2）
    fake2 = _FakeDb()
    row = _create(fake2, team_id=2, name="B 团队的行")
    with _patched(fake2, user=TEAM_ADMIN):   # 团队 1 的管理员
        denied = client.patch(f"/api/v1/clause-templates/{row['id']}",
                              json={"name": "跨团队改名"})
    assert denied.status_code == 404
