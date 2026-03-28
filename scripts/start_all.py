#!/usr/bin/env python3
"""
一体化启动脚本 - 同时启动 msg-router 和 RPA 服务
支持自动重启、日志聚合、信号处理
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


class ServiceManager:
    """服务管理器"""

    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.processes: dict[str, subprocess.Popen[Any]] = {}
        self.should_stop = False

        # 注册信号处理
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _signal_handler(self, signum: int, frame: Any) -> None:
        """处理终止信号"""
        print(f"\n[Manager] 收到信号 {signum}，正在停止所有服务...")
        self.should_stop = True
        self.stop_all()

    def start_msg_router(self) -> bool:
        """启动 msg-router 服务"""
        msg_router_dir = self.project_root / "msg-router"
        if not msg_router_dir.exists():
            print("[Manager] 错误: msg-router 目录不存在")
            return False

        try:
            proc = subprocess.Popen(
                [sys.executable, "-m", "app"],
                cwd=msg_router_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            self.processes["msg-router"] = proc
            print(f"[Manager] msg-router 启动 (PID: {proc.pid})")
            return True
        except Exception as e:
            print(f"[Manager] msg-router 启动失败: {e}")
            return False

    def start_rpa_qianniu(self, vision_mode: bool = True) -> bool:
        """启动千牛RPA"""
        rpa_dir = self.project_root / "rpa-qianniu"
        if not rpa_dir.exists():
            print("[Manager] 错误: rpa-qianniu 目录不存在")
            return False

        try:
            env = {"USE_VISION_PIPELINE": "true" if vision_mode else "false"}
            proc = subprocess.Popen(
                [sys.executable, "-m", "app"],
                cwd=rpa_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env={**dict(subprocess.os.environ), **env},
            )
            self.processes["rpa-qianniu"] = proc
            print(f"[Manager] rpa-qianniu 启动 (PID: {proc.pid}) 模式={'vision' if vision_mode else 'uia'}")
            return True
        except Exception as e:
            print(f"[Manager] rpa-qianniu 启动失败: {e}")
            return False

    def start_rpa_pdd(self) -> bool:
        """启动拼多多RPA"""
        rpa_dir = self.project_root / "rpa-pdd"
        if not rpa_dir.exists():
            print("[Manager] 警告: rpa-pdd 目录不存在，跳过")
            return False

        try:
            proc = subprocess.Popen(
                [sys.executable, "-m", "app"],
                cwd=rpa_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            self.processes["rpa-pdd"] = proc
            print(f"[Manager] rpa-pdd 启动 (PID: {proc.pid})")
            return True
        except Exception as e:
            print(f"[Manager] rpa-pdd 启动失败: {e}")
            return False

    def monitor(self) -> None:
        """监控所有服务"""
        print("[Manager] 开始监控所有服务 (按 Ctrl+C 停止)")
        print("-" * 60)

        try:
            while not self.should_stop:
                # 检查进程状态
                for name, proc in list(self.processes.items()):
                    if proc.poll() is not None:
                        # 进程已退出
                        exit_code = proc.returncode
                        print(f"[Manager] {name} 已退出 (code: {exit_code})")

                        # 自动重启（可选）
                        if not self.should_stop and exit_code != 0:
                            print(f"[Manager] 尝试重启 {name}...")
                            time.sleep(2)
                            if name == "msg-router":
                                self.start_msg_router()
                            elif name == "rpa-qianniu":
                                self.start_rpa_qianniu()
                            elif name == "rpa-pdd":
                                self.start_rpa_pdd()

                time.sleep(1)

        except KeyboardInterrupt:
            print("\n[Manager] 用户中断")
        finally:
            self.stop_all()

    def stop_all(self) -> None:
        """停止所有服务"""
        print("[Manager] 停止所有服务...")

        for name, proc in self.processes.items():
            if proc.poll() is None:  # 仍在运行
                print(f"[Manager] 停止 {name} (PID: {proc.pid})...")
                try:
                    proc.terminate()
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    print(f"[Manager] {name} 强制终止")
                    proc.kill()

        self.processes.clear()
        print("[Manager] 所有服务已停止")


def main() -> int:
    parser = argparse.ArgumentParser(description="启动 KAAS 平台所有服务")
    parser.add_argument(
        "--only-msg-router",
        action="store_true",
        help="仅启动 msg-router",
    )
    parser.add_argument(
        "--only-rpa",
        action="store_true",
        help="仅启动 RPA 服务",
    )
    parser.add_argument(
        "--no-pdd",
        action="store_true",
        help="不启动拼多多RPA",
    )
    parser.add_argument(
        "--uia-mode",
        action="store_true",
        help="使用 UIA 模式而非视觉模式（仅千牛RPA）",
    )

    args = parser.parse_args()

    # 找到项目根目录
    script_dir = Path(__file__).parent.resolve()
    project_root = script_dir.parent

    manager = ServiceManager(project_root)

    # 根据参数启动服务
    if not args.only_rpa:
        if not manager.start_msg_router():
            print("[Manager] msg-router 启动失败，退出")
            return 1
        time.sleep(2)  # 等待 msg-router 就绪

    if not args.only_msg_router:
        if not manager.start_rpa_qianniu(vision_mode=not args.uia_mode):
            print("[Manager] rpa-qianniu 启动失败")
            manager.stop_all()
            return 1

        if not args.no_pdd:
            manager.start_rpa_pdd()  # 可选，失败不影响整体

    # 开始监控
    manager.monitor()
    return 0


if __name__ == "__main__":
    sys.exit(main())
