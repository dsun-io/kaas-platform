"""团队（三层组织）业务规则 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。

组织模型（2026-10-11 业务确认）
------------------------------
租户内三层：**管理员 / 团队 / 成员**。

- **团队由第一个成员创建**：创建者即该团队的**团队管理员**，可管理本团队
  （改名、邀请成员、移除成员）。
- 成员归属：一个用户同一时刻只属于一个团队（`users.team_id`）。
- **建团队 / 加入团队只能二选一**：已经有团队的人不能再建或再加。
- 加入现有团队**必须凭邀请码**（不设"随便挑一个团队就加入"，否则 A 公司的人
  可以自由进入 B 公司团队并看到 B 的数据）。
- 邀请成员两条路：
  1. **邮箱点名**：对方已注册 → 直接入队；未注册 → 生成邀请码留给他注册时用。
  2. **通用邀请码**：不指定邮箱，谁拿到谁用。

数据可见性（与本模块配套）
--------------------------
成员创建的业务记录带 `team_id`（写入时取创建者所在团队），可见性判定见
`kaas_common/workstation/scope.py`：本团队可见，其他团队不可见；管理员全可见。
"""
from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

__all__ = [
    "INVITE_STATUS", "INVITE_TTL_DAYS", "TEAM_NAME_MAX",
    "TeamRuleError", "validate_team_name", "normalize_invite_token",
    "generate_invite_token", "invite_state", "is_team_admin",
]

INVITE_STATUS = ("pending", "accepted", "revoked")
INVITE_TTL_DAYS = 14
TEAM_NAME_MAX = 40

# 邀请码字符集：URL 安全、去除容易看错的 0/O/1/l/I（邀请码要靠人转述/手抄）
_TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
_TOKEN_LENGTH = 24


class TeamRuleError(ValueError):
    """团队业务规则违例。code 供 API 层直接落 detail.code。"""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")


def validate_team_name(name: Optional[str]) -> str:
    """团队名规范化 + 校验：去首尾空白、折叠内部空白、长度 1..40。

    返回规范化后的名字（API 层直接用返回值入库，避免"同名但差一个空格"重复建团队）。
    """
    normalized = re.sub(r"\s+", " ", (name or "").strip())
    if not normalized:
        raise TeamRuleError("INVALID_TEAM_NAME", "团队名称不能为空")
    if len(normalized) > TEAM_NAME_MAX:
        raise TeamRuleError(
            "INVALID_TEAM_NAME", f"团队名称不能超过 {TEAM_NAME_MAX} 个字符")
    return normalized


def generate_invite_token() -> str:
    """生成邀请码（URL 安全、无易混字符、24 位 ≈ 140 bit 熵）。"""
    return "".join(secrets.choice(_TOKEN_ALPHABET) for _ in range(_TOKEN_LENGTH))


def normalize_invite_token(raw: Optional[str]) -> str:
    """规范化用户粘贴进来的邀请码。

    用户常常整段链接一起复制（`https://.../join?token=XXXX`）或带空格，
    这里统一处理：去空白、取最后一段 `token=` 的值；找不到就原样返回去空白的结果。
    """
    text = (raw or "").strip()
    if not text:
        return ""
    match = re.search(r"[?&]token=([^&\s]+)", text)
    if match:
        text = match.group(1)
    return text.strip().strip("/")


def invite_state(invite: Optional[Mapping[str, Any]],
                 now: Optional[datetime] = None) -> str:
    """邀请码状态：`usable` | `not_found` | `revoked` | `used` | `expired`。

    调用方按状态映射 HTTP：not_found→404，其余→410/409（详见各端路由）。
    """
    if invite is None:
        return "not_found"
    status = (invite.get("status") or "pending")
    if status == "revoked":
        return "revoked"
    if status == "accepted":
        return "used"
    expires_at = invite.get("expires_at")
    if expires_at is not None:
        now = now or datetime.now(timezone.utc)
        # 库里可能是 naive（TIMESTAMPTZ 取出来一般是 aware；这里两侧都兼容）
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= now:
            return "expired"
    return "usable"


def is_team_admin(team_created_by: Any, user_id: Any, role: Optional[str] = None) -> bool:
    """是否可管理该团队：**团队管理员**（团队创建者）或平台管理员。

    平台管理员（system_admin，含历史 admin）能管所有团队 —— 运维需要兜底；
    团队管理员只能管自己创建的那个团队（调用方传入的是该团队的 created_by）。
    """
    from kaas_common.workstation.scope import is_admin_role  # 同包，避免顶层循环
    if is_admin_role(role):
        return True
    if team_created_by is None or user_id is None:
        return False
    return str(team_created_by) == str(user_id)
