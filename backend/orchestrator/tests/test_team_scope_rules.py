"""三层组织（管理员/团队/成员）判定规则的单测。

判定真源是共享内核 `kaas_common/workstation/scope.py` 与 `.../teams.py`，
orchestrator 与 Worker 都用同一份 —— 这里把它们钉死，防止任何一端"顺手改口径"。
"""
import pytest
from datetime import datetime, timedelta, timezone

from kaas_common.workstation import scope, teams

pytestmark = pytest.mark.unit


# ── scope：可见性 ───────────────────────────────────────────────────────────

def test_admin_sees_everything():
    assert scope.can_view(role="system_admin") is True
    # 历史角色 admin 等价于 system_admin（dev 的 effective_role 就这么映射）
    assert scope.can_view(role="admin") is True


def test_role_mapping():
    assert scope.effective_role("system_admin") == "system_admin"
    assert scope.effective_role("admin") == "system_admin"
    assert scope.effective_role("owner") == "customer_owner"
    assert scope.effective_role("customer_owner") == "customer_owner"
    assert scope.effective_role("user") == "customer_member"
    assert scope.effective_role("customer_member") == "customer_member"
    assert scope.effective_role(None) == "customer_member"
    assert scope.effective_role("nonsense") == "customer_member"   # 未知角色按最小权限
    assert scope.is_admin_role("admin") is True
    assert scope.is_admin_role("owner") is False


def test_tenant_shared_is_visible_to_everyone():
    assert scope.can_view(role="user", owner_scope="tenant", owner_id="777",
                          viewer_id=9, viewer_team_id=5) is True


def test_own_record_is_visible():
    assert scope.can_view(role="user", owner_id="9", owner_scope="private",
                          viewer_id=9, viewer_team_id=None) is True


def test_same_team_is_visible():
    """本次新增的核心规则：成员创建的记录，本团队可见。"""
    assert scope.can_view(role="user", owner_id="3", owner_scope="private", team_id=1,
                          viewer_id=9, viewer_team_id=1) is True


def test_other_team_is_invisible():
    assert scope.can_view(role="user", owner_id="3", owner_scope="private", team_id=1,
                          viewer_id=9, viewer_team_id=2) is False


def test_team_isolation_needs_both_sides():
    """行的 team_id 为空 → 不因团队规则放行（历史数据保持原有可见性，零回归）。"""
    assert scope.can_view(role="user", owner_id="3", owner_scope="private", team_id=None,
                          viewer_id=9, viewer_team_id=1) is False
    """访问者没有团队 → 也拿不到团队加成。"""
    assert scope.can_view(role="user", owner_id="3", owner_scope="private", team_id=1,
                          viewer_id=9, viewer_team_id=None) is False


def test_id_type_tolerance():
    """owner_id/team_id 在库里可能是 TEXT 或 BIGINT —— 比较要宽松。"""
    assert scope.can_view(role="user", owner_id=9, owner_scope="private",
                          viewer_id="9") is True
    assert scope.can_view(role="user", team_id="1", owner_scope="private",
                          viewer_id=9, viewer_team_id=1) is True


def test_write_is_stricter_than_read():
    """同团队可见 ≠ 同团队可改：能看见同事的客户，但不能替同事改。"""
    assert scope.can_write(role="user", owner_id="3", viewer_id=9) is False
    assert scope.can_write(role="user", owner_id="9", viewer_id=9) is True
    assert scope.can_write(role="system_admin", owner_id="3", viewer_id=9) is True
    # 无属主的历史数据不拦写（与既有实现一致）
    assert scope.can_write(role="user", owner_id=None, viewer_id=9) is True


# ── teams：名称 / 邀请码 / 权限 ─────────────────────────────────────────────

def test_validate_team_name_normalizes():
    assert teams.validate_team_name("  安平县联佳丝网制品有限公司  ") == "安平县联佳丝网制品有限公司"
    assert teams.validate_team_name("联佳   团队") == "联佳 团队"


def test_validate_team_name_rejects_blank_and_too_long():
    for bad in ("", "   ", None):
        with pytest.raises(teams.TeamRuleError) as exc:
            teams.validate_team_name(bad)
        assert exc.value.code == "INVALID_TEAM_NAME"
    with pytest.raises(teams.TeamRuleError):
        teams.validate_team_name("x" * (teams.TEAM_NAME_MAX + 1))


def test_generate_invite_token_is_long_and_unambiguous():
    tokens = {teams.generate_invite_token() for _ in range(50)}
    assert len(tokens) == 50                     # 不重复
    sample = tokens.pop()
    assert len(sample) == 24
    # 去掉容易看错的 0/O/1/l/I —— 邀请码要靠人转述
    assert not (set(sample) & set("0O1lI"))


def test_normalize_invite_token_accepts_full_url():
    assert teams.normalize_invite_token("  ABC123  ") == "ABC123"
    assert teams.normalize_invite_token(
        "https://kaas.powervoy.com/join?token=ABC123") == "ABC123"
    assert teams.normalize_invite_token("https://x/join?token=ABC123&next=/a") == "ABC123"
    assert teams.normalize_invite_token("") == ""
    assert teams.normalize_invite_token(None) == ""


def test_invite_state_matrix():
    future = datetime.now(timezone.utc) + timedelta(days=1)
    past = datetime.now(timezone.utc) - timedelta(days=1)
    assert teams.invite_state(None) == "not_found"
    assert teams.invite_state({"status": "pending", "expires_at": future}) == "usable"
    assert teams.invite_state({"status": "pending", "expires_at": None}) == "usable"
    assert teams.invite_state({"status": "revoked", "expires_at": future}) == "revoked"
    assert teams.invite_state({"status": "accepted", "expires_at": future}) == "used"
    assert teams.invite_state({"status": "pending", "expires_at": past}) == "expired"


def test_is_team_admin():
    assert teams.is_team_admin(3, 3) is True
    assert teams.is_team_admin("3", 3) is True          # 类型宽松
    assert teams.is_team_admin(3, 9) is False
    assert teams.is_team_admin(None, 9) is False
    # 平台管理员能管任何团队（运维兜底）
    assert teams.is_team_admin(3, 9, role="system_admin") is True
    assert teams.is_team_admin(3, 9, role="admin") is True
    assert teams.is_team_admin(3, 9, role="owner") is False
