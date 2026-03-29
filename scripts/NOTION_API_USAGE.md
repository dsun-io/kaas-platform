# Notion API 使用指南

本目录包含两种访问 Notion 的方式，请根据场景选择合适的方式。

## 方式对比

| 特性 | 方式1: Notion MCP 服务器 | 方式2: Notion REST API |
|------|------------------------|------------------------|
| **技术基础** | Cursor MCP (Model Context Protocol) | HTTP REST API |
| **认证方式** | IDE 内置，无需手动配置 | 需要 `NOTION_TOKEN` |
| **使用场景** | Cursor Agent、KAAS 工作流 | 独立脚本、CI/CD、外部集成 |
| **配置复杂度** | ✅ 零配置 | ⚠️ 需要 Token |
| **适用环境** | Cursor IDE 内部 | 任何 Python 环境 |

## 方式1: Notion MCP 服务器（推荐）

### 适用场景
- 在 Cursor Agent 中自动化操作 Notion
- KAAS 工作流执行任务流水线
- 需要快速、零配置地读写 Notion

### 可用工具
位于 `.cursor/mcps/user-Notion/tools/`:
- `notion-search` - 搜索工作区内容
- `notion-fetch` - 获取页面/数据库详情
- `notion-create-pages` - 创建新页面
- `notion-update-page` - 更新页面内容
- `notion-query-database-view` - 查询数据库视图
- `notion-create-comment` - 添加评论
- 更多工具详见工具目录

### 使用示例
```python
# 在 Cursor Agent 中调用 MCP 工具
CallMcpTool("user-Notion", "notion-search", {
    "query": "任务流水线",
    "filters": {}
})

CallMcpTool("user-Notion", "notion-fetch", {
    "id": "页面ID或URL"
})

CallMcpTool("user-Notion", "notion-create-pages", {
    "parent": {"database_id": "数据库ID"},
    "pages": [{
        "properties": {"任务名": "新任务"},
        "content": "任务内容"
    }]
})
```

### 优势
- ✅ 开箱即用，无需配置
- ✅ 由 Cursor 管理认证
- ✅ 集成在 KAAS 工作流中

---

## 方式2: Notion REST API（独立脚本）

### 适用场景
- 独立运行 Python 脚本（不依赖 Cursor）
- CI/CD 流程中自动创建任务
- 批量操作 Notion
- 外部系统集成

### 需要配置
必须设置 `NOTION_TOKEN` 环境变量：

```powershell
# PowerShell
$env:NOTION_TOKEN = "secret_xxxxxxxxxxxxxxxxxxxxxxxx"

# CMD
set NOTION_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxx

# Linux/Mac
export NOTION_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxx
```

### 获取 Token
1. 访问 https://www.notion.so/my-integrations
2. 创建新的 integration
3. 复制 Token
4. 在 Notion 中分享数据库给该 integration

### 可用脚本

#### 1. create_notion_task.py
完整版任务创建脚本，支持自动发现数据库结构。

```bash
# 先设置 Token
$env:NOTION_TOKEN = "secret_xxx"

# 运行
python scripts/create_notion_task.py
```

#### 2. create_task_direct.py
无交互版本，快速创建任务。

```bash
$env:NOTION_TOKEN = "secret_xxx"
python scripts/create_task_direct.py
```

#### 3. create_urgent_task.py
紧急任务版，支持多途径获取 Token。

```bash
# 自动查找 Token（环境变量/.notion_token/.env）
python scripts/create_urgent_task.py

# 或手动设置后运行
$env:NOTION_TOKEN = "secret_xxx"
python scripts/create_urgent_task.py
```

### Token 获取优先级（create_urgent_task.py）
1. 环境变量 `NOTION_TOKEN` / `NOTION_API_KEY`
2. 项目根目录 `.notion_token` 文件
3. 各子项目 `.env` 文件
4. Windows CMD 环境变量

### 保存 Token 到本地文件
```python
# 创建 .notion_token 文件供后续使用
$token = "secret_xxxxxxxxxxxxxxxxxxxxxxxx"
$token | Out-File -FilePath ".notion_token" -Encoding utf8
```

---

## 快速选择指南

| 你在做什么？ | 推荐方式 | 具体使用 |
|-------------|---------|---------|
| 在 Cursor 中让 Agent 操作 Notion | **方式1** | `CallMcpTool("user-Notion", ...)` |
| 运行 KAAS 工作流 | **方式1** | KAAS 自动使用 MCP |
| 独立运行 Python 脚本 | **方式2** | `python scripts/create_task_direct.py` |
| CI/CD 中创建任务 | **方式2** | 设置 Token 后运行脚本 |
| 批量导入数据到 Notion | **方式2** | 使用 REST API 脚本 |
| 快速查询 Notion 内容 | **方式1** | MCP `notion-search` |

---

## 故障排查

### MCP 方式失败
1. 检查 Cursor MCP 配置: `.cursor/mcps/user-Notion/`
2. 确认 MCP 服务器已启用
3. 查看 Cursor 输出面板中的 MCP 日志

### REST API 方式失败
1. 检查 `NOTION_TOKEN` 是否设置: `$env:NOTION_TOKEN`
2. 确认 Integration 有数据库访问权限
3. 验证 Token 未过期
4. 查看脚本输出的 HTTP 错误码和响应

### 常见错误
- `401 Unauthorized` → Token 无效或未设置
- `403 Forbidden` → Integration 无权限访问该数据库
- `404 Not Found` → 数据库 ID 错误或数据库不存在
- `400 Bad Request` → 请求参数格式错误

---

## 相关文件

### MCP 方式
```
.cursor/mcps/user-Notion/
├── SERVER_METADATA.json
├── tools/
│   ├── notion-search.json
│   ├── notion-fetch.json
│   ├── notion-create-pages.json
│   └── ... (16个工具)
└── resources/
    └── ...
```

### REST API 方式
```
scripts/
├── create_notion_task.py      # 完整版
├── create_task_direct.py      # 无交互版
├── create_urgent_task.py      # 紧急任务版
└── NOTION_API_USAGE.md        # 本文档
```

---

## 参考文档

- [Notion REST API 文档](https://developers.notion.com/)
- [MCP 协议规范](https://modelcontextprotocol.io/)
- [Cursor MCP 集成指南](https://docs.cursor.com/mcp)
