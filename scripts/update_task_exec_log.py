#!/usr/bin/env python3
"""
【更新任务执行日志脚本】
========================================
使用 Notion REST API 直接更新全量回归任务的 Runner 执行日志

使用方法:
1. 设置环境变量: $env:NOTION_TOKEN = "your_token_here"
2. 运行: python scripts/update_task_exec_log.py
"""

import os
import sys
import requests
from datetime import datetime

NOTION_API_BASE = "https://api.notion.com/v1"
PAGE_ID = "d82ea2414cfd4ddf8ba19f48f1d479b8"

EXEC_LOG_CONTENT = """
[Runner] 2026-03-29 15:00 修复项1完成 - 删除 config.py 重复字段
- 文件: rpa-qianniu/app/config.py
- 操作: 删除第96行重复声明 `vision_right_nick_top_frac: float = 0.33`
- 验证: `python -m py_compile app/config.py` ✅ 通过
- 状态: 配置类加载正常，重复字段已清除

[Runner] 2026-03-29 15:05 修复项2完成 - 补全 rpa-qianniu .env.example
- 文件: rpa-qianniu/.env.example
- 操作: 在末尾添加「高级配置」区块，包含6个字段（VISION_POLL_ACTIVE_SEC, VISION_CAPTURE_SETTLE_SEC, VISION_SESSION_SWITCH_WAIT_SEC, AI_HTTP_TIMEOUT_SEC, ACTION_DELAY_MS_MIN, ACTION_DELAY_MS_MAX）
- 状态: 完成（按Nano建议需进一步补全剩余字段）

[Runner] 2026-03-29 15:08 修复项3完成 - 补全 msg-router .env.example
- 文件: msg-router/.env.example
- 操作: 在 FASTGPT 区块添加 `# FASTGPT_TIMEOUT_SECONDS=30.0`
- 状态: 完成

[Runner] 2026-03-29 15:15 运行时验证 - pytest测试
- 命令: `cd rpa-qianniu && python -m pytest tests/ -v --tb=short`
- 结果: ✅ **48个测试全部通过，0个失败**
- 测试覆盖: test_banner_filter.py(7), test_message_filter.py(17), test_message_parser.py(9), test_role_for_box.py(8)

[Runner] 2026-03-29 15:20 运行时验证 - 代码编译检查
- 命令: 对三模块所有.py文件执行 `python -m py_compile`
- 结果: ✅ **50个文件全部通过，0个语法错误**
- 覆盖范围: msg-router(10), rpa-qianniu(28), rpa-pdd(12)

[Runner] 2026-03-29 15:30 功能测试 - msg-router服务启动
- 操作: 启动 FastAPI 服务 `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- 结果: ✅ 服务启动成功，API测试全部通过
  - GET /health → {"status":"ok"} ✅
  - POST /v1/chat → 返回AI回复，响应时间5620ms ✅

[Runner] 2026-03-29 15:45-15:50 功能测试 - rpa模块导入测试
- rpa-qianniu: 发现架构设计不匹配（类式API与函数式实现不匹配），缺少pyautogui依赖
- rpa-pdd: 同样存在架构设计不匹配问题

[Runner] 2026-03-29 16:00 问题汇总与工单创建
- 已创建异常工单: [Cursor异常援助] rpa-qianniu 和 rpa-pdd 导入设计问题
- 状态: Nano规划 | 优先级: P0
- URL: https://www.notion.so/3321eed38101815ca59ac9be355f2337

[Runner] 2026-03-29 16:05 Git提交与推送
- Commit: `4789d22c07623f682a7b7bbbd658e1af01975176`
- 消息: fix: 全量回归修复 - 删除重复字段声明，补全.env.example缺失条目
- 结果: ✅ 成功推送到 feature/rpa-qianniu-vision-dwm-pending

[Runner] 2026-03-29 16:10 【回归总结】
✅ 修复完成: 3项修复 + 48/48单元测试通过 + 50/50编译通过 + msg-router服务正常
⚠️ 新发现问题: 已提交工单 3321eed3（rpa-qianniu和rpa-pdd架构设计问题）
📦 产出物: Commit 4789d22 + 异常工单
"""


def get_headers(token):
    return {
        'Authorization': f'Bearer {token}',
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
    }


def append_content_to_page(token, page_id, content):
    """追加内容到页面"""
    url = f"{NOTION_API_BASE}/blocks/{page_id}/children"
    headers = get_headers(token)

    # 将内容按行分割并创建段落块
    lines = content.strip().split('\n')
    blocks = []

    for line in lines:
        if line.startswith('[Runner]'):
            # Runner 时间戳行使用 heading_3
            blocks.append({
                "object": "block",
                "type": "heading_3",
                "heading_3": {
                    "rich_text": [{"type": "text", "text": {"content": line}}]
                }
            })
        elif line.strip():
            # 普通行使用段落
            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": line}}]
                }
            })

    # Notion API 每次最多添加 100 个块，这里我们分批添加
    batch_size = 100
    for i in range(0, len(blocks), batch_size):
        batch = blocks[i:i + batch_size]
        payload = {"children": batch}

        response = requests.patch(url, headers=headers, json=payload)
        if response.status_code != 200:
            print(f"添加块失败: {response.status_code}")
            print(response.text)
            return False

    return True


def main():
    print("=" * 60)
    print("更新全量回归任务执行日志")
    print("=" * 60)

    # 获取 Token
    token = os.environ.get('NOTION_TOKEN') or os.environ.get('NOTION_API_KEY')
    if not token:
        print("错误: 未找到 Notion API Token")
        print("请设置环境变量:")
        print("  PowerShell: $env:NOTION_TOKEN = 'your_token_here'")
        print("  CMD: set NOTION_TOKEN=your_token_here")
        sys.exit(1)

    print(f"✓ Token: {token[:10]}...{token[-4:]}")
    print(f"\n[1/2] 追加执行日志到页面 {PAGE_ID}...")

    if append_content_to_page(token, PAGE_ID, EXEC_LOG_CONTENT):
        print("✓ 执行日志已追加")
    else:
        print("✗ 追加失败")
        sys.exit(1)

    print("\n[2/2] 完成!")
    print("=" * 60)
    print(f"任务URL: https://www.notion.so/{PAGE_ID.replace('-', '')}")
    print("=" * 60)


if __name__ == "__main__":
    main()
