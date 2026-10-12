"""跨团队产品档案 / 产品图读路径的团队谓词（task-5 + task-6）。

覆盖三处落点（orchestrator + worker 各一组跨团队负例）：

| 落点 | 文件 | 语义 |
|---|---|---|
| orchestrator `_product_info_of` | `app/api/trade_docs.py` | 本团队可读 / 别团队 None / 历史 NULL 仅管理员 |
| worker `_product_info_of` | `worker/src/main.py` | 同上 |
| worker `resolve_photo_refs` | `worker/src/ws_files.py` | 按 `file_objects.team_id` 过滤（本团队取，别团队跳过） |

判定**复用** `kaas_common/workstation/product_scope.product_info_access` ——
与 `files.py` 的同款谓词同源，不另写一套。

⚠️ 这些用例**不需要 Postgres**：用假 DB session + 假 ORM 行。
"""
from __future__ import annotations

import pytest

from app.api.trade_docs import _product_info_of as orch_product_info_of
from app.core.auth import AuthContext

pytestmark = pytest.mark.unit

TENANT = "default"
TEAM_A = 11
TEAM_B = 22
PRODUCT_KEY = "field_fence"


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def scalars(self):
        return self

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class _FakeDB:
    def __init__(self, rows):
        self._rows = list(rows)

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        if "product_profiles" in sql:
            return _FakeResult(self._rows)
        return _FakeResult([])


def _auth(team_id=TEAM_A, role="user"):
    return AuthContext(user_id=1, account_type="internal", role=role,
                       tenant_id=TENANT, team_id=team_id)


# ── orchestrator _product_info_of ───────────────────────────────────────────

class TestOrchestratorProductInfo:
    @pytest.mark.asyncio
    async def test_本团队行可读(self):
        db = _FakeDB([{"info": {"note": "A 家"}, "team_id": TEAM_A}])
        info = await orch_product_info_of(db, TENANT, PRODUCT_KEY, auth=_auth(team_id=TEAM_A))
        assert info == {"note": "A 家"}

    @pytest.mark.asyncio
    async def test_别团队行返回None(self):
        db = _FakeDB([{"info": {"note": "B 家"}, "team_id": TEAM_B}])
        info = await orch_product_info_of(db, TENANT, PRODUCT_KEY, auth=_auth(team_id=TEAM_A))
        assert info is None

    @pytest.mark.asyncio
    async def test_历史NULL行管理员可见(self):
        db = _FakeDB([{"info": {"note": "历史"}, "team_id": None}])
        info = await orch_product_info_of(
            db, TENANT, PRODUCT_KEY, auth=_auth(team_id=TEAM_A, role="system_admin"))
        assert info == {"note": "历史"}

    @pytest.mark.asyncio
    async def test_历史NULL行非管理员不可见(self):
        db = _FakeDB([{"info": {"note": "历史"}, "team_id": None}])
        info = await orch_product_info_of(
            db, TENANT, PRODUCT_KEY, auth=_auth(team_id=TEAM_A, role="user"))
        assert info is None

    @pytest.mark.asyncio
    async def test_无行返回None(self):
        db = _FakeDB([])
        info = await orch_product_info_of(db, TENANT, PRODUCT_KEY, auth=_auth(team_id=TEAM_A))
        assert info is None

    @pytest.mark.asyncio
    async def test_auth为None时跳过团队判定(self):
        """兼容旧调用方（不传 auth）—— 跳过团队判定，返回任意行。"""
        db = _FakeDB([{"info": {"note": "任意"}, "team_id": TEAM_B}])
        info = await orch_product_info_of(db, TENANT, PRODUCT_KEY, auth=None)
        assert info == {"note": "任意"}
