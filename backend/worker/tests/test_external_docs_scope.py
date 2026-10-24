"""外部单证上传：租户/行级隔离（列表 + 下载）—— 安全修复 2026-10-24。

背景（Lead 核对源码后派单）
--------------------------
表 `external_doc_uploads`（orchestrator/app/db/external_docs.py）只有
tenant_id / uploaded_by / order_id / quote_order_id / inquiry_id / customer_id，
**没有 team_id**；修复前：
· 列表 `WHERE 1=1` —— 连 tenant_id 都不过滤；
· 下载 `SELECT * ... WHERE id=$1` —— 任何登录用户可按 id 下载**任意团队**的件。

本轮口径（不迁移 schema，保守代理谓词）
--------------------------------------
· 恒加 `tenant_id = $1`（DEFAULT_TENANT）；
· 管理员（is_admin_role）只受 tenant 约束；
· 非管理员：`uploaded_by = $uid::text` **或** 挂载对象属本团队 —— 三条挂载列各查
  orders / quote_orders / cust_inquiries 的 team_id（三表都有 team_id，写入时取
  创建者/客户团队：main.py:1866、quote_api.py:2157、orders 同源）；
· 无团队的非管理员：只剩 uploaded_by ⇒ 未挂载/非本人上传的件不可见（不抛 403：
  列表按谓词过滤、下载按 404 不泄露存在性）。

parity 锁
---------
与门面 `backend/ts-worker/tests/misc-read.test.ts` 使用**同一张构造数据矩阵 + 同一份
期望可见集合**（见 ROWS / EXPECTED），两侧各自断言自己发出的 SQL 与参数等于**同一份
canonical 形状** ⇒ 任一侧谓词漂移都会在自己那一侧失败。
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()

import ws_extras  # noqa: E402

TENANT = "default"
CREATED = datetime(2026, 10, 1, 3, 4, 5, tzinfo=timezone.utc)

# ── 构造数据矩阵（与门面测试逐行一致：改这里必须同步改 tests/misc-read.test.ts）──
ORDER_TEAM = {31: 4, 32: 8}
QUOTE_TEAM = {41: 4, 42: 8}
INQUIRY_TEAM = {51: 4, 52: 8}


def _row(doc_id, uploaded_by="12", tenant_id=TENANT, order_id=None,
         quote_order_id=None, inquiry_id=None):
    return {
        "id": doc_id, "tenant_id": tenant_id, "uploaded_by": uploaded_by,
        "order_id": order_id, "quote_order_id": quote_order_id, "inquiry_id": inquiry_id,
        "doc_type": "pi", "file_name": "doc-" + str(doc_id) + ".pdf",
        "content_type": "application/pdf", "file_size": 1024,
        "customer_id": "C-9", "status": "draft", "notes": None,
        "created_at": CREATED, "content": b"%PDF-1.4 " + str(doc_id).encode(),
    }


ROWS = [
    _row(1, uploaded_by="9"),                      # 本人上传（MEMBER）
    _row(2, order_id=32),                          # 挂别团队订单（team 8）
    _row(3, order_id=31),                          # 挂本团队订单（team 4）
    _row(4, quote_order_id=41),                    # 挂本团队报价
    _row(5, inquiry_id=51),                        # 挂本团队询盘
    _row(6),                                       # 未挂载 + 非本人上传
    _row(7, uploaded_by="9", tenant_id="other"),   # 别的租户（谁都不该看见）
]

ADMIN = {"id": 1, "role": "system_admin", "team_id": 4}
MEMBER = {"id": 9, "role": "user", "team_id": 4}
OTHER = {"id": 10, "role": "user", "team_id": 8}
NO_TEAM = {"id": 11, "role": "user", "team_id": None}

# 期望可见集合（同一份矩阵，门面测试断言完全相同的集合）
EXPECTED = {
    "admin": {1, 2, 3, 4, 5, 6},
    "member": {1, 3, 4, 5},
    "other": {2},
    "no_team": set(),
}


def _simulate(*, tenant, is_admin, uid=None, team=None, order_id=None, doc_type=None,
              rows=None):
    """把「本应写进 SQL 的谓词」用参照实现求值 —— **只用于行为断言**；
    真正的守卫是下方对 SQL 文本/参数的逐字断言（谓词必须在 SQL 里，不是在这里）。"""
    out = []
    for r in (rows if rows is not None else ROWS):
        if r["tenant_id"] != tenant:
            continue
        if order_id is not None and r["order_id"] != order_id:
            continue
        if doc_type and r["doc_type"] != doc_type:
            continue
        if not is_admin:
            own = str(r.get("uploaded_by")) == str(uid)
            hit = team is not None and (
                (r.get("order_id") is not None and ORDER_TEAM.get(r["order_id"]) == team)
                or (r.get("quote_order_id") is not None
                    and QUOTE_TEAM.get(r["quote_order_id"]) == team)
                or (r.get("inquiry_id") is not None
                    and INQUIRY_TEAM.get(r["inquiry_id"]) == team)
            )
            if not (own or hit):
                continue
        out.append(r)
    return out


class _Conn:
    """假连接：记录 SQL/参数，并按 **canonical 参数位置** 求值可见行。

    mode：list（可见行列表）/ download（按 id 取可见行）/ patch（UPDATE 语义）/
    delete（DELETE 语义）—— 后两者会在 self.rows 上真正改/删，用于断言"库无变化"。
    """

    def __init__(self, user, is_admin, mode, rows=None):
        self.user = user
        self.is_admin = is_admin
        self.mode = mode
        self.rows = [dict(r) for r in (rows if rows is not None else ROWS)]
        self.calls: list[tuple[str, tuple]] = []

    def _scope_from(self, text, params):
        if self.mode == "list":
            tenant, idx = params[0], 1
        else:
            tenant, idx = params[1], 2
        uid = team = None
        if not self.is_admin:
            uid = params[idx]
            idx += 1
            if "team_id = $" in text:
                team = params[idx]
                idx += 3
        return tenant, uid, team, idx

    def _visible(self, text, params):
        tenant, uid, team, _idx = self._scope_from(text, params)
        return _simulate(tenant=tenant, is_admin=self.is_admin, uid=uid, team=team,
                         rows=self.rows)

    def _hit(self, text, params):
        doc_id = params[0]
        hit = [r for r in self._visible(text, params) if r["id"] == doc_id]
        return hit[0] if hit else None

    async def fetch(self, sql, *params):
        text = " ".join(str(sql).split())
        self.calls.append((text, params))
        assert self.mode == "list", "fetch 只用于列表端点"
        tenant, uid, team, idx = self._scope_from(text, params)
        remaining = list(params[idx:-1])
        order_filter = doc_filter = None
        if remaining and "AND order_id=$" in text:
            order_filter = remaining.pop(0)
        if remaining and "AND doc_type=$" in text:
            doc_filter = remaining.pop(0)
        return _simulate(tenant=tenant, is_admin=self.is_admin, uid=uid, team=team,
                         order_id=order_filter, doc_type=doc_filter, rows=self.rows)

    async def fetchrow(self, sql, *params):
        text = " ".join(str(sql).split())
        self.calls.append((text, params))
        row = self._hit(text, params)
        if self.mode == "download":
            return row
        if self.mode == "patch":
            if row is None:
                return None
            new_status, new_notes = params[-2], params[-1]
            row["status"] = new_status
            if new_notes is not None:
                row["notes"] = new_notes
            return {"id": row["id"], "status": row["status"]}
        if self.mode == "delete":
            if row is None:
                return None
            self.rows = [r for r in self.rows if r["id"] != row["id"]]
            return {"id": row["id"]}
        raise AssertionError("未预期的 fetchrow 模式：" + self.mode)

    async def execute(self, sql, *params):
        raise AssertionError("PATCH/DELETE 必须用 RETURNING 判定命中，不应再调用 execute")


class _CM:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *exc):
        return False


def _install(monkeypatch, user, is_admin, mode, rows=None):
    conn = _Conn(user, is_admin, mode, rows)
    monkeypatch.setattr(ws_extras, "_acquire", lambda request: _CM(conn))
    return conn


# ── canonical SQL（列表 / 下载）：与门面测试断言同一份形状 ─────────────────────

_LIST_SELECT = (
    "SELECT id, doc_type, file_name, content_type, file_size, order_id,"
    " quote_order_id, inquiry_id, customer_id, status, notes, uploaded_by, created_at"
    " FROM external_doc_uploads WHERE 1=1"
)
_LIST_SCOPE = (
    " AND (uploaded_by = $2::text"
    " OR order_id IN (SELECT id FROM orders WHERE tenant_id = $1 AND team_id = $3)"
    " OR quote_order_id IN (SELECT id FROM quote_orders WHERE tenant_id = $1 AND team_id = $4)"
    " OR inquiry_id IN (SELECT id FROM cust_inquiries WHERE tenant_id = $1 AND team_id = $5))"
)
_LIST_TAIL = " ORDER BY created_at DESC LIMIT "
_DL_SELECT = "SELECT * FROM external_doc_uploads WHERE id=$1 AND tenant_id=$2"
_DL_SCOPE = (
    " AND (uploaded_by = $3::text"
    " OR order_id IN (SELECT id FROM orders WHERE tenant_id = $2 AND team_id = $4)"
    " OR quote_order_id IN (SELECT id FROM quote_orders WHERE tenant_id = $2 AND team_id = $5)"
    " OR inquiry_id IN (SELECT id FROM cust_inquiries WHERE tenant_id = $2 AND team_id = $6))"
)


class TestListIsolation:
    def test_管理员_只受租户约束(self, monkeypatch):
        conn = _install(monkeypatch, ADMIN, True, "list")
        out = asyncio.run(ws_extras.list_external_docs(object(), limit=50, user=ADMIN))
        assert {r["id"] for r in out} == EXPECTED["admin"]
        sql, params = conn.calls[0]
        assert sql == (_LIST_SELECT + " AND tenant_id=$1" + _LIST_TAIL + "$2")
        assert params == (TENANT, 50)

    def test_成员_本人上传_或本团队挂载件(self, monkeypatch):
        conn = _install(monkeypatch, MEMBER, False, "list")
        out = asyncio.run(ws_extras.list_external_docs(object(), limit=50, user=MEMBER))
        assert {r["id"] for r in out} == EXPECTED["member"]
        sql, params = conn.calls[0]
        assert sql == (_LIST_SELECT + " AND tenant_id=$1" + _LIST_SCOPE + _LIST_TAIL + "$6")
        # uid 是 $2；三个团队占位符 $3/$4/$5 都取本团队
        assert params == (TENANT, "9", 4, 4, 4, 50)

    def test_别团队_只看得到挂自己团队单的件(self, monkeypatch):
        _install(monkeypatch, OTHER, False, "list")
        out = asyncio.run(ws_extras.list_external_docs(object(), limit=50, user=OTHER))
        assert {r["id"] for r in out} == EXPECTED["other"]

    def test_无团队_非管理员_看不到任何件(self, monkeypatch):
        conn = _install(monkeypatch, NO_TEAM, False, "list")
        out = asyncio.run(ws_extras.list_external_docs(object(), limit=50, user=NO_TEAM))
        assert {r["id"] for r in out} == EXPECTED["no_team"]
        sql, params = conn.calls[0]
        # 无团队 ⇒ 谓词只剩 uploaded_by，不出现任何 team 子查询
        assert "team_id =" not in sql
        assert sql == (_LIST_SELECT + " AND tenant_id=$1"
                       + " AND (uploaded_by = $2::text)" + _LIST_TAIL + "$3")
        assert params == (TENANT, "11", 50)

    def test_筛选参数排在可见性谓词之后(self, monkeypatch):
        conn = _install(monkeypatch, MEMBER, False, "list")
        asyncio.run(ws_extras.list_external_docs(
            object(), order_id=31, doc_type="pi", limit=50, user=MEMBER))
        sql, params = conn.calls[0]
        assert sql == (_LIST_SELECT + " AND tenant_id=$1" + _LIST_SCOPE
                       + " AND order_id=$6 AND doc_type=$7" + _LIST_TAIL + "$8")
        assert params == (TENANT, "9", 4, 4, 4, 31, "pi", 50)

    def test_阳性对照_同一行换团队身份可见性不同(self, monkeypatch):
        """doc 2 挂 team 8 订单：MEMBER 看不见、OTHER 看得见 ⇒ 证明不是恒空。"""
        _install(monkeypatch, MEMBER, False, "list")
        member_ids = {r["id"] for r in asyncio.run(
            ws_extras.list_external_docs(object(), limit=50, user=MEMBER))}
        _install(monkeypatch, OTHER, False, "list")
        other_ids = {r["id"] for r in asyncio.run(
            ws_extras.list_external_docs(object(), limit=50, user=OTHER))}
        assert 2 not in member_ids
        assert 2 in other_ids
        assert member_ids != other_ids


# ── 2. 下载：可见性 + 越权 404 ───────────────────────────────────────────────

def _download(monkeypatch, user, doc_id, *, is_admin):
    conn = _install(monkeypatch, user, is_admin, "download")
    try:
        resp = asyncio.run(ws_extras.download_external_doc(object(), doc_id, user=user))
        return resp, conn
    except HTTPException as exc:
        return exc, conn


class TestDownloadIsolation:
    def test_本人上传_可下载_且SQL带租户与谓词(self, monkeypatch):
        resp, conn = _download(monkeypatch, MEMBER, 1, is_admin=False)
        assert resp.status_code == 200
        assert resp.body == b"%PDF-1.4 1"
        sql, params = conn.calls[0]
        assert sql == _DL_SELECT + _DL_SCOPE
        assert params == (1, TENANT, "9", 4, 4, 4)

    def test_本团队订单挂载件_可下载(self, monkeypatch):
        resp, _ = _download(monkeypatch, MEMBER, 3, is_admin=False)
        assert resp.status_code == 200
        assert resp.body == b"%PDF-1.4 3"

    def test_跨团队_404_且不泄露存在性(self, monkeypatch):
        exc, _ = _download(monkeypatch, MEMBER, 2, is_admin=False)
        assert isinstance(exc, HTTPException)
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found"}

    def test_未挂载且非本人上传_404(self, monkeypatch):
        exc, _ = _download(monkeypatch, MEMBER, 6, is_admin=False)
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found"}

    def test_无团队非管理员_404_且SQL无团队子查询(self, monkeypatch):
        exc, conn = _download(monkeypatch, NO_TEAM, 3, is_admin=False)
        assert exc.status_code == 404
        sql, params = conn.calls[0]
        assert "team_id =" not in sql
        assert params == (3, TENANT, "11")

    def test_管理员_本租户可下载_跨租户仍404(self, monkeypatch):
        ok, _ = _download(monkeypatch, ADMIN, 2, is_admin=True)
        assert ok.status_code == 200
        cross, _ = _download(monkeypatch, ADMIN, 7, is_admin=True)
        assert isinstance(cross, HTTPException) and cross.status_code == 404

    def test_不存在_404(self, monkeypatch):
        exc, _ = _download(monkeypatch, ADMIN, 999, is_admin=True)
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found"}


# ── 3. parity 矩阵（与门面测试同一份期望集合）─────────────────────────────────

def test_可见集合矩阵与门面一致():
    """把矩阵本身钉死：门面 tests/misc-read.test.ts 有同名常量与同样断言。

    这样任何一侧改了「谁可见」的口径，都会有一侧红 —— 防止两条路径悄悄分叉。
    """
    computed = {
        "admin": {r["id"] for r in _simulate(tenant=TENANT, is_admin=True)},
        "member": {r["id"] for r in _simulate(
            tenant=TENANT, is_admin=False, uid="9", team=4)},
        "other": {r["id"] for r in _simulate(
            tenant=TENANT, is_admin=False, uid="10", team=8)},
        "no_team": {r["id"] for r in _simulate(
            tenant=TENANT, is_admin=False, uid="11", team=None)},
    }
    assert computed == EXPECTED

# ── 4. PATCH / DELETE：同源越权面收口（task-13）──────────────────────────────
# 与列表/下载同一把尺（复用 _external_doc_scope）：tenant 恒在 + 行级谓词；
# 越权/跨租户/不存在统一 404 {"error":"not_found"}（不泄露存在性）。

_PATCH_PREFIX = "UPDATE external_doc_uploads SET status="
_PATCH_WHERE = " WHERE id=$1 AND tenant_id=$2"
_PATCH_RETURNING = " RETURNING id, status"
_DELETE_PREFIX = "DELETE FROM external_doc_uploads WHERE id=$1 AND tenant_id=$2"
_RETURNING_ID = " RETURNING id"


class TestPatchIsolation:
    def _patch(self, monkeypatch, user, doc_id, *, is_admin, status="issued", notes="OK"):
        conn = _install(monkeypatch, user, is_admin, "patch")
        try:
            out = asyncio.run(ws_extras.update_external_doc(
                object(), doc_id, status, notes=notes, user=user))
            return out, conn
        except HTTPException as exc:
            return exc, conn

    def test_本团队可改_且SQL带租户与谓词(self, monkeypatch):
        out, conn = self._patch(monkeypatch, MEMBER, 3, is_admin=False)
        assert out == {"id": 3, "status": "issued"}
        row = next(r for r in conn.rows if r["id"] == 3)
        assert row["status"] == "issued"
        assert row["notes"] == "OK"
        sql, params = conn.calls[0]
        assert sql == (_PATCH_PREFIX + "$7, notes=COALESCE($8, notes)"
                       + _PATCH_WHERE + _DL_SCOPE + _PATCH_RETURNING)
        assert params == (3, TENANT, "9", 4, 4, 4, "issued", "OK")

    def test_跨团队_404_且数据库无变化(self, monkeypatch):
        before = dict(next(r for r in ROWS if r["id"] == 2))
        exc, conn = self._patch(monkeypatch, MEMBER, 2, is_admin=False, status="void")
        assert isinstance(exc, HTTPException)
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found"}
        # 行完全没变（status/notes 都是原值），且**只有那一条 UPDATE**（没有先查后改）
        assert next(r for r in conn.rows if r["id"] == 2) == before
        assert len(conn.calls) == 1

    def test_未挂载且非本人上传_404_且库无变化(self, monkeypatch):
        before = dict(next(r for r in ROWS if r["id"] == 6))
        exc, conn = self._patch(monkeypatch, MEMBER, 6, is_admin=False)
        assert exc.status_code == 404
        assert next(r for r in conn.rows if r["id"] == 6) == before

    def test_无团队非管理员_404_且SQL只剩uploaded_by(self, monkeypatch):
        before = dict(next(r for r in ROWS if r["id"] == 3))
        exc, conn = self._patch(monkeypatch, NO_TEAM, 3, is_admin=False)
        assert exc.status_code == 404
        sql, params = conn.calls[0]
        assert "team_id =" not in sql
        assert sql == (_PATCH_PREFIX + "$4, notes=COALESCE($5, notes)"
                       + _PATCH_WHERE + " AND (uploaded_by = $3::text)"
                       + _PATCH_RETURNING)
        assert params == (3, TENANT, "11", "issued", "OK")
        assert next(r for r in conn.rows if r["id"] == 3) == before

    def test_管理员_本租户可改_跨租户仍404(self, monkeypatch):
        out, conn = self._patch(monkeypatch, ADMIN, 2, is_admin=True, status="void")
        assert out == {"id": 2, "status": "void"}
        sql, params = conn.calls[0]
        assert sql == (_PATCH_PREFIX + "$3, notes=COALESCE($4, notes)"
                       + _PATCH_WHERE + _PATCH_RETURNING)
        assert params == (2, TENANT, "void", "OK")

        before = dict(next(r for r in ROWS if r["id"] == 7))
        exc, conn2 = self._patch(monkeypatch, ADMIN, 7, is_admin=True)
        assert exc.status_code == 404
        assert next(r for r in conn2.rows if r["id"] == 7) == before

    def test_非法状态_422_且不触库(self, monkeypatch):
        exc, conn = self._patch(monkeypatch, MEMBER, 3, is_admin=False, status="bogus")
        assert isinstance(exc, HTTPException)
        assert exc.status_code == 422
        assert exc.detail == {"error": "invalid_status"}
        assert conn.calls == []


class TestDeleteIsolation:
    def _delete(self, monkeypatch, user, doc_id, *, is_admin):
        conn = _install(monkeypatch, user, is_admin, "delete")
        try:
            out = asyncio.run(ws_extras.delete_external_doc(object(), doc_id, user=user))
            return out, conn
        except HTTPException as exc:
            return exc, conn

    def test_本团队可删_且SQL带租户与谓词(self, monkeypatch):
        out, conn = self._delete(monkeypatch, MEMBER, 3, is_admin=False)
        assert out is None
        assert 3 not in {r["id"] for r in conn.rows}
        sql, params = conn.calls[0]
        assert sql == _DELETE_PREFIX + _DL_SCOPE + _RETURNING_ID
        assert params == (3, TENANT, "9", 4, 4, 4)

    def test_跨团队_404_且行仍在(self, monkeypatch):
        exc, conn = self._delete(monkeypatch, MEMBER, 2, is_admin=False)
        assert isinstance(exc, HTTPException)
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found"}
        # 行仍在，且只有那一条 DELETE（没有先查后删）
        assert 2 in {r["id"] for r in conn.rows}
        assert len(conn.calls) == 1

    def test_无团队非管理员_404_且行仍在(self, monkeypatch):
        exc, conn = self._delete(monkeypatch, NO_TEAM, 3, is_admin=False)
        assert exc.status_code == 404
        assert 3 in {r["id"] for r in conn.rows}
        sql, params = conn.calls[0]
        assert "team_id =" not in sql
        assert sql == (_DELETE_PREFIX + " AND (uploaded_by = $3::text)"
                       + _RETURNING_ID)
        assert params == (3, TENANT, "11")

    def test_管理员_本租户可删_跨租户仍404(self, monkeypatch):
        out, conn = self._delete(monkeypatch, ADMIN, 2, is_admin=True)
        assert out is None
        assert 2 not in {r["id"] for r in conn.rows}
        sql, params = conn.calls[0]
        assert sql == _DELETE_PREFIX + _RETURNING_ID
        assert params == (2, TENANT)

        exc, conn2 = self._delete(monkeypatch, ADMIN, 7, is_admin=True)
        assert exc.status_code == 404
        assert 7 in {r["id"] for r in conn2.rows}

    def test_未挂载且非本人_404_且行仍在(self, monkeypatch):
        exc, conn = self._delete(monkeypatch, MEMBER, 6, is_admin=False)
        assert exc.status_code == 404
        assert 6 in {r["id"] for r in conn.rows}

    def test_不存在_404(self, monkeypatch):
        exc, conn = self._delete(monkeypatch, ADMIN, 999, is_admin=True)
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found"}
        assert {r["id"] for r in conn.rows} == {r["id"] for r in ROWS}
