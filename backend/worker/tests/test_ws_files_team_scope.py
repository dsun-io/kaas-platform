"""worker `ws_files.py` 的团队谓词（P8 同构 · task-24）。

与 orchestrator 侧**同一口径**（同一个判定来源 `kaas_common.workstation.product_scope`、
同一个角色尺 `is_admin_role`）：

| 情形 | 期望 | 依据 |
|---|---|---|
| 本团队行 | 可见 / 可改 | Q6 |
| 别团队行 | **404** | Q6 + §1.5 |
| 历史 `team_id IS NULL` | **仅管理员**（非管理员 404） | D3/D4 |
| 无团队 | **403 `NO_TEAM`** | §1.5 次序 |

两类用例：**行为**（直调端点函数 + 假库，含**阳性对照**）与**静态审计**
（扫 `ws_files.py` 的每一处 `file_objects` 落点）。
"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()

import ws_files  # noqa: E402

# 注意：worker 侧**不**写 `pytestmark = pytest.mark.unit` —— 该环境没注册 `unit` 标记
# （写了会报 PytestUnknownMarkWarning），且 worker 的门禁是普通 `pytest`（全跑，不做 -m 筛选）
# ⇒「按 worker 的既有写法」= 不带标记。

TENANT = 11
OTHER_TEAM = 22
ADMIN = "system_admin"
MEMBER = "user"

WS_FILES_PY = Path(__file__).resolve().parents[1] / "src" / "ws_files.py"


# ── 假库 ────────────────────────────────────────────────────────────────────

class _FakeDB:
    def __init__(self, row=None):
        self.row = row
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, request, sql, *params, table=None):
        self.calls.append((" ".join(str(sql).split()), params))
        return self.row

    async def fetch(self, request, sql, *params, table=None):
        self.calls.append((" ".join(str(sql).split()), params))
        return [self.row] if self.row is not None else []

    async def execute(self, request, sql, *params):
        self.calls.append((" ".join(str(sql).split()), params))
        return "UPDATE 1" if self.row is not None else "UPDATE 0"

    @property
    def last_sql(self) -> str:
        return self.calls[-1][0]

    @property
    def last_params(self) -> tuple:
        return self.calls[-1][1]


def _user(role=MEMBER, team_id=TENANT):
    return {"id": 1, "role": role, "team_id": team_id}


def _profile_row(team_id, info=None):
    return {"product_key": "field_fence", "info": info or {"note": "x"},
            "updated_at": None, "team_id": team_id}


def _install(monkeypatch, row):
    fake = _FakeDB(row)
    monkeypatch.setattr(ws_files, "db", fake)
    return fake


def _get_profile(row, user):
    return asyncio.run(ws_files.get_profile("field_fence", object(), user))


# ── 1. 单条基础信息：四条语义 + 阳性对照 ────────────────────────────────────

class TestGetProfileTeamScope:
    def test_本团队可读(self, monkeypatch):
        _install(monkeypatch, _profile_row(TENANT, {"note": "本团队"}))
        out = _get_profile(None, _user())
        assert out["info"] == {"note": "本团队"}

    def test_别团队_404_且不漏内容(self, monkeypatch):
        _install(monkeypatch, _profile_row(OTHER_TEAM, {"note": "别家机密"}))
        with pytest.raises(HTTPException) as ei:
            _get_profile(None, _user())
        assert ei.value.status_code == 404
        assert ei.value.detail["code"] == "PROFILE_NOT_FOUND"
        assert "别家机密" not in str(ei.value.detail)

    def test_阳性对照_同一行换成自己团队就可读(self, monkeypatch):
        """同一行（team=OTHER），换成 OTHER 团队的身份 ⇒ 不再是 404 ⇒ 证明上面不是路径错。"""
        _install(monkeypatch, _profile_row(OTHER_TEAM, {"note": "别家的"}))
        out = _get_profile(None, _user(team_id=OTHER_TEAM))
        assert out["info"] == {"note": "别家的"}

    def test_历史NULL行_普通成员404_管理员200(self, monkeypatch):
        _install(monkeypatch, _profile_row(None, {"note": "历史遗留"}))
        with pytest.raises(HTTPException) as ei:
            _get_profile(None, _user())
        assert ei.value.status_code == 404
        # 管理员
        out = _get_profile(None, _user(role=ADMIN, team_id=None))
        assert out["info"] == {"note": "历史遗留"}

    def test_无团队_403_NO_TEAM(self, monkeypatch):
        _install(monkeypatch, _profile_row(TENANT))
        with pytest.raises(HTTPException) as ei:
            _get_profile(None, _user(team_id=None))
        assert ei.value.status_code == 403
        assert ei.value.detail["code"] == "NO_TEAM"

    def test_行不存在_仍是200空info(self, monkeypatch):
        _install(monkeypatch, None)
        out = _get_profile(None, _user())
        assert out["info"] == {}


# ── 2. 行级端点：写/读都带谓词（别团队 ⇒ 谓词不命中 ⇒ 404）──────────────────

class TestRowEndpointsCarryPredicate:
    def test_读本体带团队谓词(self, monkeypatch):
        fake = _install(monkeypatch, None)
        with pytest.raises(HTTPException) as ei:
            asyncio.run(ws_files.get_file_content(7, object(), _user()))
        assert ei.value.status_code == 404
        assert re.search(r"\bteam_id=\$\d+", fake.last_sql), fake.last_sql
        assert TENANT in fake.last_params

    def test_下线带团队谓词(self, monkeypatch):
        fake = _install(monkeypatch, None)      # UPDATE 0 行 ⇒ 404
        with pytest.raises(HTTPException) as ei:
            asyncio.run(ws_files.retire_file(7, object(), _user()))
        assert ei.value.status_code == 404
        assert re.search(r"\bteam_id=\$\d+", fake.last_sql), fake.last_sql

    def test_管理员不加谓词(self, monkeypatch):
        fake = _install(monkeypatch, None)
        with pytest.raises(HTTPException):
            asyncio.run(ws_files.retire_file(7, object(), _user(role=ADMIN, team_id=None)))
        assert "team_id" not in fake.last_sql, fake.last_sql

    def test_无团队_403(self, monkeypatch):
        _install(monkeypatch, None)
        with pytest.raises(HTTPException) as ei:
            asyncio.run(ws_files.retire_file(7, object(), _user(team_id=None)))
        assert ei.value.status_code == 403
        assert ei.value.detail["code"] == "NO_TEAM"


# ── 3. 静态审计：每一处 file_objects 落点都带谓词（写入则必须带 team_id）──────

#: 允许**不带**谓词的落点（键 = SQL 片段；值 = 为什么安全）。加进去必须写理由。
_ALLOWED_WITHOUT_PREDICATE: dict[str, str] = {
    "SET is_current=false, updated_at=now() WHERE id=$1":
        "supersede：id 来自上面已按团队过滤的 `_current_file`（拿不到别团队的 id）",
    "SELECT name, content_type, file_name, content, object_key, storage FROM file_objects":
        "`resolve_photo_refs` 是装配层函数、没有 auth 上下文，调用方在 main.py（本轮不授权）"
        " ⇒ 已知缺口，源码里已留注释，等 main.py 干净后再补",
}


def _sql_sites(src: str):
    lines = src.splitlines()
    out = []
    for i, line in enumerate(lines):
        if re.search(r"\b(FROM|INTO|UPDATE)\s+file_objects", line, re.I):
            out.append((i + 1, "\n".join(lines[i:i + 14])))
    return out


class TestStaticAudit:
    def test_每处落点都带谓词或写入带team_id(self):
        src = WS_FILES_PY.read_text(encoding="utf-8")
        sites = _sql_sites(src)
        assert len(sites) >= 10, f"只扫到 {len(sites)} 处，审计可能没跑在预期对象上"
        offenders = []
        for lineno, window in sites:
            first = window.splitlines()[0]
            if re.search(r"\bINSERT\s+INTO\s+file_objects", first, re.I):
                if not re.search(r"\(tenant_id,\s*team_id", window):
                    offenders.append(f"L{lineno}: INSERT 没写 team_id —— {first.strip()}")
                continue
            if re.search(r"team_scope|_frag", window):
                continue
            if any(key in window for key in _ALLOWED_WITHOUT_PREDICATE):
                continue
            offenders.append(f"L{lineno}: {first.strip()}")
        assert not offenders, "以下 worker 落点没有团队谓词：\n" + "\n".join(offenders)

    def test_允许清单每条都写了理由(self):
        for key, why in _ALLOWED_WITHOUT_PREDICATE.items():
            assert why.strip(), key

    def test_审计能抓到漏谓词(self):
        fake_src = (
            "async def x(db):\n"
            "    return await db.fetchrow(request,\n"
            "        'SELECT a FROM file_objects WHERE tenant_id=$1', 1)\n"
        )
        _lineno, window = _sql_sites(fake_src)[0]
        assert not re.search(r"team_scope|_frag", window)

    def test_已知缺口已关闭_单证渲染装配层(self):
        """`resolve_photo_refs` 现在有团队谓词（task-6 已关闭该缺口）。

        原注释："没法**加团队谓词：`resolve_photo_refs(request, data)` 是**装配层**函数，
        调用方是 `main.get_trade_doc_render_data`（main.py 正在被另一条任务改 ⇒ 本次不授权）"
        —— 2026-10-12 task-6 已把 `user` 传进来，按 `file_objects.team_id` 过滤。
        """
        src = WS_FILES_PY.read_text(encoding="utf-8")
        idx = src.find("async def resolve_photo_refs")
        assert idx > 0
        body = src[idx:idx + 2000]
        assert "team_scope" in body or "_team_scope" in body, \
            "resolve_photo_refs 现在必须带团队谓词（缺口已关闭）"
