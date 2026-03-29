from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    msg_router_url: str = "http://localhost:8000"
    msg_router_api_key: str = ""

    qianniu_window_substring: str = "千牛"
    window_locate_retries: int = 15
    window_locate_interval_sec: float = 2.0
    # 为 True 时：匹配标题时不过滤 IsEnabled（部分机器上最小化/后台窗 UIA 会报 IsEnabled=False）
    window_locate_skip_enabled_filter: bool = False

    poll_interval_sec: float = 3.0
    # 纯视觉：有未读/已处理一轮后的休眠（秒），宜 <=1 以压低端到端延迟
    vision_poll_active_sec: float = 0.3  # 优化: 0.3s 快速轮询以压低端到端延迟
    # 0=按需落盘（异常必存）；1=关键事件；2=全量（等同旧版每轮截图）
    rpa_debug_level: int = 0

    # 左侧列表无未读时：是否仍轮询当前已打开会话的聊天区（易与历史气泡形成空转；默认关）
    fallback_open_chat_without_unread: bool = False
    # 无未读时的等待轮询间隔（秒），宜 >= 3
    wait_no_unread_poll_sec: float = 4.0
    # 开启兜底时：同一指纹在屏幕上停留超过该秒数则视为旧消息，不再触发 AI
    fallback_stale_fingerprint_sec: float = 30.0

    # 输入框全策略失败时保存整窗截图（相对 rpa-qianniu 工作目录）
    reply_debug_screenshots: bool = False
    reply_debug_dir: str = "debug"

    # 未读探针：启动时遍历左侧会话子树并写 debug/{ts}_unread_probe.log（见 .env DEBUG_UNREAD_PROBE）
    debug_unread_probe: bool = False
    debug_probe_dir: str = "debug"

    # 对左侧会话行截图识别红点 / 「N秒」红条，补足千牛不暴露 UIA 未读时的情况
    vision_unread_enabled: bool = True

    # PaddleOCR 锚定中间聊天列；Windows 上 Paddle 3.x+oneDNN 常不可用，默认关，见 README
    chat_ocr_enabled: bool = False
    chat_ocr_cache_sec: float = 3.0
    chat_debug_screenshots: bool = False
    chat_debug_dir: str = "data/debug_chat"
    action_delay_ms_min: int = 50   # 优化: 降低人工延迟下限
    action_delay_ms_max: int = 150  # 优化: 降低人工延迟上限，目标 <5s 端到端

    ai_http_timeout_sec: float = 10.0  # 优化: 10s 超时，快速失败以控制延迟

    # true：不调 msg-router/FastGPT，直接返回 ai_stub_reply（调千牛 UI 时省积分）
    ai_stub_mode: bool = True
    ai_stub_reply: str = "回复测试~"

    state_dir: str = "data"
    log_dir: str = "logs"
    # 将控制台 print / stderr 同步追加到 logs/console.log（与 logging 文件分流，避免混写冲突）
    log_console_tee: bool = True

    # UI 选择器 JSON（相对 rpa-qianniu 根目录）；可拷贝修改而无需改 Python
    selectors_path: str = "config/selectors.json"

    # ---------- 纯视觉流水线（CEF 内无 UIA）：截图 + OCR + 坐标点击 ----------
    use_vision_pipeline: bool = True
    # 若 True 则走旧版 UIA 混合逻辑（仅窗口内控件可访问时可用）
    legacy_uia_pipeline: bool = False

    # 窗口宽 0~1：左侧图标栏右缘（会话列表起点）| 会话列表右缘 | 聊天列右缘
    vision_left_start_ratio: float = 0.07
    vision_left_end_ratio: float = 0.15
    vision_chat_end_ratio: float = 0.56
    # 聊天列内：顶部去掉比例（买家标题栏等）、底部为输入+发送条
    vision_message_top_ratio: float = 0.15
    vision_input_bottom_ratio: float = 0.13

    vision_debug_screenshots: bool = False
    vision_debug_dir: str = "debug"
    # 主循环整窗调试图 vision_full_window 最小间隔（秒）；0=每轮都存（易刷屏占盘）
    vision_debug_full_window_interval_sec: float = 25.0
    vision_capture_settle_sec: float = 0.05  # 优化: 降低截图后稳定等待时间
    # OCR 锚点校准结果缓存（相对 rpa-qianniu 根目录）；window_size 一致时复用
    vision_calibration_path: str = "config/vision_calibration.json"
    # 为 True 时优先自动校准，失败则回退 VISION_*_RATIO
    vision_auto_calibrate: bool = True

    # 左栏：会话列表上方导航/搜索/标签高度（屏幕像素量级，用于跳过后再找红点，避免 y 偏到下一行）
    vision_left_panel_unread_top_skip_px: int = 100
    # 右栏：跳过窗口标题+千牛顶栏后，再取昵称带（与 vision_right_nick_top_frac 配合）
    vision_right_nick_top_skip_px: int = 96
    # 未读红点：连通域面积范围（像素²）
    vision_unread_dot_area_min: int = 40
    vision_unread_dot_area_max: int = 900
    # 纯视觉：同一买家会话成功回复后，多少秒内不再处理（防连点）
    vision_session_cooldown_sec: float = 30.0

    # ---------- 消息区域 OCR 配置 ----------
    # 消息区域顶部横幅跳过像素（默认 120，可通过环境变量 MSG_BANNER_SKIP_PX 覆盖）
    msg_banner_skip_px: int = 120
    # 右栏昵称 ROI：从「顶栏下缘」起占右栏总高度比例（默认 0.30）
    vision_right_nick_top_frac: float = 0.30

    # ---------- 全链路联调配置（多轮对话+日志记录） ----------
    # 会话切换后等待时间（秒）：点击待回复后等待千牛 CEF 渲染完成
    # 优化: 0.8s 快速切换，目标端到端延迟 <5s
    vision_session_switch_wait_sec: float = 0.8
    # 发送后验证开关：是否 OCR 验证回复已出现在聊天窗口
    send_verify_enabled: bool = True
    # 发送后验证等待时间（秒）：点击发送后等待消息渲染再截图验证
    send_verify_wait_sec: float = 0.8

    @property
    def state_path(self) -> Path:
        p = Path(self.state_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p / "rpa_state.json"

    @property
    def chat_endpoint(self) -> str:
        return self.msg_router_url.rstrip("/") + "/v1/chat"


settings = Settings()
