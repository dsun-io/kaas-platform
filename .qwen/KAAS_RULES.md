# KaaS 项目 · AI CLI 通用规则与技能文件

> 适用于所有 AI CLI 工具（Qwen CLI、Claude Code、Cursor、Aider、Copilot CLI 等）。
> 
> 使用方式：复制粘贴到 CLI 工具的 system prompt / rules / context 中即可生效。
> 
> 最后更新：2026-04-04

---

# 第一部分：RULES（项目约束）

## R1. 项目上下文

### 项目定位
**一句话定位**：中国传统制造业产业集群的 AI 岗位能力托管商。

**项目名称**：KaaS（Knowledge as a Service）—— 为传统制造业提供 AI 岗位能力托管，首先做丝网行业的 AI 智能客服，SaaS 订阅模式。

**当前 Demo 方向**：丝网报价小助手（IM 中随时使用 AI 能力），让业务员可以在聊天中快速获得准确报价和话术建议。

### 当前阶段
MVP Demo 验证期 —— 用 FastGPT + 本地代码最快跑通报价和话术闭环。

### 技术栈（Demo 阶段）
- **AI 平台**：FastGPT 在线版（cloud.fastgpt.cn）
- **大模型**：DeepSeek-Chat API（推理）
- **消息路由**：Python 3.11 + FastAPI（`msg-router/`，端口 8000）
- **RPA**：千牛（Python + uiautomation）+ 拼多多（Playwright）
- **本地开发**：Windows 本地，无需云服务器

### 技术栈（正式版）
- **AI 平台**：Dify（Docker 私有部署）+ PostgreSQL + Redis + Weaviate
- **计费网关**：Python 3.11 + FastAPI + PostgreSQL + Redis
- **部署方式**：Docker Compose

