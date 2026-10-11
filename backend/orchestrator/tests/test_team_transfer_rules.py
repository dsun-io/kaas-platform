"""团队管理员转让的**策略无关**校验测试。

设计背景：文档 `PROBLEM_STATUS_2026-10-11.md` 把「团队管理员转让」
列在「需要排期（非本轮）」，**没有记录设计** —— 现行口径是
「当前固定为创建者；换人需平台管理员介入」。

其中"**谁能发起转让**"是**授权决策**（平台管理员？还是现任管理员自己？），
不该由我替用户定；但下面两种情况在任何方案下都不成立，
所以先落进共享内核并测住：

1. 转给**非本团队成员** —— 等于把团队交给外人
2. 转给**自己** —— 空操作，且"静默成功"比报错更难查
"""
import pytest

from kaas_common.workstation.teams import (
    TeamRuleError,
    validate_transfer_target,
)

pytestmark = pytest.mark.unit

MEMBERS = [11, 22, 33]
OWNER = 11


class TestAcceptsValidTarget:
    def test_member_can_receive(self):
        validate_transfer_target(target_user_id=22, current_owner_id=OWNER,
                                 member_user_ids=MEMBERS)   # 不抛即通过

    def test_string_and_int_ids_are_compared_by_value(self):
        """两端 id 类型不同（orchestrator int / worker str），
        直接 `==` 会漏判 —— 这条钉住"统一转字符串"。"""
        validate_transfer_target(target_user_id="22", current_owner_id="11",
                                 member_user_ids=["11", "22"])


class TestRejectsNonMember:
    def test_outsider_is_rejected(self):
        with pytest.raises(TeamRuleError) as e:
            validate_transfer_target(target_user_id=99, current_owner_id=OWNER,
                                     member_user_ids=MEMBERS)
        assert e.value.code == "TRANSFER_TARGET_NOT_MEMBER"

    def test_empty_member_list_rejects_everyone(self):
        with pytest.raises(TeamRuleError):
            validate_transfer_target(target_user_id=22, current_owner_id=OWNER,
                                     member_user_ids=[])

    def test_none_member_list_is_treated_as_empty(self):
        with pytest.raises(TeamRuleError):
            validate_transfer_target(target_user_id=22, current_owner_id=OWNER,
                                     member_user_ids=None)


class TestRejectsSelf:
    def test_transfer_to_self_is_rejected(self):
        with pytest.raises(TeamRuleError) as e:
            validate_transfer_target(target_user_id=OWNER, current_owner_id=OWNER,
                                     member_user_ids=MEMBERS)
        assert e.value.code == "TRANSFER_TO_SELF"

    def test_self_check_uses_string_comparison(self):
        with pytest.raises(TeamRuleError) as e:
            validate_transfer_target(target_user_id="11", current_owner_id=11,
                                     member_user_ids=["11", "22"])
        assert e.value.code == "TRANSFER_TO_SELF"

    def test_self_check_runs_before_membership_check(self):
        """现任管理员**不在**成员列表里时（数据不一致），
        转给自己应当先报 TRANSFER_TO_SELF —— 否则会误报"非成员"，
        把调用方引向错误的排查方向。"""
        with pytest.raises(TeamRuleError) as e:
            validate_transfer_target(target_user_id=OWNER, current_owner_id=OWNER,
                                     member_user_ids=[22, 33])
        assert e.value.code == "TRANSFER_TO_SELF"


class TestMissingTarget:
    def test_none_target_is_rejected(self):
        with pytest.raises(TeamRuleError) as e:
            validate_transfer_target(target_user_id=None, current_owner_id=OWNER,
                                     member_user_ids=MEMBERS)
        assert e.value.code == "TRANSFER_TARGET_REQUIRED"
