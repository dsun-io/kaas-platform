#!/usr/bin/env python3
"""
千牛RPA 性能分析报告生成器
解析 chat_logs.jsonl，输出端到端延迟分析和优化建议
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="分析RPA性能日志，生成延迟报告和优化建议"
    )
    parser.add_argument(
        "--log-file",
        type=str,
        default="rpa-qianniu/data/chat_logs.jsonl",
        help="chat_logs.jsonl 文件路径",
    )
    parser.add_argument(
        "--target-ms",
        type=int,
        default=5000,
        help="目标端到端延迟（毫秒），默认5000ms",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="报告输出路径，默认输出到 stdout",
    )
    return parser.parse_args()


def load_records(log_file: Path) -> list[dict[str, Any]]:
    """加载日志记录"""
    records: list[dict[str, Any]] = []
    if not log_file.exists():
        return records

    with open(log_file, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def analyze_latency(records: list[dict[str, Any]], target_ms: int) -> dict[str, Any]:
    """分析延迟数据"""
    if not records:
        return {"error": "没有记录数据"}

    # 收集各阶段延迟
    total_times: list[int] = []
    ocr_times: list[int] = []
    ai_times: list[int] = []
    send_times: list[int] = []

    for r in records:
        if r.get("latency_total_ms"):
            total_times.append(r["latency_total_ms"])
        if r.get("latency_ocr_ms"):
            ocr_times.append(r["latency_ocr_ms"])
        if r.get("latency_ai_ms"):
            ai_times.append(r["latency_ai_ms"])
        if r.get("latency_send_ms"):
            send_times.append(r["latency_send_ms"])

    def stats(lst: list[int]) -> dict[str, float]:
        if not lst:
            return {"avg": 0, "min": 0, "max": 0, "p95": 0, "count": 0}
        lst_sorted = sorted(lst)
        n = len(lst_sorted)
        p95_idx = int(n * 0.95)
        return {
            "avg": round(sum(lst) / n, 1),
            "min": min(lst),
            "max": max(lst),
            "p95": lst_sorted[min(p95_idx, n - 1)],
            "count": n,
        }

    total_stats = stats(total_times)

    # 目标达成率
    meet_target = sum(1 for t in total_times if t <= target_ms)
    meet_rate = round(meet_target / len(total_times) * 100, 1) if total_times else 0

    # 瓶颈分析
    avg_components = {
        "ocr": stats(ocr_times)["avg"],
        "ai": stats(ai_times)["avg"],
        "send": stats(send_times)["avg"],
    }

    # 找出最大瓶颈
    bottleneck = max(avg_components, key=avg_components.get) if avg_components else "unknown"

    # 优化建议
    suggestions: list[str] = []
    if total_stats["avg"] > target_ms:
        suggestions.append(f"⚠️ 平均延迟 {total_stats['avg']}ms 超过目标 {target_ms}ms")

    if avg_components.get("ai", 0) > 2000:
        suggestions.append("🐢 AI调用耗时过长(>2s)，建议：检查FastGPT响应速度或启用AI_STUB_MODE测试")

    if avg_components.get("ocr", 0) > 1000:
        suggestions.append("🐢 OCR耗时过长(>1s)，建议：降低截图分辨率或检查PaddleOCR性能")

    if avg_components.get("send", 0) > 1000:
        suggestions.append("🐢 发送阶段耗时过长(>1s)，建议：优化vision_reply.py中的等待时间")

    if meet_rate < 80:
        suggestions.append(f"⚠️ 仅 {meet_rate}% 请求达到目标延迟，需要优化")
    elif meet_rate >= 95:
        suggestions.append(f"✅ {meet_rate}% 请求达到目标延迟，性能良好")

    if not suggestions:
        suggestions.append("✅ 性能指标正常")

    return {
        "target_ms": target_ms,
        "meet_target_rate": meet_rate,
        "total": stats(total_times),
        "ocr": stats(ocr_times),
        "ai": stats(ai_times),
        "send": stats(send_times),
        "bottleneck": bottleneck,
        "suggestions": suggestions,
        "record_count": len(records),
    }


def format_report(report: dict[str, Any]) -> str:
    """格式化报告为 Markdown"""
    if "error" in report:
        return f"# 性能分析报告\n\n⚠️ {report['error']}"

    lines = [
        "# 千牛RPA 性能分析报告",
        "",
        f"**目标端到端延迟**: {report['target_ms']}ms",
        f"**目标达成率**: {report['meet_target_rate']}%",
        f"**分析样本数**: {report['record_count']}",
        "",
        "## 端到端延迟统计",
        "",
        f"- 平均: {report['total']['avg']}ms",
        f"- 最小: {report['total']['min']}ms",
        f"- 最大: {report['total']['max']}ms",
        f"- P95: {report['total']['p95']}ms",
        "",
        "## 各阶段延迟分析",
        "",
        "| 阶段 | 平均 | 最小 | 最大 | 样本数 |",
        "|------|------|------|------|--------|",
    ]

    for stage in ["ocr", "ai", "send"]:
        s = report[stage]
        lines.append(f"| {stage.upper()} | {s['avg']}ms | {s['min']}ms | {s['max']}ms | {s['count']} |")

    lines.extend([
        "",
        f"**主要瓶颈**: {report['bottleneck'].upper()} 阶段",
        "",
        "## 优化建议",
        "",
    ])

    for sug in report['suggestions']:
        lines.append(f"- {sug}")

    lines.extend([
        "",
        "## 推荐配置",
        "",
        "复制 `.env.latency-optimized` 中的参数到 `.env`：",
        "",
        "```bash",
        "# 核心优化参数",
        "VISION_SESSION_SWITCH_WAIT_SEC=0.8",
        "VISION_CAPTURE_SETTLE_SEC=0.05",
        "VISION_POLL_ACTIVE_SEC=0.3",
        "ACTION_DELAY_MS_MIN=50",
        "ACTION_DELAY_MS_MAX=150",
        "AI_HTTP_TIMEOUT_SEC=10",
        "```",
    ])

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    log_file = Path(args.log_file)

    records = load_records(log_file)
    report = analyze_latency(records, args.target_ms)
    output = format_report(report)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"报告已保存: {args.output}")
    else:
        print(output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