### 代码仓库
- **GitHub**：`davidsun0124/kaas-platform`
- **本地路径**：`D:\MyProject\kaas-platform\`
- **项目结构**：
  ```
  D:\MyProject\kaas-platform\
  ├── msg-router/              # 消息路由服务（FastAPI）
  ├── rpa-qianniu/             # 千牛 RPA
  ├── rpa-pdd/                 # 拼多多 RPA
  ├── scripts/                 # 运维脚本
  └── .qwen/                   # AI CLI 规则与配置
  ```

---

## R2. 协作架构

### 三方协作角色
1. **Nano Auto**（Notion AI Agent）= 大脑：拆任务、写 Spec、检查定位代码问题、验收、管文档、执行文档任务
2. **Runner**（AI 编程工具，如 Qwen CLI/Cursor/Claude Code）= 工程师：按 Nano 输出的 Spec 和问题清单修复代码
3. **David**（创始人）= 决策者：创建任务、验收确认、方向决策

### 任务流转状态机
```
编辑中（David写）→ 待启动（等David决策）→ Nano规划（Nano写Spec）
→ Runner开发（Runner写代码）→ Nano验收（Nano核查）
→ David验收（David确认）→ 已完成
```

**纯文档任务可跳过 Runner 环节**：Nano规划 → David验收

### 状态前置校验表（严格执行）
| 目标状态 | 允许的前置状态 |
|----------|----------------|
| 待启动 | 编辑中 |
| Nano规划 | 待启动 / David验收 / Runner开发 |
| Runner开发 | Nano规划 / Nano验收 / David验收 |
| Nano验收 | Runner开发 |
| David验收 | Nano验收 / Nano规划 |
| 已完成 | David验收 |

**非法流转必须拒绝**，并在执行日志中记录：`[角色] YYYY-MM-DD HH:mm 非法状态流转：A -> B（已拒绝）`。

### Notion 是唯一真相源
- 所有任务信息、Spec、验收标准都在 Notion 任务流水线数据库中
- 执行时以任务卡正文 `📋 任务 Spec` 为唯一输入依据
- 所有执行日志、状态流转、属性更新都写入 Notion

---

## R3. 设计不变量（必须写入代码与测试）

1. **拦截点在最前**：进入任何 RAG/工作流/模型调用前，必须完成订阅状态、配额与限频校验
2. **幂等由 DB 兜底**：`usage_events.request_id` UNIQUE；重试请求不得重复扣费
3. **并发由原子 SQL 兜底**：预扣必须用单条 `UPDATE ... WHERE ...` 完成校验+扣减，禁止 SELECT 后再 UPDATE
4. **可对账**：每次请求必须对应一条 `usage_event`（reserved/settled/refunded/failed），不得出现"扣了但没记录"
5. **失败不亏钱**：下游失败默认全额退款，必须在 `usage_event` 中体现
6. **透支有上限**：credit line 允许短期放行，超额累计超过硬上限后必须强拦截

---

## R4. 编码规范

### 通用规则
1. **所有密码/密钥从环境变量读取，禁止硬编码**
2. **DB 用 UTC 存储时间；业务层按 Asia/Shanghai 计算**
3. **必须输出完整可运行代码，禁止省略号和「自行补充」**
4. **每个文件输出完整内容**
5. **不确定的地方列为 Open Questions，不要静默猜测**
6. **关键路径禁止伪代码**
7. **禁止信任上游传 customer_id**：必须通过 gateway_api_key/JWT/签名解析得到

### Python 规范
- 遵循 PEP 8
- 使用类型注解（`typing` 模块）
- 函数/类必须有 docstring
- 错误处理用 try/except，禁止裸 except
- 日志用 `logging` 模块，禁止 print 调试代码留在生产环境

### API 设计规范
- RESTful 风格
- 所有拦截与失败必须返回标准 JSON（`code/message`）
- 错误码规范：
  - `401 INVALID_API_KEY`
  - `403 SUBSCRIPTION_EXPIRED / SUBSCRIPTION_INACTIVE`
  - `429 RATE_LIMITED / QUOTA_EXCEEDED`
  - `502 UPSTREAM_ERROR`

### 扣费流程固定顺序（不可改）
```
限频 → INSERT usage_event(reserved) → 原子预扣 → 调用 AI 引擎
→ 结算/退款 → 更新 usage_event 状态
```

---

## R5. 测试要求（至少 8 组）

1. **并发不穿透**：同客户并发 10-50 请求，总用量不超配额+credit line
2. **request_id 幂等**：同 ID 重试不重复扣费
3. **到期/非 active 必拦截**：且断言未发出 AI 请求
4. **接近配额不误拦截**：credit line 范围内应放行
5. **超过硬上限强拦截**：防无限透支
6. **限频生效**：tokens/min 与 req/min
7. **下游失败退款**：AI 超时/500 时，usage_event 状态与退款正确
8. **重置正确**：跨月/到 reset_at 后 token_used 清零且不影响订阅状态

---

## R6. Git 与交付规范

### 三条红线（违反即验收不通过）

1. **强制自检**：提交前必须逐项对照 Spec 输出自检清单（Spec编号 → 文件 → commit 改动 → PASS/SKIP/FAIL）。FAIL 必须先修，SKIP 必须写原因。
2. **强制详细日志且禁止删除历史**：日志必含 task_id、变更文件、测试结果、自检清单、commit hash、push 状态。严禁删除/覆盖历史日志。
3. **强制推送远程仓库**：开发完成必须 `git push`。未推送 = 未完成。产出物必含可验证的 commit hash / PR link。

### 每次交付必须包含
1. Assumptions（明确假设）
2. Invariants（不变量清单，说明如何被 DB/代码/测试保障）
3. Runbook（从 0 到跑通的命令级步骤）
4. Risk & Rollback（回滚方案，如何停用拦截 / shadow mode）
5. Open Questions（待确认项）

### Git 提交规范
- 分支命名：`feature/<功能名>` / `fix/<问题名>`
- Commit 信息格式：`<type>(<scope>): <描述>`
  - type: feat / fix / docs / refactor / test / chore
  - 示例：`feat(msg-router): 添加报价计算引擎骨架`
- **开发完成必须 git push 到远程仓库，未推送 = 未完成**

---

# 第二部分：SKILL（项目技能）

## S1. 领域知识

### 安平丝网产业背景
- **地理位置**：河北省安平县，中国丝网产业发源地
- **产业规模**：全国 70%+ 丝网产量，年产值数百亿
- **主要产品**：牛栏网、勾花网、电焊网、荷兰网、刺绳、钢板网等
- **目标客户**：安平做牛栏网/勾花网的中等规模商家（日均 100-300 次咨询）

### 牛栏网产品知识
- **产品名称**：牛栏网（草原网、畜牧网、Field Fence）
- **用途**：养殖围栏，适用于牛、羊、猪、鸡鸭等畜禽围护
- **核心特征**：拧编（非焊接）/环扣结构，分两种网孔形式：
  - 上疏下密：底部孔距小防小动物钻出，顶部孔距大节省材料
  - 均孔：上下网孔均匀一致
- **关键规格**：丝径（经×纬）、高度、网孔宽度、卷长（50m/100m）

### 商业模式
- **三档订阅**：¥799/999/1499/月 + 席位费 + 超额按量
- **毛利率**：50-85%
- **目标客户**：安平丝网中等规模商家
- **发展节奏**：
  - MVP验证（1-3月）：3-5家种子客户
  - 规模复制（6-12月）：30-50家付费客户，续费率≥60%
  - 产业扩展（12月+）：跨产业带复制 + 全岗位覆盖

---

## S2. Notion MCP 交互规范

### 核心原则
- Notion 是唯一真相源，所有任务管理通过 Notion MCP 工具完成
- 使用 `notion-fetch` 读取页面内容
- 使用 `notion-update-page` 更新页面（属性、内容）
- **严禁创建任何脚本（Python/PowerShell/Bash 等）来更新 Notion**

### 日志写入规范（关键）

#### 核心原则：只能追加，不能删除或修改已有内容

**绝对禁止**：
- ❌ 使用 `replace_content` 命令（会删除整个页面历史）
- ❌ 删除任何历史日志行
- ❌ 修改任何已有日志内容
- ❌ 替换整个日志内容
- ❌ 清空日志后重新写入

**只允许一种操作**：在已有内容的末尾追加新日志。

#### 正确的追加方法

使用 `update_content` 命令，通过匹配 Tab 标题或最后一条日志作为锚点：

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

#### 写入步骤（必须遵循）

**Step 1**：先调用 `notion-fetch` 获取页面当前内容
**Step 2**：从返回的 XML 中找到要匹配的确切字符串（通常是 Tab 标题或最后一条日志）
**Step 3**：使用 `update_content` 追加内容
**Step 4**：写入后必须再次调用 `notion-fetch` 验证内容是否实际写入

#### 追加日志的黄金法则

1. **永远先 fetch** - 获取页面精确内容
2. **使用 Tab 标题或最后一条日志作为锚点** - 获取精确的 `old_str`
3. **保持原内容完整+追加** - `new_str` 必须完整包含 `old_str`
4. **严禁删除/修改历史** - 任何情况下都不能删除或修改已有日志
5. **验证后再报告成功** - 写入后立即 fetch 验证

---

## S3. 三方协作流程

### ⚠️ 任务创建规范（Runner创建任务时必须遵守）

#### 标准任务页面结构（使用Notion页面模板）

**创建新任务时，必须使用Notion数据库的页面模板**，模板包含以下固定结构：

```
📋 任务 Spec（Tab选项卡）
  - 需求背景
  - 任务类型  
  - 产出定义
  - 验收标准
  - 执行方式

