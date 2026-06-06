import secrets


def ensure_conversation_id(client_provided: str | None) -> str:
    """
    确保生成有效的 conversation_id。

    支持平台前缀格式：qn_xxx, pdd_xxx 等
    """
    if client_provided and client_provided.strip():
        return client_provided.strip()
    return f"conv_{secrets.token_hex(16)}"


def parse_session_id(session_id: str) -> tuple[str, str]:
    """
    解析跨平台 session_id。

    格式: {platform}_{buyer_id}

    Args:
        session_id: 如 "qn_buyer123", "pdd_buyer456"

    Returns:
        (platform, buyer_id)

    Raises:
        ValueError: 格式不正确
    """
    parts = session_id.split("_", 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid session_id format: {session_id}")
    return parts[0], parts[1]


def make_session_id(platform: str, buyer_id: str) -> str:
    """
    生成跨平台唯一的 session_id。

    Args:
        platform: 平台标识，如 "qianniu", "pdd"
        buyer_id: 买家 ID

    Returns:
        带前缀的 session_id，如 "qn_buyer123"
    """
    # 平台前缀映射（可选的短格式）
    platform_abbr = {
        "qianniu": "qn",
        "pdd": "pdd",
        "douyin": "dy",
        "weixin": "wx",
        "xiaohongshu": "xhs",
    }
    prefix = platform_abbr.get(platform, platform)
    return f"{prefix}_{buyer_id}"


def is_valid_session_id(session_id: str) -> bool:
    """检查 session_id 格式是否有效。"""
    if not session_id or "_" not in session_id:
        return False
    try:
        parse_session_id(session_id)
        return True
    except ValueError:
        return False
