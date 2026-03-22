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

    poll_interval_sec: float = 3.0

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
    action_delay_ms_min: int = 200
    action_delay_ms_max: int = 500

    ai_http_timeout_sec: float = 15.0

    # true：不调 msg-router/FastGPT，直接返回 ai_stub_reply（调千牛 UI 时省积分）
    ai_stub_mode: bool = True
    ai_stub_reply: str = "回复测试~"

    state_dir: str = "data"
    log_dir: str = "logs"

    # UI 选择器 JSON（相对 rpa-qianniu 根目录）；可拷贝修改而无需改 Python
    selectors_path: str = "config/selectors.json"

    @property
    def state_path(self) -> Path:
        p = Path(self.state_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p / "rpa_state.json"

    @property
    def chat_endpoint(self) -> str:
        return self.msg_router_url.rstrip("/") + "/v1/chat"


settings = Settings()
