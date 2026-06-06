# KaaS 项目 · Claude Code 规则文件

> 整合自其他 AI CLI 工具（Qwen CLI、Cursor）的规则配置
> 最后更新：2026-04-04

## 项目上下文

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
  ├── .qwen/                   # AI CLI 规则与配置
  ├── .cursor/                 # Cursor 专用配置
  └── .claude/                 # Claude Code 配置（本文件所在）
  ```

## 协作架构

### 三方协作角色
1. **Nano Auto**（Notion AI Agent）= 大脑：拆任务、写 Spec、检查定位代码问题、验收、管文档、执行文档任务
2. **Runner**（AI 编程工具，如 Claude Code/Cursor/Qwen CLI）= 工程师：按 Nano 输出的 Spec 和问题清单修复代码
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

## 设计不变量（必须写入代码与测试）

1. **拦截点在最前**：进入任何 RAG/工作流/模型调用前，必须完成订阅状态、配额与限频校验
2. **幂等由 DB 兜底**：`usage_events.request_id` UNIQUE；重试请求不得重复扣费
3. **并发由原子 SQL 兜底**：预扣必须用单条 `UPDATE ... WHERE ...` 完成校验+扣减，禁止 SELECT 后再 UPDATE
4. **可对账**：每次请求必须对应一条 `usage_event`（reserved/settled/refunded/failed），不得出现"扣了但没记录"
5. **失败不亏钱**：下游失败默认全额退款，必须在 `usage_event` 中体现
6. **透支有上限**：credit line 允许短期放行，超额累计超过硬上限后必须强拦截

## 编码规范

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

## 测试要求（至少 8 组）

1. **并发不穿透**：同客户并发 10-50 请求，总用量不超配额+credit line
2. **request_id 幂等**：同 ID 重试不重复扣费
3. **到期/非 active 必拦截**：且断言未发出 AI 请求
4. **接近配额不误拦截**：credit line 范围内应放行
5. **超过硬上限强拦截**：防无限透支
6. **限频生效**：tokens/min 与 req/min
7. **下游失败退款**：AI 超时/500 时，usage_event 状态与退款正确
8. **重置正确**：跨月/到 reset_at 后 token_used 清零且不影响订阅状态

## Git 与交付规范

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

## Notion MCP 写入规范

### 核心原则：只能追加，不能删除或修改已有内容
- **必须使用** `update_content` 命令追加日志
- **绝对禁止**使用 `replace_content`（会删除整个页面历史）
- **绝对禁止**删除任何历史日志行
- **绝对禁止**修改任何已有日志内容
- **只能**在已有内容的**末尾新增**，保持所有历史记录完整永久保留

### 追加方法
- `old_str`: 匹配**最后一条已有日志**或 **Tab标题行** `🔧 **Runner 执行日志**`
- `new_str`: 必须完整保留 `old_str` 全部内容 + `\n\n` + 新日志内容（带缩进）
- 使用 `\t\t`（两个制表符）作为缩进

### 写入步骤（必须遵循）
1. **先调用 `notion-fetch`** 获取页面当前内容
2. **从返回的 XML 中找到要匹配的确切字符串**（通常是 Tab 标题或最后一条日志）
3. **使用 `update_content` 追加内容**
4. **写入后必须再次调用 `notion-fetch` 验证**内容是否实际写入

## 环境配置提示
- **禁止把任何东西放 C 盘**：项目代码放项目目录，其他软件（千牛、Python、Playwright 等）装 D 盘其他位置
- 项目根目录：`D:\MyProject\kaas-platform\`

## 参考文件
- 完整规则：`.qwen/KAAS_RULES.md`
- Cursor 专用规则：`.cursor/rules/` 目录
- 通用技能：`.qwen/KAAS_RULES.md` 第二部分