# 千牛 RPA 公开 API 文档

> **设计说明**：本项目采用函数式 API 设计，所有功能通过模块级函数暴露，不使用类实例化。

## 快速开始

```python
from app import (
    ai_chat,                    # 获取 AI 回复
    locate_main_window_once,    # 定位千牛主窗口
    read_latest_buyer_message,  # 读取买家最新消息
    find_input_control,         # 查找输入框
    find_send_button,           # 查找发送按钮
)

# 1. 定位窗口
win = locate_main_window_once()

# 2. 读取消息
buyer_id, message = read_latest_buyer_message(win)

# 3. 获取 AI 回复
reply, conv_id, elapsed, error = ai_chat(
    buyer_id=buyer_id,
    message=message,
    conversation_id=None,
)

# 4. 发送回复
edit = find_input_control(win)
# ... 使用 pyautogui 输入文本并点击发送按钮
```

---

## OCR 模块 (app.ocr_paddle)

### `OcrTextBox` (dataclass)
OCR 识别的文本框数据结构。

```python
@dataclass(frozen=True)
class OcrTextBox:
    text: str           # 识别文本
    confidence: float   # 置信度 (0-1)
    left: int           # 左边界 x
    top: int            # 上边界 y
    right: int          # 右边界 x
    bottom: int         # 下边界 y
```

### `paddle_available() -> bool`
检查 PaddleOCR 是否可用。

**返回**: `True` 如果 PaddleOCR 已安装并可使用。

---

### `get_ocr() -> Any`
获取或初始化 OCR 引擎（懒加载 + 单例）。

**返回**: PaddleOCR 引擎实例。

---

### `ocr_bgr_to_boxes(img_bgr: np.ndarray, region_hint: tuple | None = None) -> list[OcrTextBox]`
对 BGR 图像执行 OCR，返回文本框列表。

**参数**:
- `img_bgr`: BGR 格式的 numpy 图像数组
- `region_hint`: 可选的区域提示 (x, y, w, h)

**返回**: `OcrTextBox` 列表。

---

## AI 客户端模块 (app.ai_client)

### `chat(*, buyer_id: str, message: str, conversation_id: str | None) -> tuple[str, str | None, int, str | None]`
调用消息路由获取 AI 回复。

**参数**:
- `buyer_id`: 买家 ID
- `message`: 买家消息内容
- `conversation_id`: 会话 ID（可选，用于多轮对话）

**返回**: `(reply, conversation_id, elapsed_ms, error)`
- `reply`: AI 回复文本
- `conversation_id`: 新的或保持的会话 ID
- `elapsed_ms`: 请求耗时（毫秒）
- `error`: 错误信息（`None` 表示成功）

**别名**: `ai_chat`

```python
from app import ai_chat
reply, conv_id, elapsed, error = ai_chat(
    buyer_id="buyer_001",
    message="这个多少钱？",
    conversation_id=None,
)
```

---

## 千牛驱动模块 (app.qianniu_driver)

### 窗口管理

#### `human_delay() -> None`
执行人性化随机延迟（基于配置）。

---

#### `locate_window_title_hint() -> str`
获取当前检测到的千牛窗口标题提示。

**返回**: 窗口标题字符串或空字符串。

---

#### `locate_main_window_once() -> Control | None`
单次尝试定位千牛主窗口。

**返回**: UIA Control 对象或 `None`。

---

#### `locate_main_window_with_retry(max_attempts: int = 3, delay_sec: float = 1.0) -> Control | None`
带重试机制的千牛主窗口定位。

**参数**:
- `max_attempts`: 最大尝试次数（默认 3）
- `delay_sec`: 重试间隔秒数（默认 1.0）

**返回**: UIA Control 对象或 `None`。

---

#### `window_alive(win: Control | None) -> bool`
检查窗口是否仍然存活。

**参数**:
- `win`: 窗口 Control 对象

**返回**: `True` 如果窗口存活。

---

#### `capture_window_frame_bgr(win: Control) -> np.ndarray | None`
捕获窗口当前帧（BGR 格式）。

**参数**:
- `win`: 窗口 Control 对象

**返回**: BGR 图像数组或 `None`。

---

### 会话列表操作

#### `list_session_list_items(win: Control) -> list[Control]`
列出千牛会话列表中的所有会话项。

**参数**:
- `win`: 千牛主窗口 Control

**返回**: 会话项 Control 列表。

---

#### `item_has_unread(item: Control, win: Control | None = None) -> bool`
检查会话项是否有未读消息。

**参数**:
- `item`: 会话项 Control
- `win`: 主窗口 Control（可选，用于视觉检测）

**返回**: `True` 如果有未读消息。

---

#### `session_display_name(item: Control) -> str`
获取会话项的显示名称。

**参数**:
- `item`: 会话项 Control

**返回**: 显示名称字符串。

---

#### `select_session(item: Control) -> None`
点击选择一个会话。

**参数**:
- `item`: 会话项 Control

---

### 消息读取

#### `guess_active_buyer_title(win: Control) -> str`
尝试猜测当前活跃买家的标题/昵称。

**参数**:
- `win`: 千牛主窗口 Control

**返回**: 买家标题字符串，失败返回 `""`。