📝 Nano 执行日志（Tab选项卡）
  - Nano/David执行记录

🔧 Runner 执行日志（Tab选项卡）
  - Runner开发执行记录（格式：[Runner] YYYY-MM-DD HH:mm 内容）

🔍 David 反馈（独立区块，页面底部）
  - David验收时填写
```

**创建步骤**：
1. 使用Notion API创建页面时，**必须指定模板ID**（`inlined_page_template_id`）
2. 如果无法使用模板，**必须手动创建上述4个部分**（3个Tab + 1个反馈区块）
3. 写入任务Spec内容到「📋 任务 Spec」Tab
4. 初始化「🔧 Runner 执行日志」Tab为空状态（等待开发时填写）

#### Runner执行日志规范（铁律）

**每次执行任务后，必须立即写入Runner执行日志**，包含12项完整骨架：

1. 任务元数据（task_id, task_url, spec_version, repo/branch, pr_or_commit, operator）
2. 目标与范围（in_scope, out_of_scope, constraints）
3. 输入快照（notion_spec, acceptance_items, current_status）
4. 执行时间线（按序号记录每一步动作、原因、结果）
5. 改动明细（每个文件的改动点、目的、影响面）
6. 验证矩阵（命令、预期、实际、结果、证据）
7. 验收映射（验收标准 → 证据 → PASS/FAIL）
8. 异常与处置（遇到的问题、解决方案、最终结果）
9. 风险与回滚（可能的风险、如何发现、回滚步骤）
10. 产出清单（commit/PR/文件路径/制品链接）
11. 待办与建议（后续动作、人工确认项）
12. 附录证据索引（证据链接、原始输出）

**写入规则**：
- 使用Notion MCP `update_content` 命令追加日志
- 匹配Tab标题作为锚点：`\t\t🔧 **Runner 执行日志**`
- new_str必须完整保留old_str + 新增内容
- **绝对禁止**删除/修改/覆盖已有日志
- 每条日志以 `[Runner] YYYY-MM-DD HH:mm` 开头

**违反此规范 = Nano验收直接打回**

### Runner 执行规则

#### 启动前
1. 读取 `📋 任务 Spec`，不得按猜测扩需求
2. 确认当前任务状态为 `Runner开发`
3. 确认前置状态合法（来自 `Nano规划` / `Nano验收` / `David验收`）

#### 执行中
1. 按 Spec 实施代码修改与验证
2. 不扩需求，不跳过校验
3. 遇到问题记录在日志，必要时创建「Runner 异常援助」任务

#### 完成后（必须按顺序做四件事，顺序不可变）
1. **先执行 Git 交付**：`git add` → `git commit` → `git push`
2. **push 成功后更新属性**：`产出物`（PR/分支/commit）
3. **向 `🔧 Runner 执行日志` 追加结构化记录**（必须完整包含 12 项骨架）
4. **状态流转**：`Runner开发` → `Nano验收`

#### 阻塞时
在 `🔧 Runner 执行日志` 写明原因，并将状态回退到 `Nano规划`。

---

## S4. 任务执行模式

### 标准任务执行流程

1. **需求确认**：这一步要解决什么问题？有没有歧义或遗漏？
2. **方案设计**：关键技术选型、数据流、接口契约、边界条件
3. **实现**：完整可运行代码
4. **自检**：是否满足"设计不变量"？并发/幂等/失败退款有没有漏？
5. **验收标准**：怎样证明这一步做完了？（命令级步骤）

### Runner 执行日志格式（12 项骨架，缺一不可）

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

## S7. ⚠️ 任务完成铁律（强制执行，违反必被打回）

**每次完成任务后，Runner 必须严格遵守以下三步曲，顺序不可变：**

### 第一步：写入日志到正确位置
1. **必须找到正确的 Block ID**：
   - 调用 `notion-fetch` 获取任务页所有块。
   - 寻找 `rich_text` 包含 `🔧 **Runner 执行日志**` 的块（通常在 `tab` 块内部）。
   - 日志必须写入该块的 `children` 中。
   - **绝对禁止**直接写入页面根目录或其他 Tab。

### 第二步：立即更新状态
1. 日志写入成功后，**必须立即**调用 `notion-update-page` 将 `状态` 更新为 `Nano验收`。
2. **禁止**只写日志不改状态，否则 Nano 无法触发验收流程。

### 第三步：自检确认
1. **验证日志位置**：再次 `fetch` 确认日志确实出现在「🔧 Runner 执行日志」Tab 下。
2. **验证状态**：确认任务属性 `状态` 已变为 `Nano验收`。

**违反以上任何一条 = Nano 验收直接打回 + 重新执行。**

---

## S8. 常见开发模式

### 报价计算引擎开发模式
1. 先建数据底座（JSON 配置文件：卷重表、价格表）
2. 实现核心计算逻辑（卷重查找、成本计算、FOB/CIF 计算）
3. 编写单元测试（覆盖所有计算路径）
4. 暴露 HTTP API（`POST /v1/quote`）
5. 集成到 FastGPT 工作流（HTTP 节点调用）

### 话术模板引擎开发模式
1. 定义话术模板 JSON 结构（场景分类、模板内容、变量占位）
2. 实现模板渲染逻辑（变量替换、条件渲染）
3. 编写测试用例（覆盖常见场景）
4. 集成到消息路由层

### FastGPT 工作流集成模式
1. 确认 FastGPT HTTP 节点调用方式（URL、Headers、Payload）
2. 本地服务暴露对应 API
3. 在 FastGPT 中配置 HTTP 节点
4. 测试端到端调用链路

---

## S6. Shadow Mode（上线前试运行策略）

新功能上线时，先开「影子模式」观察几天：

**第一阶段（1-3天）**：只记录日志，不真正拦截请求
- 看看限频阈值设置得是否合理
- 看看 token 估算准不准
- 观察并发高峰期的表现

**第二阶段**：如果观察期数据正常，再切换到正式拦截模式

**回滚预案**：
- 发现配置有误或误伤用户，立即关闭拦截，切回影子模式
- 紧急情况下可以直接停用整个拦截逻辑，保证业务不中断
- 回滚命令和配置开关要在 Runbook 里写清楚

---

# 第三部分：快速摘要（粘贴到对话开头使用）

## 这是一个什么项目？
KaaS（Knowledge as a Service），为传统制造业提供 AI 岗位能力托管，首先做丝网行业的 AI 智能客服，SaaS 订阅模式。

## 怎么赚钱？
三档订阅（¥799/999/1499/月）+ 席位费 + 超额按量，毛利 50-85%。

## 技术栈？
FastGPT + DeepSeek API + 行业知识库，正式版自建 RAG（Dify）。

## 当前卡在哪？
丝网报价小助手 Demo 开发中，需要将报价和话术从 AI 中剥离，用代码实现提升效率和准确性。

## 谁在做？
David（创始人）+ Nano Auto（AI 协调）+ Runner（AI 编程，如 Qwen CLI/Cursor），正在找技术/产业/运营合伙人。

## 核心差异化
市面上已有成熟 AI+RPA 电商客服方案，但全是通用电商客服工具，制造业场景无人覆盖。我们的护城河：懂非标报价逻辑、行业术语、产业带生态。

---

**文档结束。使用时将本文件内容复制粘贴到 AI CLI 工具的 system prompt / rules / context 中即可生效。**
