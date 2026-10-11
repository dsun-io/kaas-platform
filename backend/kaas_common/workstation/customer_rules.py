"""客户/询盘业务规则 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from typing import Any, Optional

from .scope import is_admin_role

__all__ = ["validate_stage_transition", "check_write_access", "can_see_all"]


def validate_stage_transition(current: str, target: str) -> tuple[bool, str]:
    """校验客户阶段流转合法性。返回 (合法, 错误信息)。"""
    ALLOWED = {
        "lead": ("inquiry", "lost", "inactive"),
        "inquiry": ("quoted", "lost", "inactive"),
        "quoted": ("negotiating", "won", "lost", "inactive"),
        "negotiating": ("won", "lost", "inactive"),
        "won": ("inactive",),
        "lost": ("lead", "inactive"),  # lost 可重新激活
        "inactive": ("lead",),
    }
    if target == current:
        return True, ""
    allowed = ALLOWED.get(current, ())
    if target not in allowed:
        return False, f"不允许 {current} → {target}；合法目标: {list(allowed)}"
    return True, ""


def check_write_access(row: Any, auth: Any) -> bool:
    """检查当前用户是否有写权限（owner_scope=tenant 或本人创建）。"""
    owner_scope = _get(row, "owner_scope") or "private"
    owner_id = _get(row, "owner_id") or _get(row, "created_by")
    if owner_scope == "tenant":
        return True
    auth_user_id = str(_get(auth, "user_id") or _get(auth, "id") or "")
    return str(owner_id) == auth_user_id


def can_see_all(auth: Any) -> bool:
    """是否可看全部（管理员）。

    **唯一真源** = `kaas_common.workstation.scope.is_admin_role`。

    本函数此前自成一派：认 `role in ("admin", "super_admin")` **或
    `account_type == "internal"`**。后者把「内部账号」等同于管理员 ——
    于是 `internal` + `role=user` 的账号（例如 QA 的 `qa_user`）能看**全部租户**数据。
    这同时违反两处已写明的期望：

      · `docs/QA_TEST_ACCOUNTS.md` 越权审计第 5 条：qa_user 列表**只见 qa_smoke**；
      · Worker 侧 `_can_see_all`（= `scope.is_admin_role`）只认 system_admin。

    三方不一致的后果是同一个账号在不同接口上可见范围不同。
    2026-10-11 收敛到 scope 一份：**管理员 = system_admin（含历史角色 admin），
    与 `account_type` 无关。**
    """
    return is_admin_role(_get(auth, "role"))


def _get(obj: Any, key: str):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)
