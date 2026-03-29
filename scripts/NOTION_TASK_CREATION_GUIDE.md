# Notion 任务创建指南

## 当前状态

任务信息已保存到本地文件：
- **文件路径**: `data/task_20260329_140218.json`
- **任务名**: [Cursor异常援助] rpa-qianniu 和 rpa-pdd 导入设计问题
- **状态**: Nano规划
- **优先级**: P0
- **任务类型**: Bug修复
- **关联模块**: rpa-qianniu, rpa-pdd

## 如何获取 Notion Token

### 方法 1: 创建 Notion Integration（推荐）

1. 访问 [Notion Integrations](https://www.notion.so/my-integrations)
2. 点击 "New integration"
3. 填写信息：
   - 名称：KAAS Task Manager
   - 关联的工作区：选择你的工作区
4. 点击 "Submit"
5. 复制 "Internal Integration Token"（格式: `secret_xxxxxxxx`）

### 方法 2: 分享数据库给 Integration

1. 在 Notion 中打开 "任务流水线" 数据库
2. 点击右上角的 "..."（更多）
3. 选择 "Add connections"
4. 搜索并选择你创建的 "KAAS Task Manager"
5. 确认添加

## 如何设置 Token 并创建任务

### PowerShell（推荐）

```powershell
# 设置环境变量（临时，当前窗口有效）
$env:NOTION_TOKEN = "secret_xxxxx"

# 运行创建脚本
cd d:\MyProject\kaas-platform
python scripts\create_task_direct.py
```

### CMD

```cmd
# 设置环境变量
set NOTION_TOKEN=secret_xxxxx

# 运行创建脚本
cd d:\MyProject\kaas-platform
python scripts\create_task_direct.py
```

### 永久设置环境变量（Windows）

```powershell
# 用户级别（推荐）
[Environment]::SetEnvironmentVariable("NOTION_TOKEN", "secret_xxxxx", "User")

# 系统级别（需要管理员权限）
[Environment]::SetEnvironmentVariable("NOTION_TOKEN", "secret_xxxxx", "Machine")
```

## 任务 Spec 内容（手动复制备用）

如果自动创建失败，可以手动复制以下内容到 Notion 任务页面：

```markdown
## 📋 任务 Spec

### 异常描述
- **发现时间**: 2026-03-29 14:02
- **发现方式**: 代码审查/架构分析
- **影响模块**: rpa-qianniu, rpa-pdd
- **尝试次数**: 0

### 错误详情
#### 异常类型
`DesignError` - 模块导入设计缺陷

#### 错误信息
```
rpa-qianniu 和 rpa-pdd 模块存在导入设计问题：
1. 类式API设计与函数式实现不匹配
2. 模块导入依赖关系混乱
3. 可能存在循环导入风险
4. 需要重新设计模块结构以符合Clean Architecture原则
```

### 运行时上下文
- **执行的命令**: `python -c "from app.screenshot import *"`
- **环境状态**: 本地开发环境 / Windows 10
- **相关配置**: 无特殊配置

## 复现步骤
1. 进入 rpa-qianniu 项目目录
2. 尝试导入 `app.screenshot` 模块
3. 观察导入错误和设计问题
4. 检查 rpa-pdd 模块是否有类似问题

## 预期行为
- 模块导入应清晰、无循环依赖
- API设计应一致（类式API应配合类式实现）
- 遵循单一职责原则
- 符合项目架构规范

## 实际行为
- 类式API设计但使用函数式实现
- 导入依赖关系不清晰
- 可能存在隐含的循环导入

## 已尝试的修复
暂无

## 相关日志
```
待补充具体错误日志
```

## 建议方向（供Nano参考）
1. **架构重构**: 将函数式实现改为类式实现，与API设计保持一致
2. **模块分离**: 将公共工具函数提取到独立的utils模块
3. **依赖清理**: 梳理并优化模块间的导入关系
4. **接口设计**: 明确每个模块的公共接口和内部实现
5. **测试覆盖**: 添加导入测试用例，防止回归

---

## 📝 执行日志

[Nano] 2026-03-29 14:02 创建任务，状态: Nano规划
```

## 脚本文件说明

| 文件 | 说明 |
|------|------|
| `create_notion_task.py` | 完整版脚本，支持搜索数据库、自动匹配属性 |
| `create_urgent_task.py` | 交互式脚本，支持用户输入 Token |
| `create_task_direct.py` | 直接版脚本，无交互，需要预设环境变量 |

## 常见问题

### Q: 401 Unauthorized 错误
A: Token 无效，请检查：
- Token 是否复制完整（以 `secret_` 开头）
- Integration 是否已添加到数据库的连接中

### Q: 404 Not Found 错误
A: 数据库 ID 错误或 Integration 没有权限访问该数据库

### Q: 400 Bad Request 错误
A: 属性名称或类型不匹配，检查数据库的字段名称

### Q: 无法连接到 Notion API
A: 检查网络连接，可能需要代理

## API 调用示例（Python）

```python
import requests

headers = {
    'Authorization': 'Bearer secret_xxxxx',
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
}

# 创建任务
data = {
    'parent': {'database_id': 'fad40cb1006b4c71ab041a362a32334c'},
    'properties': {
        '任务名': {'title': [{'text': {'content': '[Cursor异常援助] ...'}}]},
        '状态': {'select': {'name': 'Nano规划'}},
        '优先级': {'select': {'name': 'P0'}},
        '任务类型': {'select': {'name': 'Bug修复'}},
        '关联模块': {'multi_select': [{'name': 'rpa-qianniu'}, {'name': 'rpa-pdd'}]}
    }
}

response = requests.post(
    'https://api.notion.com/v1/pages',
    headers=headers,
    json=data
)
print(response.json())
```

## 联系支持

如有问题，请联系项目管理员获取 Integration Token 或数据库权限。
