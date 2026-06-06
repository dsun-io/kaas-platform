#!/usr/bin/env python3
"""
【Notion REST API 直接调用脚本】
========================================
⚠️  本脚本使用 Notion REST API (https://api.notion.com/v1) 直接调用
    需要 NOTION_TOKEN 环境变量才能工作

🔀  两种 Notion 访问方式对比:
    ┌────────────────────────────────────────────────────────────────┐
    │ 方式1: Notion MCP 服务器 (Cursor 内置)                         │
    │   - 由 Cursor IDE 提供，通过 CallMcpTool 调用                  │
    │   - 工具: notion-search, notion-fetch, notion-create-pages...  │
    │   - ✅ 不需要 NOTION_TOKEN，开箱即用                            │
    │   - ✅ 用于 KAAS 工作流、Cursor Agent 自动化                   │
    │   - 📍 位置: .cursor/mcps/user-Notion/                         │
    ├────────────────────────────────────────────────────────────────┤
    │ 方式2: Notion REST API (本脚本使用)                             │
    │   - 直接调用 https://api.notion.com/v1                         │
    │   - ⚠️ 需要 NOTION_TOKEN 环境变量                              │
    │   - 用于独立 Python 脚本、外部工具集成                         │
    │   - 📚 文档: https://developers.notion.com/                    │
    └────────────────────────────────────────────────────────────────┘

使用方法:
1. 设置环境变量（以下方式任选其一）:
   - Windows PowerShell: $env:NOTION_TOKEN = "your_token_here"
   - Windows CMD: set NOTION_TOKEN=your_token_here
   - Linux/Mac: export NOTION_TOKEN=your_token_here

2. 运行脚本:
   python scripts/create_notion_task.py

3. 获取Notion Token:
   - 访问 https://www.notion.so/my-integrations
   - 创建一个新的integration
   - 复制Token并设置到环境变量
   - 在Notion中分享"任务流水线"数据库给这个integration

配置说明:
- 修改 task_info 字典可以自定义任务信息
- 支持的任务属性: 任务名、状态、优先级、任务类型、关联模块

相关文件:
- 本脚本: 方式2 (REST API 直接调用)
- create_task_direct.py: 方式2 (REST API 直接调用)
- create_urgent_task.py: 方式2 (REST API 直接调用)
- .cursor/mcps/user-Notion/: 方式1 (MCP 服务器)
"""

import os
import sys
import json
import requests
from datetime import datetime

# Notion API配置
NOTION_API_BASE = "https://api.notion.com/v1"
DATABASE_NAME = "任务流水线"


def get_notion_token():
    """获取Notion API Token"""
    token = os.environ.get('NOTION_TOKEN') or os.environ.get('NOTION_API_KEY')
    if not token:
        print("错误: 未找到Notion API Token")
        print("请设置环境变量 NOTION_TOKEN 或 NOTION_API_KEY")
        sys.exit(1)
    return token


def get_headers(token):
    """获取API请求头"""
    return {
        'Authorization': f'Bearer {token}',
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
    }


def search_database(token, db_name):
    """搜索数据库"""
    url = f"{NOTION_API_BASE}/search"
    headers = get_headers(token)

    payload = {
        "query": db_name,
        "filter": {
            "value": "database",
            "property": "object"
        }
    }

    response = requests.post(url, headers=headers, json=payload)
    if response.status_code != 200:
        print(f"搜索数据库失败: {response.status_code}")
        print(response.text)
        return None

    data = response.json()
    results = data.get('results', [])

    for db in results:
        title_parts = db.get('title', [])
        title = ''.join([t.get('plain_text', '') for t in title_parts])
        if title == db_name:
            return db

    return None


def get_database_schema(token, db_id):
    """获取数据库结构"""
    url = f"{NOTION_API_BASE}/databases/{db_id}"
    headers = get_headers(token)

    response = requests.get(url, headers=headers)
    if response.status_code != 200:
        print(f"获取数据库结构失败: {response.status_code}")
        print(response.text)
        return None

    return response.json()


