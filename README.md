# Kaas Platform v2

> **Knowledge as a Service** - 智能电商客服能力托管平台 (SaaS)
> 
> 本项目已进入 **v2.0 架构重构阶段**。基于混合架构、Orchestrator 编排器、FastGPT 以及 CoR (Chain of Role) 技术栈进行全面重编。

---

## 🏗️ 项目架构 (v2.0)

本项目采用前后端分离的现代架构：

- **`frontend/`**: 管理与监控后台。用于配置 AI 知识库、监控对话流以及可视化 RPA 状态。
- **`backend/`**: 核心逻辑服务。
  - **Orchestrator**: 核心调度，控制消息流转。
  - **CoR (Chain of Role)**: 基于角色链的复杂意图处理。
  - **FastGPT API**: 知识库与基础对话引擎集成。
- **`.ai/`**: AI 辅助开发的核心规则与技能配置 (由AI 助手读取)。

---

## 🛠️ 分支策略

- **`main`**: 纯净基座，仅存放项目级规则与经过验证的交付版本。
- **`feature/v2-refactor`**: 当前 v2 架构重构主分支。
- **`archive/`**: 历史 (v1) 版本的备份。

---

## 协作规范

1. **AI First**: 开发过程深度结合 AI 助手，遵守 `.qwen/KAAS_RULES.md` 中的开发约束。
2. **Atomic Commits**: 保持提交原子化，明确标注 `feat`, `fix`, `chore` 等类型。

---

**最后更新**: 2026-05-02
**维护者**: David + Antigravity (AI)