---

#### `read_latest_buyer_message(win: Control, recent_sec: float = 90.0) -> tuple[str | None, str | None]`
读取最新的买家消息。

**参数**:
- `win`: 千牛主窗口 Control
- `recent_sec`: 只读取最近 N 秒内的消息（默认 90）

**返回**: `(buyer_id, message)`，任一可能为 `None`。

---

#### `read_latest_buyer_message_hybrid(win: Control, recent_sec: float = 90.0) -> tuple[str | None, str | None]`
混合方式（UIA + OCR）读取最新买家消息。

**参数**: 同 `read_latest_buyer_message`

**返回**: 同 `read_latest_buyer_message`

---

### 输入控件操作

#### `is_blocked_non_chat_edit(edit: Control) -> bool`
检查输入框是否属于非聊天区域的被阻塞输入框。

**参数**:
- `edit`: 输入框 Control

**返回**: `True` 如果被阻塞。

---

#### `read_edit_value(ctrl: Control) -> str`
读取输入框的当前值。

**参数**:
- `ctrl`: 输入框 Control

**返回**: 文本内容。

---

#### `find_input_control(win: Control, prefer_empty: bool = True) -> Control | None`
查找聊天输入框控件。

**参数**:
- `win`: 千牛主窗口
- `prefer_empty`: 是否优先选择空输入框

**返回**: 输入框 Control 或 `None`。

---

#### `find_input_control_relaxed(win: Control, prefer_empty: bool = True) -> Control | None`
宽松策略查找聊天输入框（容错更强）。

**参数**: 同 `find_input_control`

**返回**: 同 `find_input_control`

---

#### `find_input_left_of_send(win: Control, prefer_empty: bool = True) -> Control | None`
查找发送按钮左侧的输入框。

**参数**:
- `win`: 千牛主窗口
- `prefer_empty`: 是否优先选择空输入框

**返回**: 输入框 Control 或 `None`。

---

#### `find_send_button(win: Control) -> Control | None`
查找发送按钮。

**参数**:
- `win`: 千牛主窗口

**返回**: 发送按钮 Control 或 `None`。

---

## 消息解析模块 (app.message_parser)

### 消息过滤

#### `is_panel_colon_stub(text: str) -> bool`
检查文本是否为面板冒号残影（非真实消息）。

---

#### `is_short_buyer_keyword_noise(text: str) -> bool`
检查是否为短关键词噪声（非实质性内容）。

---

#### `has_substantive_buyer_text(text: str) -> bool`
检查文本是否包含实质性的买家内容。

---

#### `is_ocr_noise_message(text: str) -> bool`
检查是否为 OCR 识别的噪声消息。

---

#### `is_non_message_ui_text(text: str) -> bool`
检查是否为 UI 标签文本（非聊天消息）。

---

#### `is_system_message(text: str) -> bool`
检查是否为系统消息（如订单通知、物流信息等）。

---

### 工具函数

#### `extract_time_token(text: str) -> str | None`
从文本中提取时间标记（如"12:34"）。

**返回**: 时间字符串或 `None`。

---

#### `extract_date_time_hints(text: str) -> str`
提取文本中的日期/时间提示信息。

**返回**: 日期时间字符串。

---

#### `normalize_buyer_id(raw: str) -> str`
规范化买家 ID，去除噪声字符。

**参数**:
- `raw`: 原始买家 ID 字符串

**返回**: 规范化后的 ID。

---

#### `fingerprint_key(buyer_id: str, message: str) -> str`
生成消息的指纹键（用于去重）。

**参数**:
- `buyer_id`: 买家 ID
- `message`: 消息内容

**返回**: 指纹键字符串。

---

## 导入汇总

### 推荐导入方式

```python
# 方式 1: 从 app 包导入（推荐）
from app import ai_chat, locate_main_window_once, send_reply

# 方式 2: 从具体模块导入
from app.qianniu_driver import locate_main_window_once, read_latest_buyer_message
from app.ai_client import chat as ai_chat
from app.ocr_paddle import OcrTextBox, paddle_available
```

### 完整公开 API 列表

```python
__all__ = [
    # OCR
    "OcrTextBox", "paddle_available", "get_ocr", "ocr_bgr_to_boxes",

    # AI
    "ai_chat",

    # 窗口管理
    "human_delay", "locate_window_title_hint", "locate_main_window_once",
    "locate_main_window_with_retry", "window_alive", "capture_window_frame_bgr",

    # 会话列表
    "list_session_list_items", "item_has_unread", "session_display_name", "select_session",

    # 消息读取
    "guess_active_buyer_title", "read_latest_buyer_message", "read_latest_buyer_message_hybrid",

    # 输入控件
    "is_blocked_non_chat_edit", "read_edit_value", "find_input_control",
    "find_input_control_relaxed", "find_input_left_of_send", "find_send_button",

    # 消息解析
    "is_panel_colon_stub", "is_short_buyer_keyword_noise", "has_substantive_buyer_text",
    "is_ocr_noise_message", "is_non_message_ui_text", "is_system_message",
    "extract_time_token", "extract_date_time_hints", "normalize_buyer_id", "fingerprint_key",
]
```
