# 配置说明

## `selectors.json`

- **窗口标题** `window_title_substrings`：仍用于 `uiautomation` **仅定位顶层窗口**（接待中心/千牛）。
- **聊天区内部**（ListItem、Edit、未读角标等）在 CEF 内 **通常无 UIA 节点**，请改用 **纯视觉流水线**（`USE_VISION_PIPELINE=true`），勿依赖本文件内的 `unread_markers` 等做控件匹配。

## 区域比例

在 **`.env`** 中设置 `VISION_*_RATIO`（见 `.env.example`），或改 `app/config.py` 默认值。
