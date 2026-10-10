"""客户/询盘业务规则 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from typing import Any, Optional

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
    """是否可看全部（管理员/租户级）。"""
    role = _get(auth, "role") or ""
    account_type = _get(auth, "account_type") or ""
    return role in ("admin", "super_admin") or account_type == "internal"


def _get(obj: Any, key: str):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)
