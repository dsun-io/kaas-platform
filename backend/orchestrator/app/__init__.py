"""Kaas v2 · 应用入口包"""
import os
import sys

# 共享内核 kaas_common 位于 backend/（与 orchestrator 平级，G1 一份代码），
# 运行时（uvicorn）也要能 import，此处补路径（测试由 pyproject pythonpath 覆盖）。
# __file__ = backend/orchestrator/app/__init__.py → 上三级 = backend/
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)