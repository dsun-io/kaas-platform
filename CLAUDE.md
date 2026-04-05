# KaaS 项目 · Claude Code 配置

> 本项目使用 Claude Code 作为 AI 编程 Runner 工具，遵循三方协作架构。
> 最后更新：2026-04-04

## 项目简介

**KaaS（Knowledge as a Service）**：为传统制造业（首先安平丝网产业集群）提供 AI 岗位能力托管 SaaS 服务。商家零部署零运维，按月付费，我们托管一切。

**当前阶段**：MVP Demo 验证期——丝网报价小助手，用 FastGPT + 本地代码（报价/话术引擎）最快跑通报价和话术闭环。

**技术栈（Demo阶段）**：
- AI 平台：FastGPT 在线版（cloud.fastgpt.cn）
- 大模型：DeepSeek-Chat API（推理）
- 消息路由：Python 3.11 + FastAPI（`msg-router/`，端口 8000）
- RPA：千牛（Python + uiautomation）+ 拼多多（Playwright）
- 本地开发：Windows 本地，无需云服务器

## 协作架构

**三方角色**：
1. **Nano Auto**（Notion AI Agent）= 大脑：拆任务、写 Spec、检查定位代码问题、验收、管文档
2. **Runner**（AI 编程工具，如 Claude Code/Cursor/Qwen CLI）= 工程师：按 Spec 写代码
3. **David**（创始人）= 决策者：创建任务、验收确认

**任务流转状态机**：
```
编辑中 → 待启动 → Nano规划 → Runner开发 → Nano验收 → David验收 → 已完成
```

**Notion 是唯一真相源**：所有任务信息、Spec、验收标准都在 Notion 任务流水线数据库中。

## 快速入口

### 作为 Runner 执行任务
1. 读取任务页面的 `📋 任务 Spec` 选项卡
2. 按 Spec 实施代码修改与验证（不扩需求）
3. 完成 Git 交付：`git add` → `git commit` → `git push`
4. 输出自检清单（Spec编号 → 文件 → commit 改动 → PASS/SKIP/FAIL）
5. 更新 Notion：
   - 属性 `产出物`（PR/分支/commit）
   - 向 `🔧 Runner 执行日志` 追加结构化记录（12项骨架）
   - 状态流转：`Runner开发` → `Nano验收`

### Notion 日志写入铁律
- **只能追加，不能删除或修改已有内容**
- **必须使用** `update_content` 命令
- **绝对禁止**使用 `replace_content`（会删除整个页面历史）
- 匹配 Tab 标题 `\t\t🔧 **Runner 执行日志**` 作为锚点
- `new_str` 必须完整包含 `old_str` + `\n\n` + 新日志内容

## 详细规则与技能

完整规则和技能请查阅 `.claude/` 目录：

- **[.claude/rules.md](.claude/rules.md)** - 项目约束、编码规范、测试要求、Git 规范
- **[.claude/skills.md](.claude/skills.md)** - 领域知识、Notion MCP 交互、三方协作流程、开发模式

## 其他 AI CLI 工具的配置

本项目也支持其他 AI CLI 工具，配置位于：
- **Qwen CLI**：`.qwen/KAAS_RULES.md`（通用规则与技能）
- **Cursor**：`.cursor/.cursorrules` 和 `.cursor/rules/` 目录

## 设计不变量（关键）

1. **拦截点在最前**：进入任何 AI 调用前完成订阅状态、配额与限频校验
2. **幂等由 DB 兜底**：`usage_events.request_id` UNIQUE
3. **并发由原子 SQL 兜底**：预扣用单条 `UPDATE ... WHERE ...`
4. **可对账**：每次请求对应一条 `usage_event`
5. **失败不亏钱**：下游失败默认全额退款
6. **透支有上限**：credit line 允许短期放行，超额累计超过硬上限后强拦截

## 环境提示
- **禁止把任何东西放 C 盘**：项目代码放项目目录，其他软件装 D 盘其他位置
- 项目根目录：`D:\MyProject\kaas-platform\`

---

**使用提示**：将本文件内容作为 Claude Code 的上下文，或在对话中引用 `.claude/` 目录中的具体规则。