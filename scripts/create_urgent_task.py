#!/usr/bin/env python3
"""
【Notion REST API 直接调用脚本 - 紧急任务版】
========================================
⚠️  本脚本使用 Notion REST API 直接调用，需要 NOTION_TOKEN
    支持多途径获取 Token（环境变量/.notion_token文件/.env文件）

🔀  两种 Notion 访问方式对比:
    ┌────────────────────────────────────────────────────────────────┐
    │ 方式1: Notion MCP 服务器 (Cursor 内置)                          │
    │   - 调用方式: CallMcpTool("user-Notion", "工具名", {...})       │
    │   - ✅ 无需配置，IDE 自动处理认证                               │
    │   - ✅ 工具: search, fetch, create-pages, update-page...        │
    │   - ✅ 用于 KAAS 自动化工作流                                   │
    ├────────────────────────────────────────────────────────────────┤
    │ 方式2: Notion REST API (本脚本使用)                             │
    │   - 调用方式: requests.post("https://api.notion.com/v1/...")   │
    │   - ⚠️ 需要 NOTION_TOKEN（本脚本支持多途径获取）                 │
    │   - 用于独立脚本运行、批量任务创建                               │
    └────────────────────────────────────────────────────────────────┘

Token 获取优先级:
  1. 环境变量 NOTION_TOKEN / NOTION_API_KEY
  2. 项目根目录 .notion_token 文件
  3. 各子项目 .env 文件
  4. Windows 环境变量（CMD）

何时使用本脚本 vs MCP:
- ✅ 需要批量创建任务 → 本脚本
- ✅ 在 CI/CD 流程中 → 本脚本
- ✅ 不依赖 Cursor IDE → 本脚本
- ❌ 在 Cursor Agent 中操作 → 使用 MCP 工具 (CallMcpTool)

相关文件:
- 方式1 MCP: .cursor/mcps/user-Notion/tools/
- 方式2 脚本: scripts/create_notion_task.py, scripts/create_task_direct.py
"""

import os
import sys
import json
import requests
from datetime import datetime
from pathlib import Path

# Notion API 配置
NOTION_API_BASE = "https://api.notion.com/v1"
DATABASE_ID = "fad40cb1006b4c71ab041a362a32334c"  # 任务流水线数据库ID


def get_notion_token():
    """
    尝试多种方式获取 Notion API Token
    优先级：环境变量 > .env文件 > 本地token文件 > 用户输入
    """
    token = None
    sources_checked = []

    # 1. 检查环境变量
    token = os.environ.get('NOTION_TOKEN') or os.environ.get('NOTION_API_KEY')
    if token:
        sources_checked.append("环境变量 ✓")
        return token, sources_checked
    sources_checked.append("环境变量 ✗")

    # 2. 检查项目根目录的 .notion_token 文件
    token_file = Path(__file__).parent.parent / '.notion_token'
    if token_file.exists():
        try:
            token = token_file.read_text().strip()
            if token:
                sources_checked.append(f"{token_file} ✓")
                return token, sources_checked
        except Exception as e:
            sources_checked.append(f".notion_token 文件读取失败: {e}")
    else:
        sources_checked.append(".notion_token 文件 ✗")

    # 3. 检查各个 .env 文件
    env_files = [
        Path(__file__).parent.parent / '.env',
        Path(__file__).parent.parent / 'msg-router' / '.env',
        Path(__file__).parent.parent / 'rpa-qianniu' / '.env',
        Path(__file__).parent.parent / 'rpa-pdd' / '.env',
    ]
    for env_file in env_files:
        if env_file.exists():
            try:
                content = env_file.read_text()
                for line in content.split('\n'):
                    if line.startswith('NOTION_TOKEN=') or line.startswith('NOTION_API_KEY='):
                        token = line.split('=', 1)[1].strip().strip('"\'')
                        if token:
                            sources_checked.append(f"{env_file} ✓")
                            return token, sources_checked
            except Exception as e:
                pass
    sources_checked.append("所有.env文件 ✗")

    # 4. 检查 Windows 凭据管理器（如果可用）
    try:
        import subprocess
        result = subprocess.run(
            ['cmd', '/c', 'echo %NOTION_TOKEN%'],
            capture_output=True, text=True
        )
        token = result.stdout.strip()
        if token and token != '%NOTION_TOKEN%':
            sources_checked.append("Windows环境变量 ✓")
            return token, sources_checked
    except Exception:
        pass
    sources_checked.append("Windows环境变量 ✗")

    return None, sources_checked


