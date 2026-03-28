#!/usr/bin/env python3
"""
数据导出工具 - 导出聊天记录和分析报告
支持 JSON/CSV/SQLite 格式
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="导出RPA数据")
    parser.add_argument(
        "--format",
        choices=["json", "csv", "sqlite"],
        default="json",
        help="导出格式",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="输出文件路径",
    )
    parser.add_argument(
        "--input",
        type=str,
        default="rpa-qianniu/data/chat_logs.jsonl",
        help="输入日志文件",
    )
    parser.add_argument(
        "--since",
        type=str,
        help="起始日期 (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--until",
        type=str,
        help="结束日期 (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--platform",
        type=str,
        help="平台筛选 (qianniu/pdd)",
    )
    return parser.parse_args()


def load_jsonl(filepath: Path) -> list[dict[str, Any]]:
    """加载 JSONL 文件"""
    records: list[dict[str, Any]] = []
    if not filepath.exists():
        return records

    with open(filepath, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def filter_records(
    records: list[dict[str, Any]],
    since: str | None,
    until: str | None,
    platform: str | None,
) -> list[dict[str, Any]]:
    """筛选记录"""
    filtered = records

    if since:
        since_dt = datetime.strptime(since, "%Y-%m-%d")
        filtered = [
            r
            for r in filtered
            if datetime.strptime(r.get("timestamp", "1970-01-01")[:10], "%Y-%m-%d")
            >= since_dt
        ]

    if until:
        until_dt = datetime.strptime(until, "%Y-%m-%d") + timedelta(days=1)
        filtered = [
            r
            for r in filtered
            if datetime.strptime(r.get("timestamp", "1970-01-01")[:10], "%Y-%m-%d")
            < until_dt
        ]

    if platform:
        filtered = [r for r in filtered if r.get("platform") == platform]

    return filtered


def export_json(records: list[dict[str, Any]], output: Path) -> None:
    """导出为 JSON"""
    with open(output, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def export_csv(records: list[dict[str, Any]], output: Path) -> None:
    """导出为 CSV"""
    if not records:
        return

    # 确定列名
    all_keys = set()
    for r in records:
        all_keys.update(r.keys())
    fieldnames = sorted(all_keys)

    with open(output, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)


def export_sqlite(records: list[dict[str, Any]], output: Path) -> None:
    """导出为 SQLite"""
    if output.exists():
        output.unlink()

    conn = sqlite3.connect(output)
    cursor = conn.cursor()

    # 创建表
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            platform TEXT,
            buyer_nick TEXT,
            buyer_msg TEXT,
            ai_reply TEXT,
            ai_source TEXT,
            status TEXT,
            latency_total_ms INTEGER,
            latency_ai_ms INTEGER,
            session_id TEXT,
            conversation_id TEXT,
            round_index INTEGER
        )
        """
    )

    # 插入数据
    for r in records:
        cursor.execute(
            """
            INSERT INTO chat_logs (
                timestamp, platform, buyer_nick, buyer_msg, ai_reply,
                ai_source, status, latency_total_ms, latency_ai_ms,
                session_id, conversation_id, round_index
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                r.get("timestamp"),
                r.get("platform"),
                r.get("buyer_nick"),
                r.get("buyer_msg"),
                r.get("ai_reply"),
                r.get("ai_source"),
                r.get("status"),
                r.get("latency_total_ms"),
                r.get("latency_ai_ms"),
                r.get("session_id"),
                r.get("conversation_id"),
                r.get("round_index"),
            ),
        )

    conn.commit()
    conn.close()


def main() -> int:
    args = parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    print(f"正在读取 {input_path}...")
    records = load_jsonl(input_path)
    print(f"加载了 {len(records)} 条记录")

    # 筛选
    filtered = filter_records(records, args.since, args.until, args.platform)
    print(f"筛选后: {len(filtered)} 条记录")

    if not filtered:
        print("没有记录可导出")
        return 1

    # 导出
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if args.format == "json":
        export_json(filtered, output_path)
    elif args.format == "csv":
        export_csv(filtered, output_path)
    elif args.format == "sqlite":
        export_sqlite(filtered, output_path)

    print(f"已导出到: {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
