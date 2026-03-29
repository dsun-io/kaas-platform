#!/usr/bin/env python3
"""
【Notion REST API 直接调用脚本 - 无交互版本】
========================================
⚠️  本脚本使用 Notion REST API 直接调用，需要 NOTION_TOKEN 环境变量

🔀  两种 Notion 访问方式对比:
    ┌────────────────────────────────────────────────────────────────┐
    │ 方式1: Notion MCP 服务器 (Cursor 内置) ✅ 推荐                  │
    │   - 通过 Cursor MCP 调用: CallMcpTool("user-Notion", ...)      │
    │   - 工具: notion-search, notion-fetch, notion-create-pages     │
    │   - ✅ 不需要 Token，开箱即用                                  │
    │   - ✅ 用于 KAAS 工作流自动化                                   │
    ├────────────────────────────────────────────────────────────────┤
    │ 方式2: Notion REST API (本脚本使用) ⚠️ 需要 Token               │
    │   - 直接 HTTP 调用 https://api.notion.com/v1                   │
    │   - ⚠️ 必须设置 NOTION_TOKEN 环境变量                          │
    │   - 用于独立脚本、CI/CD、外部集成                               │
    └────────────────────────────────────────────────────────────────┘

使用方法:
1. 先设置 NOTION_TOKEN 环境变量:
   PowerShell: $env:NOTION_TOKEN = "secret_xxx"

2. 然后运行:
   python scripts/create_task_direct.py

何时使用本脚本:
- ❌ 如果你在使用 Cursor Agent 或 KAAS 工作流 → 使用 MCP 工具 (方式1)
- ✅ 如果你需要独立运行 Python 脚本 → 使用本脚本 (方式2)
- ✅ 如果你在 CI/CD 流程中 → 使用本脚本 (方式2)

相关文档:
- Notion MCP 工具: .cursor/mcps/user-Notion/tools/
- REST API 文档: https://developers.notion.com/
"""

import os
import sys
import json
import requests
from datetime import datetime
from pathlib import Path

# 任务流水线数据库ID
DATABASE_ID = "fad40cb1006b4c71ab041a362a32334c"
NOTION_API_BASE = "https://api.notion.com/v1"

# 任务信息
TASK_INFO = {
    'task_name': '[Cursor异常援助] rpa-qianniu 和 rpa-pdd 导入设计问题',
    'status': 'Nano规划',
    'priority': 'P0',
    'task_type': 'Bug修复',
    'modules': ['rpa-qianniu', 'rpa-pdd']
}


def get_token():
    """获取 Token（仅环境变量）"""
    return os.environ.get('NOTION_TOKEN') or os.environ.get('NOTION_API_KEY')


def save_local(task_info):
    """保存到本地文件"""
    backup_dir = Path(__file__).parent.parent / 'data'
    backup_dir.mkdir(exist_ok=True)

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_file = backup_dir / f'task_{timestamp}.json'

    task_info['created_at'] = datetime.now().isoformat()

    with open(backup_file, 'w', encoding='utf-8') as f:
        json.dump(task_info, f, ensure_ascii=False, indent=2)

    return backup_file


