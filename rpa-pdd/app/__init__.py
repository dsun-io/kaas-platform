"""拼多多客服工作台 RPA（Playwright headed）。

本项目采用函数式 API 设计，所有功能通过模块级函数暴露，不使用类实例化。
使用方式：
    from app import ai_chat, select_first_unread_session, send_reply
"""

# ========== 拼多多驱动模块 ==========
from app.pdd_driver import (
    human_delay,                      # 人性化延迟
    select_first_unread_session,      # 选择第一个未读会话
    read_latest_buyer_message_from_dom,  # 从 DOM 读取最新买家消息
    send_reply,                       # 发送回复
    selectors_configured_for_automation,  # 检查选择器是否配置为自动化
)

# ========== 登录处理模块 ==========
from app.login_handler import (
    needs_relogin,                    # 检查是否需要重新登录
    ensure_logged_in,               # 确保已登录
)

# ========== AI 客户端模块 ==========
from app.ai_client import (
    chat as ai_chat,                  # 调用消息路由获取 AI 回复
)

# 显式声明公开 API
__all__ = [
    # PDD 驱动
    "human_delay",
    "select_first_unread_session",
    "read_latest_buyer_message_from_dom",
    "send_reply",
    "selectors_configured_for_automation",

    # 登录处理
    "needs_relogin",
    "ensure_logged_in",

    # AI
    "ai_chat",
]
