"""数据可见范围判定（§10.3 + 三层组织）—— 纯函数、零三方依赖。

为什么要有这个模块
------------------
可见性规则原本在两个运行时各写一份：
  · orchestrator `app/api/ws_common.py` 的 `can_see_all` / `scope_filter`
  · Worker `main.py` 的 `_can_see_all` / `_owner_visible`
写法不同、SQL 与 Python 各一套，改一次口径要改两处（历史已经因此漂移过）。
本模块把**判定本身**收敛成纯函数，两端只负责把它翻译成自己的查询形态。

三层组织（2026-10-11 业务确认）
-------------------------------
租户内分三层：**管理员 / 团队 / 成员**。成员创建的客户，**本团队可见、其他团队不可见**。

判定（任一成立即可见）：
  1. 管理员（role 映射后为 system_admin）—— 全租户可见；
  2. `owner_scope == 'tenant'` —— 显式声明为「全租户共享」的基础数据；
  3. `owner_id == 我` —— 我自己的数据；
  4. `team_id` 非空且等于我的团队 —— **同团队可见（本次新增）**。

为什么规则 4 要求「行的 team_id 非空」而不是「属主的团队」
----------------------------------------------------------
行上直接记 `team_id`（写入时取创建者的团队），而不是靠 `owner_id` 反查属主的团队：
  · 判定无需 JOIN，两端 SQL 都简单；
  · 成员换团队/离职后，数据仍留在原团队，不会跟着人走；
  · 历史数据（`team_id IS NULL`）可以显式指定归属团队，不必编造一个"属主"。

**零回归约定**：`team_id IS NULL` 的行**不因本规则而改变可见性** —— 它仍按规则 1~3
（也就是今天的行为）判定。所以本次上线不会让任何人突然看到或看不到数据；
只有显式分配了团队的行，才会真正按团队隔离。
"""
from __future__ import annotations

from typing import Any, Optional

__all__ = ["ADMIN_ROLES", "effective_role", "is_admin_role", "can_view"]

# 角色映射：旧角色 → 三层角色体系 —— **全仓库唯一一份**。
# orchestrator 侧 User.effective_role / AuthContext.effective_role 均委托本模块；
# 改角色口径只改这里（改完跑 scripts/sync-shared.ps1 同步 worker 端）。
_ROLE_MAP = {
    "system_admin": "system_admin",
    "admin": "system_admin",          # 历史遗留角色，等价于系统管理员
    "owner": "customer_owner",        # 团队负责人
    "customer_owner": "customer_owner",
    "user": "customer_member",        # 团队成员
    "customer_member": "customer_member",
}

ADMIN_ROLES = frozenset({"system_admin", "admin"})


def effective_role(role: Optional[str]) -> str:
    """旧角色 → 三层角色。未知角色按最小权限（customer_member）处理。"""
    return _ROLE_MAP.get(role or "", "customer_member")


def is_admin_role(role: Optional[str]) -> bool:
    """是否管理员（全租户可见）。"""
    return effective_role(role) == "system_admin"


def _same(a: Any, b: Any) -> bool:
    """宽松相等：owner_id / team_id 在库里可能是 TEXT 也可能是 BIGINT。"""
    if a is None or b is None:
        return False
    return str(a) == str(b)


def can_view(
    *,
    role: Optional[str],
    owner_id: Any = None,
    owner_scope: Optional[str] = None,
    team_id: Any = None,
    viewer_id: Any = None,
    viewer_team_id: Any = None,
) -> bool:
    """这条数据对该访问者是否可见（判定规则见模块 docstring）。"""
    if is_admin_role(role):
        return True
    if owner_scope == "tenant":
        return True
    if _same(owner_id, viewer_id):
        return True
    # 同团队：行的 team_id 与访问者的团队都非空且相同。
    # 行的 team_id 为空 → 不因本规则放行（历史数据保持原有可见性）。
    if team_id is not None and viewer_team_id is not None:
        return _same(team_id, viewer_team_id)
    return False


def can_write(*, role: Optional[str], owner_id: Any = None, viewer_id: Any = None) -> bool:
    """写权限：管理员可改全部；成员只能改自己名下的数据。

    注意与可见性的区别：**同团队可见 ≠ 同团队可改** —— 团队成员能看见同事的客户，
    但不能替同事改（否则「谁改的」就说不清了）。这条自 §10.3 起就是独立规则。
    """
    if is_admin_role(role):
        return True
    if owner_id is None:
        return True                      # 无属主的历史数据：不拦（与既有实现一致）
    return _same(owner_id, viewer_id)
