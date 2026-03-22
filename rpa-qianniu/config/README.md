# 配置说明

## `selectors.json`

- **窗口标题** `window_title_substrings`：仍用于 `uiautomation` **仅定位顶层窗口**（接待中心/千牛）。
- **聊天区内部**（ListItem、Edit、未读角标等）在 CEF 内 **通常无 UIA 节点**，请改用 **纯视觉流水线**（`USE_VISION_PIPELINE=true`），勿依赖本文件内的 `unread_markers` 等做控件匹配。

## 区域比例

在 **`.env`** 中设置 `VISION_*_RATIO`（见 `.env.example`），或改 `app/config.py` 默认值。

| 变量 | 含义 |
|------|------|
| `VISION_LEFT_START_RATIO` | 左侧**图标导航**右缘（会话列表从这里开始） |
| `VISION_LEFT_END_RATIO` | **会话列表**右缘；与上一项之间为红点检测区域 |
| `VISION_CHAT_END_RATIO` | **聊天列**右缘（对话+输入）；右侧为商品/订单面板 |
| `VISION_MESSAGE_TOP_RATIO` | 聊天列内从顶部去掉（买家昵称标题栏等） |
| `VISION_INPUT_BOTTOM_RATIO` | 聊天列内底部输入+发送条高度占比 |

跑 `python smoke_vision_regions.py` 查看叠加框是否贴合。
