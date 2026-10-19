"""Kaas v2 · 迁移期测试 fixtures（S4 删壳后）。

只保留「不依赖已删除业务壳」的测试：共享内核纯函数、ORM 模型/schema 对齐、迁移链。
API 行为测试已由 worker 侧 parity 测试替代（见 docs/S4_TEST_MIGRATION_2026-10-19.md）。
"""
from __future__ import annotations

import sys

if sys.platform == "win32":
    import asyncio

    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
