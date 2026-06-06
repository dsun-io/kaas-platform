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

安装 **paddleocr** 时可能会顺带安装 `opencv-contrib-python`，与已有的 `opencv-python-headless` 并存时或出现 `cv2` 冲突；若导入报错，可在专用 venv 中只装本目录依赖，或暂时关闭 `CHAT_OCR_ENABLED=false`。
copy .env.example .env
```

按需编辑 `.env`：

- **`AI_STUB_MODE`**：默认 `true`（代码默认）时 **不请求 msg-router/FastGPT**，只回固定句 **`AI_STUB_REPLY`**（默认 `回复测试~`），专用于先把千牛发消息调通；要接真实 AI 时设为 **`false`**
- `QIANNIU_WINDOW_SUBSTRING`：当 `config/selectors.json` 里 `window_title_substrings` 为空时，用作唯一标题子串
- `SELECTORS_PATH`：选择器文件路径，默认 `config/selectors.json`
- `MSG_ROUTER_URL`：默认 `http://localhost:8000`
- `MSG_ROUTER_API_KEY`：当前 msg-router 未强制鉴权，可留空；若后续加 Bearer，填 Token
- **`VISION_UNREAD_ENABLED`**：默认 `true`，启用左侧列表**视觉未读**（依赖 `opencv-python-headless`、`numpy`、`Pillow`）；若截图坐标与 DPI 不匹配可改为 `false` 仅用 UIA
- **`CHAT_OCR_ENABLED`**：默认 **`false`**（多数 Windows + **PaddlePaddle 3.x** 在 oneDNN 上会 `NotImplementedError`，首次推理失败时代码会打 `CRITICAL` 并自动停用 OCR 推理，仅保留 UIA + 几何默认面板）。若你环境 OCR 正常，可改为 `true` 启用锚定盒与底部条校验。
- **`CHAT_OCR_CACHE_SEC`**：同一买家、同一张截图指纹下 OCR 结果复用时长（默认 3）
- **`CHAT_DEBUG_SCREENSHOTS`** / **`CHAT_DEBUG_DIR`**：为 `true` 时在 `data/debug_chat`（可改）保存锚定用整窗截图，便于对照 OCR

## 运行

在项目根目录执行（保证能加载包 `app`）：

```bat
python -m app.main
```

或双击 `start.bat`（会弹独立黑窗，便于看到 `[收到]` 等输出）。

**读消息过滤单测**（改 `message_parser` 后建议跑）：

```bat
cd rpa-qianniu
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
```

**说明**：若在 Cursor 内置终端里以后台方式跑，窗口缩在编辑器里不容易注意到；联调时建议用 **`start.bat` 或单独开 PowerShell** 跑，并保持该窗口不要关。

启动成功应看到：`千牛窗口已定位，开始监听`，随后每条消息会打印 `[收到]` / `[AI回复]` / `[已发送]`。

**F12**：全局 **暂停 / 继续** 自动回复（不退出进程）；依赖 `pynput`，已写入 `requirements.txt`。若热键无效，可尝试以管理员运行 CMD，或先关掉占用全局快捷键的软件。

**商品搜索等浮层**：会抢走输入焦点；运行自动回复时请 **关闭或不要打开** 居中「商品搜索」弹窗，否则容易误打到搜索框。

## 行为说明

| 模块 | 作用 |
|------|------|
| `qianniu_driver.py` | uiautomation 定位主窗口、左侧 `ListItem` 未读、点选会话、从左侧气泡读文本、找输入框/发送按钮（参数来自 `ui_selectors`）；可与 **`vision_markers` 截图识别** 组合（见下） |
| `vision_markers.py` + `window_capture.py` | 对整窗截图后，在**每个会话行**子图内识别头像区**红点**与名称旁**红/珊瑚色「N秒」条**（HSV + 轮廓），补足 UIA 不暴露未读节点的情况 |
| `ocr_paddle.py` + `chat_bounds.py` + `chat_read.py` + `chat_ocr_flow.py` | **三层机制中的「视觉锚定」**：`PaddleOCR` 识别底栏「发送」等锚点 → 计算中间**聊天列屏幕包围盒**；读消息优先在盒内 OCR（左侧、自下而上过滤），UIA 读气泡亦受同一盒约束；`reply_sender` 仅在盒内选 Edit/发送键，并用**底部条二次 OCR** 校验正文未误入搜索框；连续验证失败会 `CRITICAL` 日志。依赖 `paddleocr`/`paddlepaddle`（体积大，可 `CHAT_OCR_ENABLED=false` 关闭） |
| `ui_selectors.py` + `config/selectors.json` | 将标题子串、未读标记、左栏比例、发送按钮关键词等外置，便于随千牛改版调配置 |
| `message_parser.py` | 系统消息过滤；占位文案（如「双方输入中」）忽略；**须有汉字/字母/数字等实质内容**才触发 AI；`HH:mm` 去重 |
| `hotkeys.py` | **F12** 暂停/继续（`threading.Event`） |
| `ai_client.py` | `POST /v1/chat`，超时 15s，失败返回固定兜底话术 |
| `reply_sender.py` | 剪贴板 + Ctrl+V 输入中文，再点「发送」或回车 |
| `main.py` | 约 2s 轮询；**同一时刻只处理一个未读会话**；`data/rpa_state.json` 持久化 `conversation_id` 与去重键；若左侧列表在 UIA 中**始终无未读标记**，会 **兜底轮询当前已打开的聊天区** 最后一条买家消息（需聊天窗口已点开该买家） |

## UI 选择器（推荐先改这里）

`config/selectors.json` 控制大部分「找窗口 / 找未读 / 找发送键」的启发式参数，**千牛小改版时通常只需改 JSON**，不必改 Python。

| 字段 | 含义 |
|------|------|
| `window_title_substrings` | 标题需 **命中任一** 子串；空数组则回退 `.env` 的 `QIANNIU_WINDOW_SUBSTRING` |
| `session_left_panel_ratio` | 左侧会话列表约占窗口宽度比例（0–1），用于过滤非左侧的 `ListItem` |
| `unread_markers` | 未读 / **待回复** 等标记文案，子控件 `Name` **包含任一** 即视为待处理（新版接待台常见「待回复」而无「未读」二字） |
| `unread_badge_numeric` | 为 `true` 时，会话项子树里出现 **1–99 的纯数字** `Name`（未读条数角标）也视为待处理 |
| `buyer_bubble_offset_px` | 买家气泡相对窗口中线向左偏移阈值（越大越「宽」） |
| `input_bottom_margin_px` / `input_pool_bottom_margin_px` | 输入框相对窗口底部的判定范围 |
| `tree_walk_max_depth` | 遍历控件树最大深度（过深变慢，过浅可能漏控件） |
| `send_button_include_substrings` / `send_button_exclude_substrings` | 发送按钮名称需包含 / 需排除的子串 |

**说明**：配置化提升的是 **可维护性与试错成本**（改文件即可多试几组规则），**不能**保证千牛大改版后仍零改动；若控件树完全换型，仍可能要改 `qianniu_driver.py` 或引入图像/OCR。

**中间聊天区最后一条正文**仍以 UIA 读取为主（避免引入 OCR 与主题色依赖）。你提供的示意图里**红框 3（气泡区域）**对应的是「读消息」目标区，当前实现未对整块气泡做模板匹配；若以后要完全视觉化读字，可再接入 OCR 或图标模板。

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