def create_notion_task(token, task_info):
    """创建 Notion 任务"""
    url = f"{NOTION_API_BASE}/pages"
    headers = {
        'Authorization': f'Bearer {token}',
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
    }

    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M')

    # 构建属性
    properties = {
        '任务名': {
            'title': [{'text': {'content': task_info['task_name']}}]
        },
        '状态': {
            'select': {'name': task_info['status']}
        },
        '优先级': {
            'select': {'name': task_info['priority']}
        },
        '任务类型': {
            'select': {'name': task_info['task_type']}
        },
        '关联模块': {
            'multi_select': [{'name': m} for m in task_info['modules']]
        }
    }

    # 构建页面内容
    children = [
        {"object": "block", "type": "heading_2", "heading_2": {"rich_text": [{"type": "text", "text": {"content": "📋 任务 Spec"}}]}},
        {"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"type": "text", "text": {"content": "异常描述"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": f"发现时间: {timestamp}"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "发现方式: 代码审查/架构分析"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "影响模块: rpa-qianniu, rpa-pdd"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "尝试次数: 0"}}]}},
        {"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"type": "text", "text": {"content": "错误详情"}}]}},
        {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": "异常类型: DesignError - 模块导入设计缺陷"}}]}},
        {"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"type": "text", "text": {"content": "错误信息"}}]}},
        {"object": "block", "type": "code", "code": {"language": "text", "rich_text": [{"type": "text", "text": {"content": """rpa-qianniu 和 rpa-pdd 模块存在导入设计问题：
1. 类式API设计与函数式实现不匹配
2. 模块导入依赖关系混乱
3. 可能存在循环导入风险
4. 需要重新设计模块结构以符合Clean Architecture原则"""}}]}},
        {"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"type": "text", "text": {"content": "复现步骤"}}]}},
        {"object": "block", "type": "numbered_list_item", "numbered_list_item": {"rich_text": [{"type": "text", "text": {"content": "进入 rpa-qianniu 项目目录"}}]}},
        {"object": "block", "type": "numbered_list_item", "numbered_list_item": {"rich_text": [{"type": "text", "text": {"content": "尝试导入 app.screenshot 模块"}}]}},
        {"object": "block", "type": "numbered_list_item", "numbered_list_item": {"rich_text": [{"type": "text", "text": {"content": "观察导入错误和设计问题"}}]}},
        {"object": "block", "type": "numbered_list_item", "numbered_list_item": {"rich_text": [{"type": "text", "text": {"content": "检查 rpa-pdd 模块是否有类似问题"}}]}},
        {"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"type": "text", "text": {"content": "预期行为"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "模块导入应清晰、无循环依赖"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "API设计应一致（类式API应配合类式实现）"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "遵循单一职责原则"}}]}},
        {"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"type": "text", "text": {"content": "实际行为"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "类式API设计但使用函数式实现"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "导入依赖关系不清晰"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "可能存在隐含的循环导入"}}]}},
        {"object": "block", "type": "heading_3", "heading_3": {"rich_text": [{"type": "text", "text": {"content": "建议方向"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "架构重构: 将函数式实现改为类式实现，与API设计保持一致"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "模块分离: 将公共工具函数提取到独立的utils模块"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "依赖清理: 梳理并优化模块间的导入关系"}}]}},
        {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": "接口设计: 明确每个模块的公共接口和内部实现"}}]}},
        {"object": "block", "type": "divider", "divider": {}},
        {"object": "block", "type": "heading_2", "heading_2": {"rich_text": [{"type": "text", "text": {"content": "📝 执行日志"}}]}},
        {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": f"[Nano] {timestamp} 创建任务，状态: Nano规划"}}]}}
    ]

    payload = {
        "parent": {"database_id": DATABASE_ID},
        "properties": properties,
        "children": children
    }

    response = requests.post(url, headers=headers, json=payload)
    return response


def main():
    print("=" * 60)
    print("Notion 任务创建工具（直接版）")
    print("=" * 60)
    print()

    # 检查 Token
    token = get_token()

    if not token:
        print("⚠ 未找到 NOTION_TOKEN 环境变量")
        print()
        print("请先设置 Token:")
        print("  PowerShell: $env:NOTION_TOKEN = 'secret_xxxxx'")
        print("  CMD: set NOTION_TOKEN=secret_xxxxx")
        print()
        print("获取 Token:")
        print("  1. 访问 https://www.notion.so/my-integrations")
        print("  2. 创建 integration")
        print("  3. 复制 Token")
        print()

        # 保存到本地
        print("正在保存任务到本地文件...")
        backup_file = save_local(TASK_INFO)
        print(f"✓ 已保存: {backup_file}")
        print()
        print("请设置 Token 后重新运行脚本")
        sys.exit(1)

    print(f"✓ Token 已找到: {token[:10]}...{token[-4:]}")
    print()

    # 显示任务信息
    print("任务信息:")
    for k, v in TASK_INFO.items():
        if k == 'modules':
            print(f"  {k}: {', '.join(v)}")
        else:
            print(f"  {k}: {v}")
    print()

    # 创建任务
    print("正在创建 Notion 任务...")
    response = create_notion_task(token, TASK_INFO)

    if response.status_code == 200:
        data = response.json()
        page_id = data['id']
        page_url = data.get('url')

        print()
        print("=" * 60)
        print("✓ 任务创建成功!")
        print("=" * 60)
        print(f"任务ID: {page_id}")
        print(f"任务URL: {page_url}")
        print("=" * 60)

        # 保存记录
        TASK_INFO['notion_page_id'] = page_id
        TASK_INFO['notion_url'] = page_url
        save_local(TASK_INFO)

    else:
        print()
        print(f"✗ 创建失败: HTTP {response.status_code}")
        print(f"响应: {response.text}")
        print()
        print("可能原因:")
        print("- Token 无效")
        print("- Integration 无数据库权限")
        print("- 数据库 ID 错误")
        print()
        print("保存任务到本地...")
        backup_file = save_local(TASK_INFO)
        print(f"✓ 已保存: {backup_file}")
        sys.exit(1)


if __name__ == "__main__":
    main()
