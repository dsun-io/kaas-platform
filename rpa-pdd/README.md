# rpa-pdd

拼多多 **客服工作台（网页）** RPA：Playwright **有头** 打开后台 → 维持登录态 → 监听新消息 → 调用本地消息路由 `POST /v1/chat`（`platform=pdd`）→ 自动发送回复。

## 环境

- Windows 10/11，Python 3.11+
- 本机已启动 **msg-router**：`http://localhost:8000`
- 已安装 Chromium 内核（见下方 `playwright install`）

## 安装

```bat
cd rpa-pdd
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
copy .env.example .env
```

## 配置

1. **`.env`**
   - `PDD_CHAT_URL`：登录后实际 **客服聊天页** 的完整 URL（以你商家后台为准）。
   - `PLAYWRIGHT_HEADLESS=false`：本地调试有头；上云改为 `true`。
   - `MSG_ROUTER_URL`：默认 `http://localhost:8000`。

2. **`config/selectors.json`（必配）**  
   拼多多前端会改版，**无法用通用硬编码选择器**。请在浏览器开发者工具中查看 DOM，优先使用 **`data-testid`** 或稳定语义节点，填入：

   | 字段 | 用途 |
   |------|------|
   | `chat_ready_selector` | 已进入工作台聊天界面的标志（可见元素） |
   | `login_form_selector` | 登录表单/扫码容器（用于判断是否掉线） |
   | `login_page_url_contains` | URL 子串，如 `login`；**留空则仅用表单选择器判断**，减少误判 |
   | `session_item_unread` | **优先**：未读会话项（可直接点的节点） |
   | `session_list` + `session_item` | **兜底**：会话列表根 + 单项；脚本会尝试找带 unread/badge 子节点的项 |
   | `message_list` + `buyer_message_row` | 消息列表 + 买家消息行（`last` 取最新） |
   | `buyer_message_text` | 若上一行难配，可改为直接指向买家消息文本节点 |
   | `input_editor` | 输入框 |
   | `send_button` | 发送按钮 |

3. **登录态**  
   使用 Playwright `storage_state` 写入 `data/cookies.json`（含 Cookie 与部分站点状态）。首次运行按控制台提示扫码/登录。

## 运行

**必须在 `rpa-pdd` 根目录** 执行模块方式（否则 `import app` 失败）：

```bat
python -m app.main
```

或双击 `start.bat`。

## 行为说明

| 模块 | 作用 |
|------|------|
| `browser_manager.py` | Chromium 启动（默认 headed）、viewport、UA、读写 `data/cookies.json`、异常时可重启 |
| `login_handler.py` | 首次/失效时引导登录并保存 `storage_state` |
| `message_listener.py` | **方案 A**：`WebSocket` `framereceived` 解析 JSON 中疑似文本（日志辅助）；**方案 B**：主循环按 `DOM_POLL_INTERVAL_SEC` 轮询 DOM |
| `pdd_driver.py` | 点未读会话、读最新消息、输入发送；操作带 **200–500ms 随机延迟** 与 **重试** |
| `ai_client.py` | `POST /v1/chat`，`platform=pdd`，超时见 `.env` |
| `main.py` | 主循环；`data/pdd_state.json` 保存 `conversation_id` 与去重键 |

## 调试

- 有头模式可直接观察点击与输入。
- 异常时自动截图到 **`screenshots/`**（文件名带场景标签）。
- 控制台输出：`[收到]` / `[AI回复]` / `[已发送]`；完整日志见 `logs/rpa-pdd.log`。

## 验收对照

- 启动后浏览器打开拼多多商家相关页面；首次手动登录，之后自动恢复会话。
- 买家发消息后，在路由与 FastGPT 正常时自动回复（依赖你选择器配置正确）。
- 多轮对话：`data/pdd_state.json` 按买家维度保存 `conversation_id`。
- Cookie 失效：检测到登录页/登录控件后提示重新登录并再次保存状态。

## 与千牛 RPA 的差异

| 项 | 千牛 `rpa-qianniu` | 拼多多 `rpa-pdd` |
|----|-------------------|------------------|
| 载体 | 桌面客户端 + uiautomation | 网页 + Playwright |
| 调试 | 桌面 Inspect | DevTools + headed |
| 登录 | 系统层窗口 | Cookie / storage_state |
