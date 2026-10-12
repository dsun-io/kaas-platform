"""忘记密码：重置令牌 + Resend 发信（orchestrator 侧）。

安全口径（与 worker 侧同构，两端契约一致）：
- token：`secrets.token_urlsafe(32)` 生成；库里只存 **SHA-256 hex**（`token_hash`），
  查找时把请求明文哈希后比对 —— 库泄露也不足以重置密码。
- 30 分钟过期（`expires_at`）；改密成功即置 `used_at`（用后即废）。
- 改密成功时同用户**其它未用 token 一并失效**（防旧链接重放）。
- `POST /auth/forgot-password` 无论邮箱是否存在都返回统一 `{ok:true}`（不泄露存在性），
  只在确实存在且配了发信凭据时才发信；未配凭据时日志如实记录，不假装成功。

发信走 Resend REST（`RESEND_API_KEY` + 已验证域名 `send.powervoy.com`），与
`app/api/outreach.py` 的触达发信同一渠道、同一密钥。
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import PasswordResetToken, User

logger = structlog.get_logger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"

#: 重置令牌有效期（分钟）
RESET_TOKEN_TTL_MINUTES = 30


def hash_reset_token(raw_token: str) -> str:
    """明文重置令牌 → SHA-256 hex（库里只存这个）。"""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def generate_reset_token() -> str:
    """高熵随机令牌（URL-safe，直接放进链接）。"""
    return secrets.token_urlsafe(32)


async def create_reset_token(
    db: AsyncSession, user_id: int, requested_ip: Optional[str] = None
) -> str:
    """为用户创建一条重置令牌记录，返回**明文**令牌（只在这里出现一次，用于发信）。

    顺带作废该用户此前所有未用令牌（一次只有一条有效链接，避免多链接并存）。
    """
    # 旧令牌全部失效
    await db.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user_id, PasswordResetToken.used_at.is_(None))
        .values(used_at=datetime.now(timezone.utc))
    )
    raw = generate_reset_token()
    db.add(
        PasswordResetToken(
            user_id=user_id,
            token_hash=hash_reset_token(raw),
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=RESET_TOKEN_TTL_MINUTES),
            requested_ip=requested_ip,
        )
    )
    await db.flush()
    return raw


async def consume_reset_token(db: AsyncSession, raw_token: str) -> Optional[User]:
    """校验并消费一条重置令牌：成功则返回用户并把该令牌标记为已用；失败返回 None。

    失败情形统一返回 None（不区分"不存在/过期/已用"给调用方），避免令牌探测。
    """
    token_hash = hash_reset_token(raw_token)
    row = (
        await db.execute(
            select(PasswordResetToken).where(PasswordResetToken.token_hash == token_hash)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    now = datetime.now(timezone.utc)
    if row.used_at is not None or row.expires_at <= now:
        return None
    user = (
        await db.execute(select(User).where(User.id == row.user_id))
    ).scalar_one_or_none()
    if user is None or user.status != "active":
        return None
    row.used_at = now
    await db.flush()
    return user


async def invalidate_user_reset_tokens(db: AsyncSession, user_id: int) -> None:
    """改密成功后，把该用户所有未用令牌一并作废（防旧链接重放）。"""
    await db.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user_id, PasswordResetToken.used_at.is_(None))
        .values(used_at=datetime.now(timezone.utc))
    )
    await db.flush()


def build_reset_link(raw_token: str, frontend_base_url: str) -> str:
    base = (frontend_base_url or "").rstrip("/")
    return f"{base}/reset-password?token={raw_token}"


def reset_email_html(reset_link: str) -> str:
    return (
        "<div style=\"font-family:sans-serif;max-width:520px;margin:0 auto;"
        "padding:24px;line-height:1.6\">"
        "<h2 style=\"margin:0 0 12px\">重置你的登录密码</h2>"
        "<p>我们收到了重置密码的请求。点击下面的按钮设置新密码：</p>"
        f"<p><a href=\"{reset_link}\" style=\"display:inline-block;background:#2563eb;"
        "color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px\">"
        "设置新密码</a></p>"
        f"<p style=\"word-break:break-all;font-size:13px;color:#555\">"
        f"如果按钮无法点击，请复制以下链接到浏览器打开：<br>{reset_link}</p>"
        f"<p style=\"font-size:13px;color:#888\">该链接 30 分钟内有效，且只能使用一次。"
        "若不是你本人操作，可忽略此邮件。</p>"
        "</div>"
    )


async def send_reset_email(
    *, api_key: str, from_email: str, to_email: str, reset_link: str
) -> bool:
    """经 Resend 发送重置邮件；返回是否发送成功（不抛异常给调用方）。"""
    if not api_key:
        logger.warning("password_reset_email_not_configured", to=to_email)
        return False
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                RESEND_API_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "from": from_email,
                    "to": [to_email],
                    "subject": "重置你的登录密码",
                    "html": reset_email_html(reset_link),
                    "text": f"点击以下链接设置新密码（30 分钟内有效，仅可使用一次）：\n{reset_link}",
                },
            )
            resp.raise_for_status()
        return True
    except Exception as exc:  # noqa: BLE001 - 发信失败不阻断请求，记日志
        logger.warning("password_reset_email_failed", to=to_email, error=str(exc))
        return False
