# 根据 `control_tree.txt` 更新选择器（第二步）

1. 在千牛打开「接待中心」，运行：
   ```bash
   cd rpa-qianniu
   python debug_dump_tree.py
   ```
2. 打开本目录下的 `control_tree.txt`，搜索行首带 **★** 的条目：
   - **Edit / RichEdit / TextBox**：对应聊天输入框候选 → 记录 `ClassName`、`AutomationId`、父级路径。
   - **Name 含「发送」**：发送按钮 → 同上。
   - **未读 / 角标相关**：左侧会话未读 → 将实际出现的 **Name 片段** 或 **AutomationId** 填入 `config/selectors.json` 的 `unread_markers`（或后续若代码支持 `automation_id` 字段再填）。
3. **不要凭猜测填写**：只使用 dump 中出现的字符串；若某版本千牛无 UIA 节点，需依赖视觉/OCR 路径，在 issue/文档中说明。

当前 `selectors.json` 仍以手工维护的 `unread_markers` 为主；输入框定位在代码中由几何+策略完成，若 dump 中出现稳定 `AutomationId`，可再开任务把该字段接入 `ui_selectors`。
