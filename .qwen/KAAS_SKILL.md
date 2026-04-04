---
name: kaas-workflow
description: KAAS 项目工作流编排技能。用于从 Notion 任务流水线拉取任务、执行开发、更新日志、流转状态。适用于所有 AI CLI 工具（Qwen CLI、Claude Code、Cursor、Aider 等）。
---

# KAAS 工作流编排技能

## 触发条件
- 当用户输入 `kaas` 或明确要求"开始跑任务流水线"时启用本技能。

## 硬规则

### 任务选择
1. 查询任务流水线数据库（`https://www.notion.so/fad40cb1006b4c71ab041a362a32334c`）。
2. 过滤 `状态 == Runner开发` 的记录。
3. 按 `优先级`（P0 > P1 > P2）+ `创建时间`（从早到晚）排序后选第 1 条作为当前任务。
4. 若无可执行任务，直接回报"当前无 Runner开发 任务"并结束。

### 执行约束
- **同一时间只执行一个任务**：在当前任务完成并切到 `Nano验收` 前，不得启动下一条。
- **强制使用 MCP 更新 Notion**：严禁创建任何脚本（Python/PowerShell/Bash 等）来更新 Notion。所有 Notion 操作必须且只能使用 MCP 工具。
- **强制完成 12 项日志后才可流转状态**：未完成 12 项骨架、未执行 git push、未输出自检清单，一律禁止将状态改为 `Nano验收`。

---

## 单次任务执行流程

### Step 1: 读取任务 Spec
```
调用 notion-fetch 获取任务页面内容
→ 定位到 📋 任务 Spec 选项卡
→ 提取需求、方案、验收标准、执行指令
```

### Step 2: 按 Spec 实施代码
- 严格按照 Spec 要求编码，不扩需求，不跳过校验
- 遇到问题记录在日志，必要时创建「Runner 异常援助」任务

### Step 3: Git 交付
```bash
git add .
git commit -m "<type>(<scope>): <描述>"
git push
```
- **未 push 成功前，禁止写"开发完成"到 Notion**
- push 失败则保持 `Runner开发` 状态，在日志中记录失败原因

### Step 4: 强制自检（提交前必做，不可跳过）
输出自检清单表格：

| Spec编号 | 修改文件 | commit 改动 | 结果 |
|-----------|----------|-------------|------|
| P0-1      | xxx.py   | 具体描述    | PASS |
| P1-2      | N/A      | N/A         | SKIP（原因：xxx） |

- ❗ FAIL 项必须先修复再提交
- ❗ SKIP 项必须标注原因
- ❗ 没有此清单 = 验收直接打回

### Step 5: 回写 Notion
**属性更新**：
- `产出物`：PR/分支/commit（必须包含可追溯标识）

**执行日志**（写入 `🔧 Runner 执行日志` 选项卡）：
- 必须完整包含 12 项骨架（见下方格式规范）
- 使用 `update_content` 命令追加，严禁 `replace_content`

**状态流转**：
- `Runner开发` → `Nano验收`

### Step 6: 汇报完成情况
向用户报告本次任务完成情况，不自动继续下一条，等待用户下一次 `kaas` 指令。

---

## 执行日志格式规范（12 项骨架，缺一不可）

```markdown
[Runner] YYYY-MM-DD HH:mm 开发完成

## 1. 任务元数据
- task_id:
- task_url:
- spec_version:
- repo/branch:
- pr_or_commit:
- operator:

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
- file: <path>
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
- 遇到了什么问题：
- 怎么解决的：
- 最终结果：

## 9. 风险与回滚
- 可能出什么问题：
- 怎么发现问题：
- 出了问题怎么办：

## 10. 产出清单
- artifact:

## 11. 待办与建议
- next_action:

## 12. 附录证据索引
- evidence_links:
- raw_outputs:
```

---

## Notion MCP 写入规范（关键）