def create_task(token, db_id, schema, task_info):
    """创建任务页面"""
    url = f"{NOTION_API_BASE}/pages"
    headers = get_headers(token)

    # 构建属性
    properties = {}

    # 遍历数据库schema，找到对应的属性
    for prop_name, prop_schema in schema.get('properties', {}).items():
        prop_type = prop_schema.get('type')

        # 任务名 (title类型)
        if prop_type == 'title' and '任务名' in prop_name:
            properties[prop_name] = {
                "title": [{"text": {"content": task_info['task_name']}}]
            }

        # 状态 (status类型)
        elif prop_type == 'status' and '状态' in prop_name:
            properties[prop_name] = {
                "status": {"name": task_info['status']}
            }

        # 优先级 (select类型)
        elif prop_type == 'select' and '优先级' in prop_name:
            properties[prop_name] = {
                "select": {"name": task_info['priority']}
            }

        # 任务类型 (select类型)
        elif prop_type == 'select' and '任务类型' in prop_name:
            properties[prop_name] = {
                "select": {"name": task_info['task_type']}
            }

        # 关联模块 (multi_select类型)
        elif prop_type == 'multi_select' and '关联模块' in prop_name:
            properties[prop_name] = {
                "multi_select": [
                    {"name": m} for m in task_info['modules']
                ]
            }

    # 页面内容 - 任务Spec
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M')
    content = f"""## 📋 任务 Spec

### 异常描述
- **发现时间**: {timestamp}
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

[Nano] {timestamp} 创建任务，状态: Nano规划

"""

    payload = {
        "parent": {"database_id": db_id},
        "properties": properties,
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": "任务已创建，等待规划。"}}]
                }
            }
        ]
    }

    # 如果需要更复杂的内容，可以使用更详细的块结构
    # 这里简化处理

    response = requests.post(url, headers=headers, json=payload)
    if response.status_code != 200:
        print(f"创建任务失败: {response.status_code}")
        print(response.text)
        return None

    return response.json()


def main():
    print("=" * 60)
    print("Notion任务创建工具")
    print("=" * 60)

    # 1. 获取Token
    token = get_notion_token()
    print(f"✓ Notion Token: {token[:10]}...{token[-4:]}")

    # 2. 搜索数据库
    print(f"\n[1/4] 搜索数据库 '{DATABASE_NAME}'...")
    db = search_database(token, DATABASE_NAME)
    if not db:
        print(f"错误: 找不到数据库 '{DATABASE_NAME}'")
        sys.exit(1)

    db_id = db['id']
    print(f"✓ 找到数据库: {db_id}")

    # 3. 获取数据库结构
    print(f"\n[2/4] 获取数据库结构...")
    schema = get_database_schema(token, db_id)
    if not schema:
        sys.exit(1)

    print("数据库属性:")
    for prop_name, prop_info in schema.get('properties', {}).items():
        prop_type = prop_info.get('type')
        if prop_type in ['title', 'status', 'select', 'multi_select']:
            print(f"  - {prop_name}: {prop_type}")

    # 4. 创建任务
    print(f"\n[3/4] 创建任务...")

    # 任务配置 - 用户可修改此处
    task_info = {
        'task_name': '[Cursor异常援助] rpa-qianniu 和 rpa-pdd 导入设计问题 - 类式API与函数式实现不匹配',
        'status': 'Nano规划',
        'priority': 'P0',
        'task_type': 'Bug修复',
        'modules': ['rpa-qianniu', 'rpa-pdd']
    }

    page = create_task(token, db_id, schema, task_info)
    if not page:
        sys.exit(1)

    page_id = page['id']
    page_url = page.get('url', f"https://notion.so/{page_id.replace('-', '')}")

    print(f"\n[4/4] 任务创建成功!")
    print("=" * 60)
    print(f"任务ID: {page_id}")
    print(f"任务URL: {page_url}")
    print("=" * 60)

    return page_id, page_url


if __name__ == "__main__":
    main()
