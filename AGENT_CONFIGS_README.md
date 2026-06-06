# AI Agent 配置归档说明

## 概述
为保持项目根目录整洁，已将其他 AI CLI 工具的配置归档到 `archive/agent-configs/` 目录。

## 归档的配置

| 工具 | 原位置 | 归档位置 | README文件 |
|------|--------|----------|------------|
| Cursor | `.cursor/` | `archive/agent-configs/.cursor/` | `.cursor.README.md` |
| Qwen CLI | `.qwen/` | `archive/agent-configs/.qwen/` | `.qwen.README.md` |
| CodeBuddy | `.codebuddy/` | `archive/agent-configs/.codebuddy/` | `.codebuddy.README.md` |
| Aider | `.aider.conf.yml` | `archive/misc-configs/` | (无 README) |
| 工具 README 文件 | `.codebuddy.README.md`<br>`.cursor.README.md`<br>`.qwen.README.md` | `archive/READMEs/` | (已移动) |

## 当前使用的工具
**Claude Code** 现在是主要的 AI 编程 Runner 工具，配置位于：
- `.claude/rules.md` - 项目约束规则
- `.claude/skills.md` - 项目技能与工作流
- `CLAUDE.md` - 根目录配置文件

## 恢复方法
如需恢复使用某个工具，请将对应目录移回原位置：
```bash
# 恢复 Cursor
mv archive/agent-configs/.cursor .cursor

# 恢复 Qwen CLI  
mv archive/agent-configs/.qwen .qwen

# 恢复 CodeBuddy
mv archive/agent-configs/.codebuddy .codebuddy
```

## 配置整合说明
Qwen CLI 的通用规则 (`KAAS_RULES.md`) 已整合到 Claude Code 的配置中：
- 规则部分 → `.claude/rules.md`
- 技能部分 → `.claude/skills.md`

Cursor 的工作流技能 (`SKILL.md`) 和规则文件已作为参考保留在归档中。

## 其他配置
- `.aider.conf.yml` - Aider 配置文件（已移至 `archive/misc-configs/`）
- `.codebuddy.README.md`, `.cursor.README.md`, `.qwen.README.md` - 工具说明文件（已移至 `archive/READMEs/`）
- `.claude-memory/` - 空的 Claude 内存目录（已删除）
- `.github/` - GitHub 工作流配置
- `.git/` - Git 仓库数据
- `.mcp.json` - Notion MCP 服务器配置（保留在根目录）