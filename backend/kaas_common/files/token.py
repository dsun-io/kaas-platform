"""短期资源令牌（渲染图片直链用）—— 纯标准库，orchestrator / Worker 共用一份。

为什么需要
----------
A4（2026-10-21，用户选「渲染器走 R2 直链」）：单证装配层原先把产品图/公章
**内联成 data URI** 进渲染数据（一张 PI ≈1.4MB）。改为给渲染器一个**短期签名 URL**：
- 渲染器的图片白名单只认 `data:` 与 `http(s)`（防注入），所以 URL 必须是绝对地址；
- 浏览器 `<img>` 不能带 `Authorization` 头 ⇒ 用**查询串令牌**授权；
- 令牌只绑定「用途 + 资源 id + 过期时间」，由 `JWT_SECRET`（Worker 请求期绑定）签名，
  不新增密钥；TTL 默认 900s（与 S3 预签名同量级）。

信任边界（与预签名 URL 同口径）
--------------------------------
拿到 URL 的人可在 TTL 内读取该资源；URL 只在**已授权用户请求渲染数据时**签发，
不落库、不进日志。超出 TTL 需重新请求渲染数据。

纯函数、零三方依赖 ⇒ Pyodide 可加载；`now` 参数注入便于测试。
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional, Union

__all__ = [
    "DEFAULT_ASSET_TTL",
    "make_asset_token",
    "verify_asset_token",
]

DEFAULT_ASSET_TTL = 900

_RefId = Union[int, str]


def _sign(secret: str, purpose: str, ref_id: _RefId, exp: int) -> str:
    msg = f"{purpose}:{ref_id}:{exp}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def make_asset_token(
    secret: str,
    purpose: str,
    ref_id: _RefId,
    *,
    ttl: int = DEFAULT_ASSET_TTL,
    now: Optional[float] = None,
) -> str:
    """签发 `<exp>.<hmac>` 令牌；`secret` 为空时抛 ValueError（调用方应回退内联）。"""
    if not secret:
        raise ValueError("asset token 需要非空 secret")
    current = time.time() if now is None else now
    exp = int(current) + max(1, int(ttl))
    return f"{exp}.{_sign(secret, purpose, ref_id, exp)}"


def verify_asset_token(
    secret: str,
    purpose: str,
    ref_id: _RefId,
    token: str,
    *,
    now: Optional[float] = None,
) -> bool:
    """校验令牌：格式 / 过期 / 用途+资源绑定 / 常量时间签名比较。"""
    if not secret or not token or "." not in token:
        return False
    exp_raw, sig = token.split(".", 1)
    try:
        exp = int(exp_raw)
    except ValueError:
        return False
    current = int(time.time() if now is None else now)
    if exp < current:
        return False
    expected = _sign(secret, purpose, ref_id, exp)
    return hmac.compare_digest(expected, sig)
