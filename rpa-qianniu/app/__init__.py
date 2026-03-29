"""千牛客服端 RPA：监听消息 → 消息路由 → 自动回复。

本项目采用函数式 API 设计，所有功能通过模块级函数暴露，不使用类实例化。
使用方式：
    from app import ai_chat, locate_main_window_once, read_latest_buyer_message
"""

# ========== OCR 模块 ==========
from app.ocr_paddle import (
    OcrTextBox,           # OCR 文本框数据类
    paddle_available,     # 检查 PaddleOCR 是否可用
    get_ocr,              # 获取 OCR 引擎
    ocr_bgr_to_boxes,     # 对 BGR 图像执行 OCR，返回文本框列表
)

# ========== AI 客户端模块 ==========
from app.ai_client import (
    chat as ai_chat,      # 调用消息路由获取 AI 回复
)

# ========== 千牛驱动模块 ==========
from app.qianniu_driver import (
    # 窗口管理
    human_delay,                      # 人性化延迟
    locate_window_title_hint,         # 定位窗口标题提示
    locate_main_window_once,            # 定位主窗口（单次）
    locate_main_window_with_retry,      # 定位主窗口（带重试）
    window_alive,                       # 检查窗口是否存活
    capture_window_frame_bgr,           # 捕获窗口帧（BGR格式）

    # 会话列表操作
    list_session_list_items,            # 列出会话列表项
    item_has_unread,                    # 检查会话项是否有未读消息
    session_display_name,               # 获取会话显示名称
    select_session,                     # 选择会话

    # 消息读取
    guess_active_buyer_title,           # 猜测当前活跃买家标题
    read_latest_buyer_message,            # 读取最新买家消息
    read_latest_buyer_message_hybrid,   # 混合方式读取最新买家消息

    # 输入控件操作
    is_blocked_non_chat_edit,           # 检查输入框是否被阻塞
    read_edit_value,                    # 读取输入框值
    find_input_control,                 # 查找输入控件
    find_input_control_relaxed,         # 宽松查找输入控件
    find_input_left_of_send,            # 查找发送按钮左侧的输入框
    find_send_button,                   # 查找发送按钮
)

# ========== 消息解析模块 ==========
from app.message_parser import (
    # 消息过滤
    is_panel_colon_stub,                # 检查是否为面板冒号残影
    is_short_buyer_keyword_noise,       # 检查是否为短关键词噪声
    has_substantive_buyer_text,         # 检查是否有实质性买家文本
    is_ocr_noise_message,               # 检查是否为 OCR 噪声消息
    is_non_message_ui_text,             # 检查是否为非消息 UI 文本
    is_system_message,                  # 检查是否为系统消息

    # 工具函数
    extract_time_token,                 # 提取时间标记
    extract_date_time_hints,            # 提取日期时间提示
    normalize_buyer_id,                 # 规范化买家 ID
    fingerprint_key,                  # 生成消息指纹键
)

# 显式声明公开 API
__all__ = [
    # OCR
    "OcrTextBox",
    "paddle_available",
    "get_ocr",
    "ocr_bgr_to_boxes",

    # AI
    "ai_chat",

    # 窗口管理
    "human_delay",
    "locate_window_title_hint",
    "locate_main_window_once",
    "locate_main_window_with_retry",
    "window_alive",
    "capture_window_frame_bgr",

    # 会话列表
    "list_session_list_items",
    "item_has_unread",
    "session_display_name",
    "select_session",

    # 消息读取
    "guess_active_buyer_title",
    "read_latest_buyer_message",
    "read_latest_buyer_message_hybrid",

    # 输入控件
    "is_blocked_non_chat_edit",
    "read_edit_value",
    "find_input_control",
    "find_input_control_relaxed",
    "find_input_left_of_send",
    "find_send_button",

    # 消息解析
    "is_panel_colon_stub",
    "is_short_buyer_keyword_noise",
    "has_substantive_buyer_text",
    "is_ocr_noise_message",
    "is_non_message_ui_text",
    "is_system_message",
    "extract_time_token",
    "extract_date_time_hints",
    "normalize_buyer_id",
    "fingerprint_key",
]
