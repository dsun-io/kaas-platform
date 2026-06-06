#!/usr/bin/env python3
"""
项目健康检查脚本 - 检查所有组件状态和配置
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Any


class Colors:
    OK = "\033[92m"  # 绿色
    WARN = "\033[93m"  # 黄色
    ERROR = "\033[91m"  # 红色
    INFO = "\033[94m"  # 蓝色
    RESET = "\033[0m"


def print_status(message: str, status: str) -> None:
    """打印状态消息"""
    if sys.platform == "win32":
        # Windows 控制台可能不支持ANSI颜色
        print(f"[{status}] {message}")
    else:
        color = {
            "OK": Colors.OK,
            "WARN": Colors.WARN,
            "ERROR": Colors.ERROR,
            "INFO": Colors.INFO,
        }.get(status, "")
        print(f"{color}[{status}]{Colors.RESET} {message}")


def check_directory(name: str, path: Path) -> bool:
    """检查目录是否存在"""
    if path.exists():
        print_status(f"{name}: {path}", "OK")
        return True
    else:
        print_status(f"{name}: {path} (不存在)", "ERROR")
        return False


def check_file(name: str, path: Path, required: bool = True) -> bool:
    """检查文件是否存在"""
    if path.exists():
        size = path.stat().st_size
        print_status(f"{name}: {path} ({size} bytes)", "OK")
        return True
    else:
        status = "ERROR" if required else "WARN"
        print_status(f"{name}: {path} ({'必需' if required else '可选'})", status)
        return not required


def check_python_module(name: str, module: str) -> bool:
    """检查Python模块是否可导入"""
    try:
        __import__(module)
        print_status(f"Python模块 {name}: 已安装", "OK")
        return True
    except ImportError:
        print_status(f"Python模块 {name}: 未安装", "ERROR")
        return False


def check_sqlite_db(path: Path) -> bool:
    """检查SQLite数据库"""
    if not path.exists():
        print_status(f"数据库 {path}: 不存在", "WARN")
        return False

    try:
        conn = sqlite3.connect(path)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()
        conn.close()

        table_names = [t[0] for t in tables]
        print_status(f"数据库 {path}: 表 {table_names}", "OK")
        return True
    except Exception as e:
        print_status(f"数据库 {path}: 错误 {e}", "ERROR")
        return False


def check_json_config(path: Path) -> bool:
    """检查JSON配置文件"""
    if not path.exists():
        print_status(f"配置 {path}: 不存在", "WARN")
        return False

    try:
        with open(path, "r", encoding="utf-8") as f:
            json.load(f)
        print_status(f"配置 {path}: JSON格式正确", "OK")
        return True
    except json.JSONDecodeError as e:
        print_status(f"配置 {path}: JSON错误 {e}", "ERROR")
        return False


def main() -> int:
    """主函数"""
    script_dir = Path(__file__).parent.resolve()
    project_root = script_dir.parent

    print("=" * 60)
    print("KAAS 平台项目健康检查")
    print("=" * 60)
    print()

    all_ok = True

    # 检查目录结构
    print("📁 目录结构检查:")
    dirs = [
        ("rpa-qianniu", project_root / "rpa-qianniu"),
        ("msg-router", project_root / "msg-router"),
        ("rpa-pdd", project_root / "rpa-pdd"),
        ("scripts", project_root / "scripts"),
        ("data", project_root / "rpa-qianniu" / "data"),
        ("config", project_root / "rpa-qianniu" / "config"),
    ]
    for name, path in dirs:
        all_ok &= check_directory(name, path)
    print()

    # 检查关键文件
    print("📄 关键文件检查:")
    files = [
        ("rpa-qianniu config", project_root / "rpa-qianniu" / "app" / "config.py"),
        ("msg-router config", project_root / "msg-router" / "app" / "config.py"),
        ("rpa-qianniu env示例", project_root / "rpa-qianniu" / ".env.example", False),
        ("msg-router env示例", project_root / "msg-router" / ".env.example", False),
    ]
    for name, path, *optional in files:
        all_ok &= check_file(name, path, not optional)
    print()

    # 检查JSON配置
    print("⚙️ 配置文件检查:")
    configs = [
        project_root / "rpa-qianniu" / "config" / "selectors.json",
        project_root / "rpa-qianniu" / "config" / "vision_calibration.json",
    ]
    for config in configs:
        check_json_config(config)  # 可选，不设置 all_ok
    print()

    # 检查数据库
    print("🗄️ 数据库检查:")
    check_sqlite_db(project_root / "rpa-qianniu" / "data" / "conversations.db")
    check_sqlite_db(project_root / "msg-router" / "data" / "conversations.db")
    print()

    # 检查Python依赖
    print("🐍 Python依赖检查:")
    modules = [
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("pydantic", "pydantic"),
        ("numpy", "numpy"),
        ("opencv-python", "cv2"),
        ("pyautogui", "pyautogui"),
    ]

    # 可选模块检查
    optional_modules = [
        ("paddleocr", "paddleocr"),
        ("uiautomation", "uiautomation"),
    ]

    for name, module in modules:
        all_ok &= check_python_module(name, module)

    for name, module in optional_modules:
        check_python_module(name, module)  # 可选
    print()

    # 检查日志文件
    print("📝 日志检查:")
    logs_dir = project_root / "rpa-qianniu" / "logs"
    if logs_dir.exists():
        log_files = list(logs_dir.glob("*.log"))
        if log_files:
            print_status(f"日志文件数: {len(log_files)}", "INFO")
        else:
            print_status("日志目录为空", "WARN")

    chat_logs = project_root / "rpa-qianniu" / "data" / "chat_logs.jsonl"
    if chat_logs.exists():
        size = chat_logs.stat().st_size
        print_status(f"对话日志: {size} bytes", "OK")
    print()

    # 总结
    print("=" * 60)
    if all_ok:
        print_status("项目检查完成: 核心组件正常", "OK")
        return 0
    else:
        print_status("项目检查完成: 存在问题需要修复", "ERROR")
        return 1


if __name__ == "__main__":
    sys.exit(main())
