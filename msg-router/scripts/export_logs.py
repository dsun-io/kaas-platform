"""
对话日志导出脚本
支持 CSV 和 JSON 格式导出

用法:
    python -m scripts.export_logs [--format csv|json] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD]
    或
    python scripts/export_logs.py [--format csv|json] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD]

输出:
    data/exports/chat_logs_YYYY-MM-DD_to_YYYY-MM-DD.{csv|json}
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings
from app.logger_db import _connect


def _iso_to_sqlite_date(iso_date: str) -> str:
    """将 YYYY-MM-DD 转换为 SQLite 日期范围"""
    dt = datetime.strptime(iso_date, "%Y-%m-%d")
    next_dt = dt + timedelta(days=1)
    start = dt.strftime("%Y-%m-%dT%H:%M:%S")
    end = next_dt.strftime("%Y-%m-%dT%H:%M:%S")
    return start, end


def export_to_json(date_from: str, date_to: str, output_path: Path) -> int:
    """导出为 JSON 格式"""
    start, _ = _iso_to_sqlite_date(date_from)
    _, end = _iso_to_sqlite_date(date_to)

    conn = _connect()
    try:
        cur = conn.execute(
            """
            SELECT * FROM chat_logs
            WHERE created_at >= ? AND created_at < ?
            ORDER BY created_at ASC
            """,
            (start, end),
        )

        rows = [dict(row) for row in cur.fetchall()]

        output_path.write_text(
            json.dumps(rows, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return len(rows)
    finally:
        conn.close()


def export_to_csv(date_from: str, date_to: str, output_path: Path) -> int:
    """导出为 CSV 格式"""
    start, _ = _iso_to_sqlite_date(date_from)
    _, end = _iso_to_sqlite_date(date_to)

    conn = _connect()
    try:
        cur = conn.execute(
            """
            SELECT * FROM chat_logs
            WHERE created_at >= ? AND created_at < ?
            ORDER BY created_at ASC
            """,
            (start, end),
        )

        rows = cur.fetchall()
        if not rows:
            # 写入空 CSV 带表头
            headers = [
                "id", "platform", "buyer_id", "message", "reply",
                "conversation_id", "should_transfer", "response_time_ms", "created_at",
                "ai_source", "ai_latency_ms", "tokens_in", "tokens_out",
                "status", "error_type", "error_detail", "inquiry_type",
            ]
            with open(output_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(headers)
            return 0

        # 获取列名
        headers = [description[0] for description in cur.description]

        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
            for row in rows:
                writer.writerow(row)

        return len(rows)
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="导出对话日志")
    parser.add_argument(
        "--format",
        type=str,
        choices=["json", "csv"],
        default="json",
        help="导出格式 (默认: json)",
    )
    parser.add_argument(
        "--date-from",
        type=str,
        required=True,
        help="开始日期 (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--date-to",
        type=str,
        required=True,
        help="结束日期 (YYYY-MM-DD, 包含)",
    )
    parser.add_argument(
        "--output",
        type=str,
        help="输出文件路径（可选，默认自动生成）",
    )
    args = parser.parse_args()

    # 验证日期格式
    try:
        datetime.strptime(args.date_from, "%Y-%m-%d")
        datetime.strptime(args.date_to, "%Y-%m-%d")
    except ValueError:
        print("错误: 日期格式必须是 YYYY-MM-DD")
        sys.exit(1)

    # 确保输出目录存在
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        output_dir = Path(settings.data_dir) / "exports"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"chat_logs_{args.date_from}_to_{args.date_to}.{args.format}"

    print(f"正在导出 {args.date_from} 到 {args.date_to} 的日志...")
    print(f"格式: {args.format}")

    if args.format == "json":
        count = export_to_json(args.date_from, args.date_to, output_path)
    else:
        count = export_to_csv(args.date_from, args.date_to, output_path)

    print(f"导出完成: {count} 条记录")
    print(f"保存路径: {output_path}")


if __name__ == "__main__":
    main()
