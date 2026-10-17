"""平台账号治理端点（`app/api/admin_accounts.py`）—— 无数据库单元测试。

覆盖口径（与 t1 验收契约逐条对应）：
1. 响应白名单：绝不含 password_hash / token 等敏感键；
2. 鉴权：仅 internal + effective_role=system_admin（含历史 admin→system_admin 映射）可放行，
   internal 普通账号与 customer 账号一律 403；
3. 状态校验：只接受 active|disabled（其余 422）、账号不存在 404；
4. 保护：SELF_PROTECT（禁停自己，409）与 LAST_ADMIN（禁停最后一名 active system_admin，409，
   计数取自 FOR UPDATE 行锁查询，杜绝并发禁用双双通过的竞态）；
5. 停用/恢复写入 status 并提交；
6. 分页：limit/offset 落到 SQL（LIMIT/OFFSET），响应附不受分页影响的 total。

做法：直接以桩 request + 桩 db 调用端点函数（不经过 HTTP 栈、不连库），
这样 `-m unit` 在任何环境都能跑，且断言的是真实业务分支。
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.admin_accounts import (
    AccountStatusIn,
    _account_out,
    list_accounts,
    update_account_status,
)
from app.core.auth import AuthContext
from app.db.models import User

pytestmark = pytest.mark.unit

_NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
_UNSET = object()


class _StubResult:
    """按需要伪装 select 结果的四种取法。"""

    def __init__(self, *, scalars=None, rows=None, one=None, one_or_none=_UNSET):
        self._scalars = list(scalars or [])
        self._rows = list(rows or [])
        self._one = one
        self._one_or_none = one_or_none

    def scalars(self):
        return self

    def all(self):
        return self._rows if self._rows else self._scalars

    def scalar_one(self):
        return self._one

    def scalar_one_or_none(self):
        return None if self._one_or_none is _UNSET else self._one_or_none


class _StubDb:
    """按调用顺序吐预设结果。"""

    def __init__(self, *results: _StubResult):
        self._results = list(results)
        self.committed = False
        self.statements: list = []  # 记录收到的 SQLAlchemy 语句，供断言用

    async def execute(self, _stmt):
        assert self._results, "端点执行了多于预期的查询（桩结果已用尽）"
        self.statements.append(_stmt)
        return self._results.pop(0)

    async def commit(self):
        self.committed = True


def _req(auth: AuthContext) -> SimpleNamespace:
    return SimpleNamespace(state=SimpleNamespace(auth=auth))


def _user(user_id: int = 2, *, role: str = "user", status: str = "active",
          account_type: str = "internal", team_id=None, console_access=False) -> User:
    u = User(
        id=user_id, email=f"u{user_id}@qa.test", password_hash="HASH-SECRET",
        display_name=f"用户{user_id}", account_type=account_type, role=role,
        plan="free", status=status, team_id=team_id, console_access=console_access,
        created_at=_NOW, updated_at=_NOW,
    )
    return u


def _system_admin() -> AuthContext:
    return AuthContext(user_id=1, account_type="internal", role="system_admin")


def _internal_member() -> AuthContext:
    return AuthContext(user_id=2, account_type="internal", role="user")


def _customer() -> AuthContext:
    return AuthContext(user_id=3, account_type="customer", role="owner")


# ── 1. 响应白名单 ────────────────────────────────────────────────────────────

def test_account_out_whitelist_has_no_sensitive_keys():
    payload = _account_out(_user(7, role="admin", team_id=5), "示例团队")
    assert set(payload) == {
        "id", "email", "display_name", "account_type", "role", "status",
        "team_id", "team_name", "console_access", "created_at", "updated_at",
    }
    assert "password_hash" not in payload and "password" not in payload
    assert "token" not in payload
    # 历史 admin 映射成 system_admin（与 AuthContext.effective_role 同源）
    assert payload["role"] == "system_admin"
    assert payload["team_name"] == "示例团队"


def test_account_out_maps_legacy_and_unknown_roles():
    assert _account_out(_user(1, role="admin"), None)["role"] == "system_admin"
    assert _account_out(_user(1, role="owner"), None)["role"] == "customer_owner"
    assert _account_out(_user(1, role="不认识的旧角色"), None)["role"] == "customer_member"


# ── 2. 鉴权 ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_accounts_rejects_internal_member():
    with pytest.raises(HTTPException) as exc:
        await list_accounts(_req(_internal_member()), db=_StubDb())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_list_accounts_rejects_customer():
    with pytest.raises(HTTPException) as exc:
        await list_accounts(_req(_customer()), db=_StubDb())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_update_status_rejects_non_admin():
    db = _StubDb()
    with pytest.raises(HTTPException) as exc:
        await update_account_status(9, AccountStatusIn(status="disabled"), _req(_customer()), db)
    assert exc.value.status_code == 403
    assert db.committed is False


@pytest.mark.asyncio
async def test_list_accounts_returns_whitelisted_rows_for_system_admin():
    users = [_user(1, role="system_admin"), _user(2, team_id=5)]
    db = _StubDb(
        _StubResult(one=2),                               # count(*) 全量计数
        _StubResult(scalars=users),                       # select(User) LIMIT/OFFSET
        _StubResult(rows=[(5, "联佳丝网")]),               # select(Team.id, Team.name)
    )
    body = await list_accounts(_req(_system_admin()), limit=500, offset=0, db=db)
    assert [a["id"] for a in body["accounts"]] == [1, 2]
    assert body["accounts"][1]["team_name"] == "联佳丝网"
    assert body["total"] == 2
    assert all("password_hash" not in a for a in body["accounts"])


@pytest.mark.asyncio
async def test_list_accounts_pagination_params_flow_into_query():
    """limit/offset 应落到 SQL 上（LIMIT/OFFSET 子句），且越界值被 FastAPI 校验挡住。"""
    db = _StubDb(
        _StubResult(one=10),
        _StubResult(scalars=[_user(1)]),
        _StubResult(rows=[]),
    )
    body = await list_accounts(_req(_system_admin()), limit=1, offset=1, db=db)
    assert body["total"] == 10            # total 不受分页影响
    assert len(body["accounts"]) == 1
    page_stmt = str(db.statements[1].compile(compile_kwargs={"literal_binds": True}))
    assert "LIMIT" in page_stmt and "OFFSET" in page_stmt


# ── 3. 状态校验 ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_update_status_rejects_unknown_status():
    with pytest.raises(HTTPException) as exc:
        await update_account_status(
            9, AccountStatusIn(status="deleted"), _req(_system_admin()), _StubDb())
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_update_status_unknown_user_404():
    db = _StubDb(_StubResult(one_or_none=None))
    with pytest.raises(HTTPException) as exc:
        await update_account_status(
            999, AccountStatusIn(status="disabled"), _req(_system_admin()), db)
    assert exc.value.status_code == 404


# ── 4. 保护规则 ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cannot_disable_self():
    db = _StubDb(_StubResult(one_or_none=_user(1, role="system_admin")))
    with pytest.raises(HTTPException) as exc:
        await update_account_status(
            1, AccountStatusIn(status="disabled"), _req(_system_admin()), db)
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "SELF_PROTECT"
    assert db.committed is False


@pytest.mark.asyncio
async def test_cannot_disable_last_active_system_admin():
    db = _StubDb(
        _StubResult(one_or_none=_user(2, role="system_admin")),   # 目标：另一名管理员
        _StubResult(scalars=[2]),                                 # FOR UPDATE 锁到的 active 管理员行
    )
    with pytest.raises(HTTPException) as exc:
        await update_account_status(
            2, AccountStatusIn(status="disabled"), _req(_system_admin()), db)
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "LAST_ADMIN"
    assert db.committed is False
    # 竞态修复的实质：计数来自 FOR UPDATE 行锁查询（而非裸 count），
    # 并发禁用会在锁上串行化、后到事务重读行集必然已减。
    lock_stmt = str(db.statements[1].compile(compile_kwargs={"literal_binds": True}))
    assert "FOR UPDATE" in lock_stmt


@pytest.mark.asyncio
async def test_cannot_disable_last_admin_when_legacy_role_admin():
    """历史 role='admin' 与 system_admin 同义，最后一名同样受保护。"""
    db = _StubDb(
        _StubResult(one_or_none=_user(3, role="admin")),
        _StubResult(scalars=[3]),
    )
    with pytest.raises(HTTPException) as exc:
        await update_account_status(
            3, AccountStatusIn(status="disabled"), _req(_system_admin()), db)
    assert exc.value.detail["code"] == "LAST_ADMIN"


# ── 5. 正向写入 ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_disable_then_restore_writes_status():
    target = _user(4, role="user")
    db = _StubDb(_StubResult(one_or_none=target))
    body = await update_account_status(
        4, AccountStatusIn(status="disabled"), _req(_system_admin()), db)
    assert target.status == "disabled"
    assert db.committed is True
    assert body["account"]["status"] == "disabled"

    target2 = _user(4, role="user", status="disabled")
    db2 = _StubDb(_StubResult(one_or_none=target2))
    body2 = await update_account_status(
        4, AccountStatusIn(status="active"), _req(_system_admin()), db2)
    assert target2.status == "active"
    assert body2["account"]["status"] == "active"


@pytest.mark.asyncio
async def test_disable_other_admin_allowed_when_more_than_one_remains():
    db = _StubDb(
        _StubResult(one_or_none=_user(5, role="system_admin")),
        _StubResult(scalars=[1, 5]),     # 锁到 2 名 active 管理员 ⇒ 放行停用其一
    )
    body = await update_account_status(
        5, AccountStatusIn(status="disabled"), _req(_system_admin()), db)
    assert body["account"]["status"] == "disabled"
    assert db.committed is True