def save_token_locally(token):
    """保存 token 到本地文件供下次使用"""
    token_file = Path(__file__).parent.parent / '.notion_token'
    try:
        token_file.write_text(token)
        print(f"✓ Token 已保存到: {token_file}")
        print(f"  下次运行将自动读取")
        return True
    except Exception as e:
        print(f"✗ 保存 Token 失败: {e}")
        return False


def save_task_locally(task_info):
    """如果无法创建 Notion 任务，保存到本地文件"""
    backup_dir = Path(__file__).parent.parent / 'data'
    backup_dir.mkdir(exist_ok=True)

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_file = backup_dir / f'notion_task_{timestamp}.json'

    try:
        with open(backup_file, 'w', encoding='utf-8') as f:
            json.dump(task_info, f, ensure_ascii=False, indent=2)
        print(f"✓ 任务信息已备份到: {backup_file}")
        return backup_file
    except Exception as e:
        print(f"✗ 备份任务信息失败: {e}")
        return None


def get_headers(token):
    """获取 API 请求头"""
    return {
        'Authorization': f'Bearer {token}',
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
    }


def create_task(token, task_info):
    """创建任务页面"""
    url = f"{NOTION_API_BASE}/pages"
    headers = get_headers(token)

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

    # 构建页面内容（任务 Spec）
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M')
    children = [
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"type": "text", "text": {"content": "📋 任务 Spec"}}]
            }
        },
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "异常描述"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": f"发现时间: {timestamp}"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "发现方式: 代码审查/架构分析"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "影响模块: rpa-qianniu, rpa-pdd"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "尝试次数: 0"}}]
            }
        },
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "错误详情"}}]
            }
        },
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": "异常类型: DesignError - 模块导入设计缺陷"}}]
            }
        },
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "错误信息"}}]
            }
        },
        {
            "object": "block",
            "type": "code",
            "code": {
                "language": "text",
                "rich_text": [{"type": "text", "text": {"content": """rpa-qianniu 和 rpa-pdd 模块存在导入设计问题：
1. 类式API设计与函数式实现不匹配
2. 模块导入依赖关系混乱
3. 可能存在循环导入风险
4. 需要重新设计模块结构以符合Clean Architecture原则"""}}]
            }
        },
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "复现步骤"}}]
            }
        },
        {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "进入 rpa-qianniu 项目目录"}}]
            }
        },
        {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "尝试导入 app.screenshot 模块"}}]
            }
        },
        {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "观察导入错误和设计问题"}}]
            }
        },
        {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "检查 rpa-pdd 模块是否有类似问题"}}]
            }
        },
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "预期行为"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "模块导入应清晰、无循环依赖"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "API设计应一致（类式API应配合类式实现）"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "遵循单一职责原则"}}]
            }
        },
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "实际行为"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "类式API设计但使用函数式实现"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "导入依赖关系不清晰"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "可能存在隐含的循环导入"}}]
            }
        },
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "建议方向"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "架构重构: 将函数式实现改为类式实现，与API设计保持一致"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "模块分离: 将公共工具函数提取到独立的utils模块"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "依赖清理: 梳理并优化模块间的导入关系"}}]
            }
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": "接口设计: 明确每个模块的公共接口和内部实现"}}]
            }
        },
        {
            "object": "block",
            "type": "divider",
            "divider": {}
        },
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"type": "text", "text": {"content": "📝 执行日志"}}]
            }
        },
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": f"[Nano] {timestamp} 创建任务，状态: Nano规划"}}]
            }
        }
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
    print("Notion 紧急任务创建工具")
    print("=" * 60)
    print()

    # 尝试获取 Token
    print("[1/5] 查找 Notion Token...")
    token, sources = get_notion_token()

    for source in sources:
        print(f"  {source}")

    if not token:
        print()
        print("=" * 60)
        print("⚠ 未找到 Notion Token")
        print("=" * 60)
        print()
        print("获取 Token 的方法:")
        print("1. 访问 https://www.notion.so/my-integrations")
        print("2. 创建一个新的 integration")
        print("3. 复制 Token")
        print()
        print("设置 Token 的方法（任选其一）:")
        print("- 设置环境变量: $env:NOTION_TOKEN = 'your_token'")
        print("- 创建 .notion_token 文件在项目根目录")
        print("- 在本脚本运行时输入（会保存到 .notion_token）")
        print()

        # 提示用户输入
        try:
            token = input("请输入 Notion Token（或直接回车跳过）: ").strip()
        except KeyboardInterrupt:
            print("\n用户取消输入")
            token = None

        if not token:
            print("\n⚠ 没有 Token，将保存任务到本地文件")
            save_local_only = True
        else:
            save_token_locally(token)
            save_local_only = False
    else:
        print(f"✓ Token 已找到: {token[:10]}...{token[-4:]}")
        save_local_only = False

    # 任务信息
    task_info = {
        'task_name': '[Cursor异常援助] rpa-qianniu 和 rpa-pdd 导入设计问题',
        'status': 'Nano规划',
        'priority': 'P0',
        'task_type': 'Bug修复',
        'modules': ['rpa-qianniu', 'rpa-pdd']
    }

    print()
    print("[2/5] 准备任务信息...")
    print(f"  任务名: {task_info['task_name']}")
    print(f"  状态: {task_info['status']}")
    print(f"  优先级: {task_info['priority']}")
    print(f"  任务类型: {task_info['task_type']}")
    print(f"  关联模块: {', '.join(task_info['modules'])}")

    if save_local_only:
        print()
        print("[3/5] 保存任务到本地（无Token模式）...")
        backup_file = save_task_locally(task_info)
        if backup_file:
            print()
            print("=" * 60)
            print("✓ 任务已保存到本地")
            print("=" * 60)
            print(f"文件路径: {backup_file}")
            print()
            print("后续操作:")
            print("1. 获取 Notion Token")
            print("2. 重新运行此脚本")
            print("3. 或使用备份文件手动创建任务")
        else:
            print("\n✗ 保存失败")
            sys.exit(1)
    else:
        print()
        print("[3/5] 调用 Notion API 创建任务...")
        response = create_task(token, task_info)

        if response.status_code == 200:
            data = response.json()
            page_id = data['id']
            page_url = data.get('url', f"https://notion.so/{page_id.replace('-', '')}")

            print()
            print("=" * 60)
            print("✓ 任务创建成功!")
            print("=" * 60)
            print(f"任务ID: {page_id}")
            print(f"任务URL: {page_url}")
            print("=" * 60)

            # 保存成功记录
            task_info['notion_page_id'] = page_id
            task_info['notion_url'] = page_url
            task_info['created_at'] = datetime.now().isoformat()
            save_task_locally(task_info)

        else:
            print()
            print("=" * 60)
            print(f"✗ 创建任务失败: HTTP {response.status_code}")
            print("=" * 60)
            print(f"响应内容: {response.text}")
            print()
            print("可能的原因:")
            print("- Token 无效或已过期")
            print("- Integration 没有访问数据库的权限")
            print("- 数据库 ID 不正确")
            print()
            print("正在保存任务到本地...")
            backup_file = save_task_locally(task_info)
            if backup_file:
                print(f"✓ 已备份到: {backup_file}")


if __name__ == "__main__":
    main()
