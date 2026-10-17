"""团队管理员转让的**接口级**测试（orchestrator 端，需要 PostgreSQL）。

与 `test_teams_api.py` 同套路（`pytestmark = pytest.mark.db`、
`client`/`db_session`/`as_user` 夹具、辅助函数从那边复用），
补上 `POST /teams/{team_id}/transfer` 这一条端点的**接口级**覆盖。

为什么单独一个文件：`test_teams_api.py` 已 600 余行且被上游频繁改动，
另开一个文件避免与它抢锚点；辅助函数直接 import，不复制。

覆盖的契约（用户 2026-10-11 裁决后定稿）：

- **谁能发起**：现任团队管理员（= 团队创建者）**或**平台管理员
- **目标必须**：本团队成员、且不能是自己
- **动作语义**：改 `teams.created_by`；前任留在团队里当普通成员
- 跨租户的 team_id 一律 404（不泄露别家团队是否存在）

> ⚠️ 本文件需要数据库；本机无库时**整体 skip**（与 `test_teams_api.py` 同行为，
> 不会出现"假绿"）。跑法见 `conftest.py` 的 `TEST_DATABASE_URL`。
"""
import pytest
from sqlalchemy import select

from app.db.models import Team
from tests.test_teams_api import (  # noqa: F401  复用既有辅助，避免复制漂移
    _code,
    _mk_team,
    _mk_user,
    as_user,
)

pytestmark = pytest.mark.db


async def _created_by(db, team_id: int):
    """从库里重读 `created_by`（绕开 identity map，确保看到落库结果）。"""
    return (await db.execute(
        select(Team.created_by).where(Team.id == team_id)
    )).scalar_one()


class TestTransferAdmin:
    async def test_team_admin_transfers_to_member(self, client, db_session, as_user):
        """现任团队管理员把管理权转给本团队成员 → 200，created_by 改为对方。"""
        boss, team_id = await _mk_team(
            client, as_user, db_session, name="转让甲", tag="boss")
        member = await _mk_user(db_session, "m1", team_id=team_id)

        as_user(boss.id, role="owner")
        resp = await client.post(
            f"/api/v1/teams/{team_id}/transfer", json={"user_id": member.id})

        assert resp.status_code == 200, resp.text
        assert await _created_by(db_session, team_id) == member.id

    async def test_previous_admin_stays_as_plain_member(self, client, db_session, as_user):
        """转让**只改 created_by**：前任留在团队里（不是被踢出）。"""
        boss, team_id = await _mk_team(
            client, as_user, db_session, name="转让乙", tag="boss2")
        member = await _mk_user(db_session, "m2", team_id=team_id)

        as_user(boss.id, role="owner")
        assert (await client.post(
            f"/api/v1/teams/{team_id}/transfer", json={"user_id": member.id}
        )).status_code == 200

        # 前任的 team_id 没变 —— 只是不再是管理员
        assert (await db_session.execute(
            select(Team.created_by).where(Team.id == team_id)
        )).scalar_one() == member.id
        await db_session.refresh(boss)
        assert boss.team_id == team_id

    async def test_transfer_to_self_rejected(self, client, db_session, as_user):
        """转给自己 → 422 TRANSFER_TO_SELF（且不落库）。"""
        boss, team_id = await _mk_team(
            client, as_user, db_session, name="转让丙", tag="boss3")

        as_user(boss.id, role="owner")
        resp = await client.post(
            f"/api/v1/teams/{team_id}/transfer", json={"user_id": boss.id})

        assert resp.status_code == 422
        assert _code(resp) == "TRANSFER_TO_SELF"
        assert await _created_by(db_session, team_id) == boss.id

    async def test_transfer_to_non_member_rejected(self, client, db_session, as_user):
        """转给**不在本团队**的人 → 422 TRANSFER_TARGET_NOT_MEMBER。"""
        boss, team_id = await _mk_team(
            client, as_user, db_session, name="转让丁", tag="boss4")
        outsider = await _mk_user(db_session, "outsider")  # team_id=None

        as_user(boss.id, role="owner")
        resp = await client.post(
            f"/api/v1/teams/{team_id}/transfer", json={"user_id": outsider.id})

        assert resp.status_code == 422
        assert _code(resp) == "TRANSFER_TARGET_NOT_MEMBER"
        assert await _created_by(db_session, team_id) == boss.id

    async def test_plain_member_cannot_transfer(self, client, db_session, as_user):
        """普通成员发起 → 403 NOT_TEAM_ADMIN。"""
        boss, team_id = await _mk_team(
            client, as_user, db_session, name="转让戊", tag="boss5")
        member = await _mk_user(db_session, "m5", team_id=team_id)

        as_user(member.id)  # role 默认 user
        resp = await client.post(
            f"/api/v1/teams/{team_id}/transfer", json={"user_id": member.id})

        assert resp.status_code == 403
        assert _code(resp) == "NOT_TEAM_ADMIN"
        assert await _created_by(db_session, team_id) == boss.id

    async def test_platform_admin_can_transfer(self, client, db_session, as_user):
        """平台管理员同样能发起（他自己不必在这个团队里）。"""
        boss, team_id = await _mk_team(
            client, as_user, db_session, name="转让己", tag="boss6")
        member = await _mk_user(db_session, "m6", team_id=team_id)
        ops = await _mk_user(db_session, "ops", role="system_admin")

        as_user(ops.id, role="system_admin")
        resp = await client.post(
            f"/api/v1/teams/{team_id}/transfer", json={"user_id": member.id})

        assert resp.status_code == 200, resp.text
        assert await _created_by(db_session, team_id) == member.id

    async def test_unknown_team_404(self, client, db_session, as_user):
        """不存在的团队 → 404（跨租户的 team_id 也走这条，不泄露存在性）。"""
        boss, _ = await _mk_team(
            client, as_user, db_session, name="转让庚", tag="boss7")

        as_user(boss.id, role="owner")
        resp = await client.post(
            "/api/v1/teams/999999/transfer", json={"user_id": boss.id})

        assert resp.status_code == 404
        assert _code(resp) == "TEAM_NOT_FOUND"
