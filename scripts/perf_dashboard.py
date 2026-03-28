#!/usr/bin/env python3
"""
性能监控仪表板 - 实时显示 RPA 和 msg-router 性能指标
支持自动刷新模式（类似 htop）
"""

from __future__ import annotations

import argparse
import curses
import json
import time
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RPA 性能监控仪表板")
    parser.add_argument(
        "--qianniu-log",
        type=str,
        default="rpa-qianniu/data/chat_logs.jsonl",
        help="千牛RPA日志路径",
    )
    parser.add_argument(
        "--pdd-log",
        type=str,
        default="rpa-pdd/data/chat_logs.jsonl",
        help="拼多多RPA日志路径",
    )
    parser.add_argument(
        "--refresh",
        type=int,
        default=2,
        help="刷新间隔（秒）",
    )
    parser.add_argument(
        "--window-minutes",
        type=int,
        default=5,
        help="统计时间窗口（分钟）",
    )
    return parser.parse_args()


def tail_jsonl(filepath: Path, n: int = 100) -> list[dict[str, Any]]:
    """读取文件最后n行JSONL"""
    records: list[dict[str, Any]] = []
    if not filepath.exists():
        return records

    try:
        with open(filepath, "r", encoding="utf-8-sig") as f:
            lines = f.readlines()
            for line in lines[-n:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return records


def calculate_stats(records: list[dict[str, Any]], window_minutes: int) -> dict[str, Any]:
    """计算统计信息"""
    if not records:
        return {"count": 0}

    # 过滤时间窗口
    cutoff = datetime.now() - timedelta(minutes=window_minutes)
    recent = []
    for r in records:
        ts_str = r.get("timestamp", "")
        if ts_str:
            try:
                ts = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
                if ts >= cutoff:
                    recent.append(r)
            except Exception:
                recent.append(r)  # 无法解析时间则包含

    if not recent:
        return {"count": 0}

    # 状态统计
    status_counts: dict[str, int] = {}
    platform_counts: dict[str, int] = {}
    total_times: list[int] = []
    ai_times: list[int] = []

    for r in recent:
        status = r.get("status", "unknown")
        status_counts[status] = status_counts.get(status, 0) + 1

        platform = r.get("platform", "unknown")
        platform_counts[platform] = platform_counts.get(platform, 0) + 1

        if r.get("latency_total_ms"):
            total_times.append(r["latency_total_ms"])
        if r.get("latency_ai_ms"):
            ai_times.append(r["latency_ai_ms"])

    total = len(recent)
    success = status_counts.get("sent", 0)
    success_rate = round(success / total * 100, 1) if total else 0

    return {
        "count": total,
        "success_rate": success_rate,
        "status_counts": status_counts,
        "platform_counts": platform_counts,
        "avg_total_ms": round(sum(total_times) / len(total_times), 1) if total_times else 0,
        "avg_ai_ms": round(sum(ai_times) / len(ai_times), 1) if ai_times else 0,
        "max_total_ms": max(total_times) if total_times else 0,
    }


def draw_dashboard(stdscr, args: argparse.Namespace) -> None:
    """绘制仪表板"""
    curses.curs_set(0)  # 隐藏光标
    stdscr.nodelay(True)  # 非阻塞输入

    qianniu_path = Path(args.qianniu_log)
    pdd_path = Path(args.pdd_log)

    history_qianniu: deque[int] = deque(maxlen=60)
    history_pdd: deque[int] = deque(maxlen=60)

    while True:
        stdscr.clear()
        height, width = stdscr.getmaxyx()

        # 读取日志
        qianniu_records = tail_jsonl(qianniu_path, 200)
        pdd_records = tail_jsonl(pdd_path, 200)

        qianniu_stats = calculate_stats(qianniu_records, args.window_minutes)
        pdd_stats = calculate_stats(pdd_records, args.window_minutes)

        # 更新历史
        history_qianniu.append(qianniu_stats.get("count", 0))
        history_pdd.append(pdd_stats.get("count", 0))

        # 绘制标题
        title = "🚀 RPA 性能监控仪表板"
        stdscr.addstr(0, (width - len(title)) // 2, title, curses.A_BOLD)

        time_str = f"更新时间: {datetime.now().strftime('%H:%M:%S')} | 窗口: {args.window_minutes}分钟"
        stdscr.addstr(1, (width - len(time_str)) // 2, time_str)

        # 绘制分隔线
        stdscr.addstr(2, 0, "=" * width)

        # 千牛RPA 统计
        y = 4
        stdscr.addstr(y, 2, "📦 千牛RPA", curses.A_BOLD)
        stdscr.addstr(y + 1, 4, f"消息数: {qianniu_stats.get('count', 0)}")
        stdscr.addstr(y + 2, 4, f"成功率: {qianniu_stats.get('success_rate', 0)}%")
        stdscr.addstr(y + 3, 4, f"平均延迟: {qianniu_stats.get('avg_total_ms', 0)}ms")
        stdscr.addstr(y + 4, 4, f"AI延迟: {qianniu_stats.get('avg_ai_ms', 0)}ms")

        # 拼多多RPA 统计
        y = 10
        stdscr.addstr(y, 2, "📦 拼多多RPA", curses.A_BOLD)
        stdscr.addstr(y + 1, 4, f"消息数: {pdd_stats.get('count', 0)}")
        stdscr.addstr(y + 2, 4, f"成功率: {pdd_stats.get('success_rate', 0)}%")
        stdscr.addstr(y + 3, 4, f"平均延迟: {pdd_stats.get('avg_total_ms', 0)}ms")
        stdscr.addstr(y + 4, 4, f"AI延迟: {pdd_stats.get('avg_ai_ms', 0)}ms")

        # 绘制趋势图（简化版）
        y = 16
        stdscr.addstr(y, 2, "📊 消息数趋势 (最近60次采样)", curses.A_BOLD)

        # 绘制操作提示
        stdscr.addstr(height - 2, 0, "-" * width)
        stdscr.addstr(height - 1, 2, "按 'q' 退出 | 按 'r' 立即刷新")

        stdscr.refresh()

        # 等待刷新或按键
        for _ in range(args.refresh * 10):
            try:
                key = stdscr.getch()
                if key == ord('q'):
                    return
                elif key == ord('r'):
                    break
                time.sleep(0.1)
            except:
                time.sleep(0.1)


def main() -> int:
    args = parse_args()

    try:
        curses.wrapper(draw_dashboard, args)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"仪表板错误: {e}")
        return 1

    return 0


if __name__ == "__main__":
    exit(main())
