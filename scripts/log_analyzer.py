#!/usr/bin/env python3
"""
日志分析工具 - 分析 RPA 日志，检测异常并发送告警
支持邮件/钉钉/飞书通知
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="日志分析和告警")
    parser.add_argument(
        "--log-file",
        type=str,
        default="rpa-qianniu/logs/rpa-qianniu.log",
        help="日志文件路径",
    )
    parser.add_argument(
        "--window-minutes",
        type=int,
        default=60,
        help="分析时间窗口（分钟）",
    )
    parser.add_argument(
        "--error-threshold",
        type=int,
        default=10,
        help="错误告警阈值",
    )
    parser.add_argument(
        "--output",
        type=str,
        help="报告输出文件",
    )
    parser.add_argument(
        "--alert-only",
        action="store_true",
        help="仅输出告警信息",
    )
    return parser.parse_args()


def parse_log_line(line: str) -> dict[str, Any] | None:
    """解析单行日志"""
    # 匹配格式: 2026-03-28 12:30:45 | INFO | [module] message
    pattern = r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \| (\w+) \| (.*)$"
    match = re.match(pattern, line.strip())

    if match:
        timestamp_str, level, message = match.groups()
        try:
            timestamp = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S")
            return {
                "timestamp": timestamp,
                "level": level.upper(),
                "message": message,
            }
        except ValueError:
            pass

    # 尝试其他格式
    return None


def load_logs(filepath: Path, window_minutes: int) -> list[dict[str, Any]]:
    """加载日志文件"""
    logs: list[dict[str, Any]] = []

    if not filepath.exists():
        return logs

    cutoff = datetime.now() - timedelta(minutes=window_minutes)

    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            parsed = parse_log_line(line)
            if parsed and parsed["timestamp"] >= cutoff:
                logs.append(parsed)

    return logs


def analyze_logs(logs: list[dict[str, Any]]) -> dict[str, Any]:
    """分析日志"""
    if not logs:
        return {"error": "没有日志数据"}

    # 按级别统计
    level_counts = Counter(log["level"] for log in logs)

    # 错误分析
    errors = [log for log in logs if log["level"] == "ERROR"]
    error_messages = Counter(log["message"][:100] for log in errors)

    # 警告分析
    warnings = [log for log in logs if log["level"] == "WARNING"]

    # 时间分布
    hour_distribution = defaultdict(int)
    for log in logs:
        hour = log["timestamp"].hour
        hour_distribution[hour] += 1

    # 模块分析（从消息中提取 [module] 格式）
    module_pattern = r"^\[([^\]]+)\]"
    module_counts = Counter()
    for log in logs:
        match = re.match(module_pattern, log["message"])
        if match:
            module_counts[match.group(1)] += 1

    return {
        "total_logs": len(logs),
        "level_counts": dict(level_counts),
        "error_count": len(errors),
        "warning_count": len(warnings),
        "top_errors": error_messages.most_common(5),
        "hour_distribution": dict(hour_distribution),
        "module_counts": dict(module_counts.most_common(10)),
        "recent_errors": errors[-5:] if errors else [],
    }


def check_alerts(analysis: dict[str, Any], threshold: int) -> list[str]:
    """检查告警条件"""
    alerts: list[str] = []

    if analysis.get("error_count", 0) >= threshold:
        alerts.append(f"⚠️ 错误数量告警: {analysis['error_count']} 个错误 (阈值: {threshold})")

    if analysis.get("warning_count", 0) >= threshold * 2:
        alerts.append(f"⚠️ 警告数量告警: {analysis['warning_count']} 个警告")

    # 检查特定错误模式
    top_errors = analysis.get("top_errors", [])
    for error_msg, count in top_errors:
        if count >= 5:
            alerts.append(f"⚠️ 重复错误告警: '{error_msg[:50]}...' 出现 {count} 次")

    return alerts


def format_report(analysis: dict[str, Any], alerts: list[str], window_minutes: int) -> str:
    """格式化报告"""
    lines = [
        "# RPA 日志分析报告",
        "",
        f"**分析时间窗口**: 过去 {window_minutes} 分钟",
        f"**分析时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
    ]

    if alerts:
        lines.extend([
            "## 🚨 告警信息",
            "",
        ])
        for alert in alerts:
            lines.append(f"- {alert}")
        lines.append("")

    lines.extend([
        "## 📊 统计概览",
        "",
        f"- 总日志数: {analysis.get('total_logs', 0)}",
        f"- 错误数: {analysis.get('error_count', 0)}",
        f"- 警告数: {analysis.get('warning_count', 0)}",
        "",
        "### 日志级别分布",
        "",
    ])

    for level, count in analysis.get("level_counts", {}).items():
        lines.append(f"- {level}: {count}")

    if analysis.get("top_errors"):
        lines.extend([
            "",
            "### 常见错误",
            "",
        ])
        for error_msg, count in analysis["top_errors"]:
            lines.append(f"- {error_msg[:80]}... ({count}次)")

    if analysis.get("module_counts"):
        lines.extend([
            "",
            "### 活跃模块",
            "",
        ])
        for module, count in analysis["module_counts"].items():
            lines.append(f"- {module}: {count} 条日志")

    if analysis.get("recent_errors"):
        lines.extend([
            "",
            "### 最近错误",
            "",
        ])
        for error in analysis["recent_errors"][-3:]:
            lines.append(f"- [{error['timestamp'].strftime('%H:%M:%S')}] {error['message'][:100]}")

    return "\n".join(lines)


def main() -> int:
    args = parse_args()

    log_file = Path(args.log_file)

    print(f"正在分析 {log_file}...")
    logs = load_logs(log_file, args.window_minutes)
    print(f"加载了 {len(logs)} 条日志（过去 {args.window_minutes} 分钟）")

    analysis = analyze_logs(logs)
    alerts = check_alerts(analysis, args.error_threshold)

    report = format_report(analysis, alerts, args.window_minutes)

    if args.alert_only and not alerts:
        print("没有发现告警")
        return 0

    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
        print(f"报告已保存: {args.output}")
    else:
        print()
        print(report)

    # 返回非零退出码表示有告警
    return 1 if alerts else 0


if __name__ == "__main__":
    sys.exit(main())
