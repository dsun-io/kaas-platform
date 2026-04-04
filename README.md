# KaaS Platform

> **Knowledge as a Service** - 传统制造业 AI 岗位能力托管平台
> 
> 首先做丝网行业的 AI 智能客服，SaaS 订阅模式。

---

## 项目状态

**当前阶段**：MVP Demo 验证期

**Demo 方向**：丝网报价小助手

**main 分支**：✅ 永远可交付状态

---

## 分支策略（v1.0）

本项目严格遵守 [Git 分支策略与合并规范](.qwen/GIT_BRANCH_STRATEGY.md)：

- **main**：永远可交付，只接受通过 Nano + David 验收的功能分支
- **feat/***：功能开发分支，一任务一分支
- **fix/***：Bug 修复分支
- **docs/***：纯文档任务分支
- **archive/***：废弃但保留参考的分支

**禁止**：
- ❌ 直接 push 到 main
- ❌ 长期功能分支（> 2 周不合并）
- ❌ develop/staging 等长期开发分支

---

## 代码结构

```
kaas-platform/
├── msg-router/              # 消息路由服务（FastAPI）
├── rpa-qianniu/             # 千牛 RPA（待验证后合并到main）
├── rpa-pdd/                 # 拼多多 RPA（待验证后合并到main）
├── scripts/                 # 运维脚本
├── .qwen/                   # AI CLI 规则与技能
│   ├── KAAS_RULES.md        # 通用Rules（项目约束）
│   ├── KAAS_SKILL.md        # 通用Skill（工作流编排）
│   └── GIT_BRANCH_STRATEGY.md  # Git分支策略（铁律）
└── .cursor/                 # Cursor 专用配置
```

---

## 协作流程

1. **Nano Auto**（Notion AI Agent）= 大脑：拆任务、写 Spec、验收、管文档
2. **Runner**（AI 编程工具）= 工程师：按 Spec 写代码
3. **David**（创始人）= 决策者：创建任务、验收确认

**任务流转**：
```
Nano规划 → Runner开发 → Nano验收 → David验收 → 合并到main → 删除分支
```

---

## 快速开始

### Demo 阶段（本地开发）

```bash
# 1. 安装依赖
cd msg-router
pip install -r requirements.txt

# 2. 配置环境变量
copy .env.example .env
# 编辑 .env，填入 FASTGPT_API_KEY

# 3. 启动服务
uvicorn app.main:app --port 8000

# 4. 健康检查
curl http://localhost:8000/health
```

---

## 相关链接

- **GitHub**：https://github.com/davidsun0124/kaas-platform
- **Notion 任务流水线**：https://www.notion.so/fad40cb1006b4c71ab041a362a32334c
- **FastGPT**：https://cloud.fastgpt.cn

---

**最后更新**：2026-04-04
**维护者**：David + Nano Auto + Runner