### 核心原则
- **绝对禁止**使用 `replace_content` 命令（会删除整个页面历史）
- **绝对禁止**删除任何历史日志行
- **绝对禁止**修改任何已有日志内容
- **只允许一种操作**：在已有内容的末尾追加新日志

### 正确的追加方法

使用 `update_content` 命令，通过匹配 Tab 标题作为锚点：

```json
{
  "page_id": "页面ID",
  "command": "update_content",
  "content_updates": [
    {
      "old_str": "\t\t🔧 **Runner 执行日志**",
      "new_str": "\t\t🔧 **Runner 执行日志**\n\n\t\t[Runner] 2026-04-04 13:00 开发完成\n\t\t## 1. 任务元数据\n\t\t- task_id: xxx"
    }
  ]
}
```

**关键要点**：
1. 使用 `\t\t`（两个制表符）作为缩进
2. `old_str` 必须是页面上已存在的精确字符串
3. `new_str` 必须包含 `old_str` 的完整内容 + `\n\n` + 新增内容
4. **严禁**只保留部分内容或修改 `old_str`

### 写入步骤（必须遵循）

1. **先 fetch 页面**：调用 `notion-fetch` 获取页面当前 XML 内容
2. **找到锚点**：确认 Tab 标题行的精确字符串 `\t\t🔧 **Runner 执行日志**`
3. **构造 update_content**：`new_str` = Tab标题 + `\n\n` + 新日志内容（带缩进）
4. **验证写入**：写入后再次调用 `notion-fetch` 验证内容是否实际写入

### 追加日志的黄金法则

1. **永远先 fetch** - 获取页面精确内容
2. **使用 Tab 标题作为锚点** - 获取精确的 `old_str`
3. **保持原内容完整+追加** - `new_str` 必须完整包含 `old_str`
4. **严禁删除/修改历史** - 任何情况下都不能删除或修改已有日志
5. **验证后再报告成功** - 写入后立即 fetch 验证

---

## 失败处理

### Notion/MCP 暂时失败
- 重试一次
- 仍失败则向用户报告阻塞原因与下一步建议

### 状态前置不合法
- 拒绝流转
- 在 `🔧 Runner 执行日志` 记录"非法状态流转已拒绝"

### git push 失败
- 不得切换到 `Nano验收`
- 在 `🔧 Runner 执行日志` 记录失败原因并保持 `Runner开发`

### 日志未满足 12 项骨架
- 视为未完成
- 禁止写"开发完成"与禁止状态流转

---

## Runner 异常援助任务规范

当任务类型为 `Runner 异常援助` 时，遵循以下规范：

### 任务卡片属性
1. **任务类型**：`Runner 异常援助`
2. **优先级**：`P1`（仅当阻塞整个迭代时可为 `P0`）
3. **任务名**：`[Runner异常援助] <问题概述>`

### 📋 任务 Spec 必须包含
- **异常描述**：发现时间、方式、影响模块
- **错误详情**：异常类型、完整错误日志/堆栈跟踪、运行时上下文
- **复现步骤**：详细的复现步骤
- **预期行为 vs 实际行为**
- **已尝试的修复及结果**（如适用）
- **相关日志**：完整的运行日志
- **建议的解决方向**

### 执行要点
- 优先分析根因而非直接修改代码
- 记录完整的调试过程和推理链条
- 如需修改代码，确保修复方案针对根因而非症状
- 验证修复后需复现原始错误场景确认已解决

---

## 自检清单模板（每次提交前必须输出）

| Spec编号 | 修改文件 | commit 改动 | 结果 |
|-----------|----------|-------------|------|
| P0-1      | xxx.py   | 具体描述    | PASS |
| P1-2      | N/A      | N/A         | SKIP（原因：xxx） |

❗ FAIL 项必须先修复再提交
❗ SKIP 项必须标注原因
❗ 没有此清单 = 验收直接打回

---

**技能结束。使用时确保 AI CLI 工具已加载本技能，然后输入 `kaas` 即可启动任务流水线。**
