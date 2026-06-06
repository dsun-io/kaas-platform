#!/usr/bin/env python3
"""浸泡测试报告生成脚本 - 解析 chat_logs.jsonl，输出结构化统计报告"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="生成浸泡测试报告，从 chat_logs.jsonl 解析统计数据"
    )
    parser.add_argument(
        "--log-file",
        type=str,
        default="rpa-qianniu/data/chat_logs.jsonl",
        help="chat_logs.jsonl 文件路径 (默认: rpa-qianniu/data/chat_logs.jsonl)",
    )
    parser.add_argument(
        "--since",
        type=str,
        default=None,
        help="只分析该 ISO 时间戳之后的记录 (格式: 2026-03-28T10:00:00)",
    )
    parser.add_argument(
        "--min-duration",
        type=int,
        default=30,
        help="最低运行时长分钟数，不足时警告 (默认: 30)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="报告输出路径，默认输出到 stdout",
    )
    return parser.parse_args()


def parse_timestamp(ts_str: str) -> datetime:
    """解析时间戳字符串为 datetime 对象"""
    try:
        # 尝试解析 ISO 格式
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except Exception:
        # 尝试解析 %Y-%m-%d %H:%M:%S 格式
        return datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def load_logs(log_file: Path, since: datetime | None = None) -> list[dict[str, Any]]:
    """加载日志文件并过滤"""
    records: list[dict[str, Any]] = []
    if not log_file.exists():
        return records

    with open(log_file, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                if since is not None:
                    ts_str = record.get("timestamp", "")
                    if ts_str:
                        try:
                            ts = parse_timestamp(ts_str)
                            if ts < since:
                                continue
                        except Exception:
                            pass
                records.append(record)
            except json.JSONDecodeError:
                continue
    return records


def generate_report(records: list[dict[str, Any]], min_duration: int) -> dict[str, Any]:
    """生成统计报告"""
    if not records:
        return {
            "test_duration_minutes": 0,
            "total_sessions": 0,
            "success_count": 0,
            "success_rate": 0,
            "ai_error_count": 0,
            "send_failed_count": 0,
            "failure_rate": 0,
            "platform_distribution": {},
            "ai_source_distribution": {},
            "status_distribution": {},
            "error_distribution": {},
            "session_count": 0,
            "session_ids": [],
            "latency_stats": {},
            "failed_details": [],
            "warnings": ["没有记录数据"],
        }

    # 时间范围
    timestamps = []
    for r in records:
        ts_str = r.get("timestamp", "")
        if ts_str:
            try:
                ts = parse_timestamp(ts_str)
                timestamps.append(ts)
            except Exception:
                pass

    if timestamps:
        start_time = min(timestamps)
        end_time = max(timestamps)
        duration_minutes = (end_time - start_time).total_seconds() / 60
    else:
        duration_minutes = 0
        start_time = None
        end_time = None

    # 会话统计
    total_sessions = len(records)

    # 状态分布
    status_counts = defaultdict(int)
    for r in records:
        status = r.get("status", "unknown")
        status_counts[status] += 1

    success_count = status_counts.get("sent", 0)
    ai_error_count = status_counts.get("ai_failed", 0)
    send_failed_count = status_counts.get("send_failed", 0)

    # 平台分布
    platform_counts = defaultdict(int)
    for r in records:
        platform = r.get("platform", "unknown")
        platform_counts[platform] += 1

    # 错误类型统计
    error_counts = defaultdict(int)
    for r in records:
        if r.get("error"):
            error_counts[r["error"]] += 1

    # AI 来源统计
    ai_source_counts = defaultdict(int)
    for r in records:
        source = r.get("ai_source", "unknown")
        ai_source_counts[source] += 1

    # 延迟统计
    latencies_ai = []
    latencies_send = []
    latencies_total = []
    for r in records:
        if r.get("latency_ai_ms"):
            latencies_ai.append(r["latency_ai_ms"])
        if r.get("latency_send_ms"):
            latencies_send.append(r["latency_send_ms"])
        if r.get("latency_total_ms"):
            latencies_total.append(r["latency_total_ms"])

    def avg(lst: list[int]) -> float:
        return sum(lst) / len(lst) if lst else 0.0

    # session_id 分布
    session_counts = defaultdict(int)
    for r in records:
        sid = r.get("session_id", "unknown")
        session_counts[sid] += 1

    # 失败明细
    failed_records = [
        r for r in records if r.get("status") in ("send_failed", "ai_failed")
    ]
    failed_details = []
    for r in failed_records[:20]:  # 只取前20条
        failed_details.append({
            "timestamp": r.get("timestamp", ""),
            "buyer_nick": r.get("buyer_nick", ""),
            "buyer_msg": r.get("buyer_msg", "")[:100],
            "status": r.get("status", ""),
            "error": r.get("error", ""),
        })

    report = {
        "test_duration_minutes": round(duration_minutes, 1),
        "total_sessions": total_sessions,
        "success_count": success_count,
        "success_rate": round(success_count / total_sessions * 100, 1) if total_sessions else 0,
        "ai_error_count": ai_error_count,
        "send_failed_count": send_failed_count,
        "failure_rate": round((ai_error_count + send_failed_count) / total_sessions * 100, 1) if total_sessions else 0,
        "platform_distribution": dict(platform_counts),
        "ai_source_distribution": dict(ai_source_counts),
        "status_distribution": dict(status_counts),
        "error_distribution": dict(error_counts),
        "session_count": len(session_counts),
        "session_ids": list(session_counts.keys()),
        "latency_stats": {
            "ai_ms": {
                "avg": round(avg(latencies_ai), 1),
                "min": min(latencies_ai) if latencies_ai else 0,
                "max": max(latencies_ai) if latencies_ai else 0,
                "count": len(latencies_ai),
            },
            "send_ms": {
                "avg": round(avg(latencies_send), 1),
                "min": min(latencies_send) if latencies_send else 0,
                "max": max(latencies_send) if latencies_send else 0,
                "count": len(latencies_send),
            },
            "total_ms": {
                "avg": round(avg(latencies_total), 1),
                "min": min(latencies_total) if latencies_total else 0,
                "max": max(latencies_total) if latencies_total else 0,
                "count": len(latencies_total),
            },
        },
        "failed_details": failed_details,
        "warnings": [],
    }

    if duration_minutes < min_duration:
        report["warnings"].append(
            f"运行时长 {duration_minutes:.1f} 分钟低于最低要求 {min_duration} 分钟"
        )

    return report


def format_markdown_report(report: dict[str, Any]) -> str:
    """格式化为 Markdown 报告"""
    lines = []
    lines.append("# 浸泡测试报告")
    lines.append("")
    lines.append("## 测试概况")
    lines.append("")
    lines.append(f"| 指标 | 数值 |")
    lines.append(f"|------|------|")
    lines.append(f"| 测试时长 | {report['test_duration_minutes']:.1f} 分钟 |")
    lines.append(f"| 总会话数 | {report['total_sessions']} |")
    lines.append(f"| 成功数 | {report['success_count']} |")
    lines.append(f"| 成功率 | {report['success_rate']}% |")
    lines.append(f"| AI 错误 | {report['ai_error_count']} |")
    lines.append(f"| 发送失败 | {report['send_failed_count']} |")
    lines.append(f"| 失败率 | {report['failure_rate']}% |")
    lines.append(f"| 会话 ID 数 | {report['session_count']} |")
    lines.append("")

    # 平台分布
    if report.get("platform_distribution"):
        lines.append("## 平台分布")
        lines.append("")
        lines.append("| 平台 | 数量 |")
        lines.append("|------|------|")
        for platform, count in sorted(report["platform_distribution"].items(), key=lambda x: -x[1]):
            lines.append(f"| {platform} | {count} |")
        lines.append("")

    # AI 来源
    if report.get("ai_source_distribution"):
        lines.append("## AI 来源分布")
        lines.append("")
        lines.append("| 来源 | 数量 |")
        lines.append("|------|------|")
        for source, count in sorted(report["ai_source_distribution"].items(), key=lambda x: -x[1]):
            lines.append(f"| {source} | {count} |")
        lines.append("")

    # 状态分布
    if report.get("status_distribution"):
        lines.append("## 状态分布")
        lines.append("")
        lines.append("| 状态 | 数量 |")
        lines.append("|------|------|")
        for status, count in sorted(report["status_distribution"].items(), key=lambda x: -x[1]):
            lines.append(f"| {status} | {count} |")
        lines.append("")

    # 延迟统计
    if report.get("latency_stats"):
        lines.append("## 延迟统计")
        lines.append("")
        latency = report["latency_stats"]
        for name, label in [("ai_ms", "AI 调用"), ("send_ms", "发送回复"), ("total_ms", "总计")]:
            if name in latency and latency[name]["count"] > 0:
                stats = latency[name]
                lines.append(f"### {label}")
                lines.append(f"- 平均: {stats['avg']:.1f} ms")
                lines.append(f"- 最小: {stats['min']} ms")
                lines.append(f"- 最大: {stats['max']} ms")
                lines.append(f"- 样本: {stats['count']}")
                lines.append("")

    # 错误分布
    if report.get("error_distribution"):
        lines.append("## 错误分布")
        lines.append("")
        lines.append("| 错误类型 | 数量 |")
        lines.append("|----------|------|")
        for error, count in sorted(report["error_distribution"].items(), key=lambda x: -x[1]):
            lines.append(f"| {error} | {count} |")
        lines.append("")

    # 失败明细
    if report.get("failed_details"):
        lines.append("## 失败明细（前20条）")
        lines.append("")
        lines.append("| 时间 | 买家 | 消息 | 状态 | 错误 |")
        lines.append("|------|------|------|------|------|")
        for r in report["failed_details"]:
            msg_short = r["buyer_msg"][:50] + "..." if len(r["buyer_msg"]) > 50 else r["buyer_msg"]
            lines.append(f"| {r['timestamp']} | {r['buyer_nick']} | {msg_short} | {r['status']} | {r['error']} |")
        lines.append("")

    # 警告
    if report.get("warnings"):
        lines.append("## ⚠️ 警告")
        lines.append("")
        for warning in report["warnings"]:
            lines.append(f"- {warning}")
        lines.append("")

    # Session IDs
    if report.get("session_ids"):
        lines.append("## Session IDs")
        lines.append("")
        lines.append("```")
        for sid in report["session_ids"]:
            lines.append(sid)
        lines.append("```")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    log_file = Path(args.log_file)

    # 解析 --since 参数
    since: datetime | None = None
    if args.since:
        try:
            since = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
        except Exception as e:
            print(f"错误: 无法解析 --since 时间: {e}", file=sys.stderr)
            return 1

    # 加载记录
    records = load_logs(log_file, since)

    # 生成报告
    report = generate_report(records, args.min_duration)

    # 格式化输出
    output = format_markdown_report(report)

    # 输出
    if args.output:
        output_path = Path(args.output)
        output_path.write_text(output, encoding="utf-8")
        print(f"报告已保存到: {output_path}")
    else:
        print(output)

    return 0 if not report.get("warnings") else 1


if __name__ == "__main__":
    sys.exit(main())
