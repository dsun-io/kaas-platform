# rpa-qianniu

本地 Windows 上千牛客服端 RPA：**监听未读会话 → 调用消息路由（msg-router）→ 自动粘贴并发送回复**。思路接近「Dify + 千牛」类项目：轮询 UI、HTTP 调用大模型服务、再驱动客户端发送。

## 环境

- Windows 10/11，已安装并登录 **千牛客服端**
- Python 3.11+
- 本机已启动消息路由：`http://localhost:8000`（`msg-router`）

## 安装

```bat
cd rpa-qianniu
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

按需编辑 `.env`：

- `QIANNIU_WINDOW_SUBSTRING`：当 `config/selectors.json` 里 `window_title_substrings` 为空时，用作唯一标题子串
- `SELECTORS_PATH`：选择器文件路径，默认 `config/selectors.json`
- `MSG_ROUTER_URL`：默认 `http://localhost:8000`
- `MSG_ROUTER_API_KEY`：当前 msg-router 未强制鉴权，可留空；若后续加 Bearer，填 Token

## 运行

在项目根目录执行（保证能加载包 `app`）：

```bat
python -m app.main
```

或双击 `start.bat`。

启动成功应看到：`千牛窗口已定位，开始监听`，随后每条消息会打印 `[收到]` / `[AI回复]` / `[已发送]`。

## 行为说明

| 模块 | 作用 |
|------|------|
| `qianniu_driver.py` | uiautomation 定位主窗口、左侧 `ListItem` 未读、点选会话、从左侧气泡读文本、找输入框/发送按钮（参数来自 `ui_selectors`） |
| `ui_selectors.py` + `config/selectors.json` | 将标题子串、未读标记、左栏比例、发送按钮关键词等外置，便于随千牛改版调配置 |
| `message_parser.py` | 系统消息关键词过滤；从文本末尾提取 `HH:mm` 参与去重指纹 |
| `ai_client.py` | `POST /v1/chat`，超时 15s，失败返回固定兜底话术 |
| `reply_sender.py` | 剪贴板 + Ctrl+V 输入中文，再点「发送」或回车 |
| `main.py` | 约 2s 轮询；**同一时刻只处理一个未读会话**；`data/rpa_state.json` 持久化 `conversation_id` 与去重键 |

## UI 选择器（推荐先改这里）

`config/selectors.json` 控制大部分「找窗口 / 找未读 / 找发送键」的启发式参数，**千牛小改版时通常只需改 JSON**，不必改 Python。

| 字段 | 含义 |
|------|------|
| `window_title_substrings` | 标题需 **命中任一** 子串；空数组则回退 `.env` 的 `QIANNIU_WINDOW_SUBSTRING` |
| `session_left_panel_ratio` | 左侧会话列表约占窗口宽度比例（0–1），用于过滤非左侧的 `ListItem` |
| `unread_markers` | 未读标记文案列表，子控件 `Name` **包含任一** 即视为未读 |
| `buyer_bubble_offset_px` | 买家气泡相对窗口中线向左偏移阈值（越大越「宽」） |
| `input_bottom_margin_px` / `input_pool_bottom_margin_px` | 输入框相对窗口底部的判定范围 |
| `tree_walk_max_depth` | 遍历控件树最大深度（过深变慢，过浅可能漏控件） |
| `send_button_include_substrings` / `send_button_exclude_substrings` | 发送按钮名称需包含 / 需排除的子串 |

**说明**：配置化提升的是 **可维护性与试错成本**（改文件即可多试几组规则），**不能**保证千牛大改版后仍零改动；若控件树完全换型，仍可能要改 `qianniu_driver.py` 或引入图像/OCR。

## UI 自动化限制（必读）

千牛版本、皮肤、分辨率不同，**控件树会变化**。若调 JSON 仍无法识别：

1. 用 **Inspect** / **Accessibility Insights** 看真实 `Name`、`ControlType`。
2. 优先调整 `selectors.json` 中 `unread_markers`、`session_left_panel_ratio`、`send_button_*`。
3. 仅当结构完全不符时，再改 `qianniu_driver.py` 或加图像模板等方案。

未读检测默认依赖文案标记；若你版本只有图标无文字，需扩展检测逻辑或改用图像识别。

## 验收对照

- 控制台出现 **「千牛窗口已定位，开始监听」**
- 淘宝买家发消息后，在路由与 FastGPT 正常时，数秒内自动回复
- 多轮对话：`data/rpa_state.json` 中按 `buyer_id` 保存 `conversation_id`，可连续多轮
- 命中 `message_parser` 中系统关键词的消息 **不会** 调 AI

## 日志

`logs/rpa-qianniu.log`，按天轮转，保留约 14 天。

## 与 msg-router 的衔接

请求体：`platform=qianniu`，`buyer_id` 为会话列表显示名（规范化空格），`message` 为当前解析到的文本，`conversation_id` 来自本地状态文件。
