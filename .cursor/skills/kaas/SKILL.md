---
name: kaas
description: Executes KAAS Notion workflow orchestration. Use when the user inputs "kaas" to pull tasks from 任务流水线 with status Cursor开发, pick highest priority first (P0>P1>P2), and execute exactly one task at a time.
---

# KAAS Workflow Runner

## Trigger
- 当用户输入 `kaas`（或明确要求"开始跑任务流水线"）时启用本技能。

## Hard Rules
- 只读页面 `三角协作工作流规范`，禁止写入。
- 仅处理 `任务流水线` 中状态为 `Cursor开发` 的任务。
- 优先级顺序固定：`P0 紧急 > P1 重要 > P2 常规`。
- 同优先级按创建时间从早到晚。
- **同一时间只执行一个任务**：在当前任务完成并切到 `Nano验收` 前，不得启动下一条。
- **强制命令**：每次执行日志必须完整包含"12项骨架"，缺任一项都不得更新 `Nano验收`。

## Task Selection
1. 查询任务流水线（view: `https://www.notion.so/fad40cb1006b4c71ab041a362a32334c?v=54a797e284664ff4b549abe408c4def8`）。
2. 过滤 `状态 == Cursor开发` 的记录。
3. 按 `优先级` + `创建时间` 排序后选第 1 条作为当前任务。
4. 若无可执行任务，直接回报"当前无 Cursor开发 任务"并结束。

## Execution Steps (Single Task)
1. `notion-fetch` 当前任务页，读取 `📋 任务 Spec`。
2. 按 Spec 实施代码修改与验证（不扩需求，不跳过校验）。
3. 完成代码后先执行 Git 交付：
   - `git add` -> `git commit` -> `git push`
   - 未 push 成功前，禁止写"开发完成"到 Notion
4. push 成功后再回写 Notion：
   - 属性 `产出物`：PR/分支/commit（必须包含可追溯标识）
   - `📝 执行日志` 选项卡：追加结构化详细日志（含 commit hash、push结果）
5. 状态流转：`Cursor开发 -> Nano验收`。
6. 向用户汇报本次任务完成情况；不自动继续下一条，等待用户下一次 `kaas` 指令。

## Execution Log Format (Append to 📝)
执行日志必须做到"可复盘全貌"。只允许追加，不覆盖历史。以下 **12项骨架为强制命令**，缺一不可：

```markdown
[Cursor] YYYY-MM-DD HH:mm 开发完成
## 1. 任务元数据
- task_id:
- task_url:
- spec_version:
- repo/branch:
- pr_or_commit:

## 2. 目标与范围
- in_scope:
- out_of_scope:
- constraints:

## 3. 输入快照
- notion_spec:
- acceptance_items:
- current_status:

## 4. 执行时间线
1) action -> reason -> result

## 5. 改动明细
- file:
  - change:
  - purpose:
  - impact:

## 6. 验证矩阵
- cmd:
  - expected:
  - actual:
  - result: PASS/FAIL
  - evidence:

## 7. 验收映射
- criterion -> evidence -> PASS/FAIL

## 8. 异常与处置
- issue:
- handling:
- final:

## 9. 风险与回滚
- risk:
- trigger:
- rollback:

## 10. 产出清单
- artifact:

## 11. 待办与建议
- next_action:

## 12. 附录证据索引
- evidence_links:
- raw_outputs:
```

## Failure Handling
- 若 Notion/MCP 暂时失败：重试一次；仍失败则向用户报告阻塞原因与下一步建议。
- 若状态前置不合法：拒绝流转，并在 `📝 执行日志` 记录"非法状态流转已拒绝"。
- 若 `git push` 失败：不得切换 `Nano验收`；在 `📝 执行日志` 记录失败原因并保持 `Cursor开发`。
- 若日志未满足12项骨架：视为未完成，禁止写"开发完成"与禁止状态流转。

## 自检清单模板（每次提交前必须输出）

| Spec编号 | 修改文件 | commit 改动 | 结果 |
|-----------|----------|-------------|------|
| P0-1      | xxx.py   | 具体描述    | PASS |
| P1-2      | N/A      | N/A         | SKIP（原因：xxx） |

❗ FAIL 项必须先修复再提交
❗ SKIP 项必须标注原因
❗ 没有此清单 = 验收直接打回
