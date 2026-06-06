# 拼多多 RPA 公开 API 文档

> **设计说明**：本项目采用函数式 API 设计，所有功能通过模块级函数暴露，不使用类实例化。

## 快速开始

```python
from app import (
    ai_chat,                    # 获取 AI 回复
    select_first_unread_session,  # 选择第一个未读会话
    read_latest_buyer_message_from_dom,  # 读取买家消息
    send_reply,                 # 发送回复
    ensure_logged_in,           # 确保登录状态
)

# 1. 确保登录
from app.browser_manager import BrowserManager
bm = BrowserManager()
page = bm.new_page()
ensure_logged_in(bm, page)

# 2. 选择未读会话
buyer_label = select_first_unread_session(page)

# 3. 读取消息
buyer_id, message = read_latest_buyer_message_from_dom(page)

# 4. 获取 AI 回复
reply, conv_id, elapsed, error = ai_chat(
    buyer_id=buyer_id,
    message=message,
    conversation_id=None,
)

# 5. 发送回复
send_reply(page, reply)
```

---

## PDD 驱动模块 (app.pdd_driver)

### `human_delay() -> None`
执行人性化随机延迟（基于配置）。

---

### `select_first_unread_session(page: Page) -> str | None`
点击第一个未读会话，返回用于 buyer_id 的展示名。

**参数**:
- `page`: Playwright Page 对象

**返回**: 会话标签字符串，如果没有未读会话返回 `None`。

**说明**: 需在 `config/selectors.json` 配置 `session_item_unread` 或 `session_item`。

---

### `read_latest_buyer_message_from_dom(page: Page) -> tuple[str | None, str | None]`
从 DOM 读取最新买家消息。

**参数**:
- `page`: Playwright Page 对象

**返回**: `(buyer_id, message)`，任一可能为 `None`。

---

### `send_reply(page: Page, body: str) -> bool`
发送回复消息。

**参数**:
- `page`: Playwright Page 对象
- `body`: 回复内容

**返回**: `True` 发送成功，`False` 失败。

---

### `selectors_configured_for_automation() -> bool`
检查选择器是否已配置为支持自动化。

**返回**: `True` 如果选择器配置完整。

---

## 登录处理模块 (app.login_handler)

### `needs_relogin(page: Page) -> bool`
检查页面是否需要重新登录。

**参数**:
- `page`: Playwright Page 对象

**返回**: `True` 如果需要登录（页面关闭或处于登录页）。

---

### `ensure_logged_in(bm: BrowserManager, page: Page) -> None`
确保浏览器已登录拼多多客服工作台。

**参数**:
- `bm`: BrowserManager 实例
- `page`: Playwright Page 对象

**行为**:
1. 打开客服页 `PDD_CHAT_URL`
2. 检查 `chat_ready_selector` 是否存在
3. 如需要登录，提示用户在浏览器中扫码/登录
4. 登录成功后保存 storage_state

**异常**: 导航超时或登录确认超时抛出 RuntimeError。

---

## AI 客户端模块 (app.ai_client)

### `chat(*, buyer_id: str, message: str, conversation_id: str | None) -> tuple[str, str | None, int, str | None]`
调用消息路由获取 AI 回复。

**参数**:
- `buyer_id`: 买家 ID
- `message`: 买家消息内容
- `conversation_id`: 会话 ID（可选，用于多轮对话）

**返回**: `(reply, conversation_id, elapsed_ms, error)`
- `reply`: AI 回复文本（失败时返回兜底话术）
- `conversation_id`: 新的或保持的会话 ID
- `elapsed_ms`: 请求耗时（毫秒）
- `error`: 错误信息（`None` 表示成功）

**别名**: `ai_chat`

```python
from app import ai_chat
reply, conv_id, elapsed, error = ai_chat(
    buyer_id="pdd_buyer_001",
    message="这个有货吗？",
    conversation_id=None,
)
if error:
    print(f"AI 请求失败: {error}")
```

---

## 浏览器管理模块 (app.browser_manager)

> **注**: BrowserManager 是一个类，用于管理 Playwright 浏览器生命周期。

### `BrowserManager`
浏览器管理器类。

```python
from app.browser_manager import BrowserManager

bm = BrowserManager()
page = bm.new_page()
# ... 使用 page 进行自动化操作
bm.close()  # 关闭浏览器
```

### 主要方法

#### `new_page() -> Page`
创建新页面并应用 storage_state（如果存在）。

**返回**: Playwright Page 对象。

---

#### `save_storage() -> None`
保存当前浏览器状态到文件（用于保持登录态）。

---

#### `close() -> None`
关闭浏览器并清理资源。

---

#### `screenshot_on_error(page: Page, label: str) -> None`
出错时自动截图（辅助调试）。

---

## 消息监听模块 (app.message_listener)

### `extract_time_token(text: str) -> str | None`
从文本中提取时间标记（用于消息识别）。

**返回**: 时间字符串或 `None`。

---

## 导入汇总

### 推荐导入方式

```python
# 方式 1: 从 app 包导入（推荐）
from app import (
    ai_chat,
    select_first_unread_session,
    read_latest_buyer_message_from_dom,
    send_reply,
    needs_relogin,
    ensure_logged_in,
)

# 方式 2: 从具体模块导入
from app.pdd_driver import select_first_unread_session, send_reply
from app.ai_client import chat as ai_chat
from app.browser_manager import BrowserManager
```

### 完整公开 API 列表

```python
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
```

---

## 配置说明

本项目依赖 `config/settings.yaml` 和 `config/selectors.json` 进行配置。

### 关键配置项

```yaml
# settings.yaml
pdd_chat_url: "https://..."              # 拼多多客服页 URL
action_delay_ms_min: 300                  # 操作最小延迟（毫秒）
action_delay_ms_max: 800                  # 操作最大延迟（毫秒）
action_max_retries: 3                     # 操作重试次数
login_nav_timeout_ms: 30000               # 登录导航超时（毫秒）
login_console_wait_timeout_sec: 300       # 控制台等待登录超时（秒）
ai_http_timeout_sec: 30                   # AI 请求超时（秒）
chat_endpoint: "http://localhost:8000/v1/chat"  # 消息路由端点
```

```json
// selectors.json
{
  "session_item_unread": "...",          // 未读会话项选择器
  "session_item": "...",                  // 会话项选择器
  "login_page_url_contains": "...",       // 登录页 URL 特征
  "login_form_selector": "...",           // 登录表单选择器
  "chat_ready_selector": "..."           // 聊天就绪指示器
}
```
