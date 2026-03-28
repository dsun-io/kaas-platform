"""
每日聚合统计脚本
生成日期维度的业务数据聚合报告

用法:
    python -m scripts.daily_stats [--date YYYY-MM-DD]
    或
    python scripts/daily_stats.py [--date YYYY-MM-DD]

输出:
    data/daily_stats/YYYY-MM-DD.json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

# 添加父目录到路径以支持直接运行
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings
from app.logger_db import _connect


def _get_date_range(target_date: str) -> tuple[str, str]:
    """获取指定日期的开始和结束时间（ISO格式）"""
    dt = datetime.strptime(target_date, "%Y-%m-%d")
    next_dt = dt + timedelta(days=1)
    start = dt.strftime("%Y-%m-%dT%H:%M:%S")
    end = next_dt.strftime("%Y-%m-%dT%H:%M:%S")
    return start, end


def generate_daily_stats(target_date: str) -> dict:
    """生成指定日期的聚合统计"""
    start, end = _get_date_range(target_date)

    conn = _connect()
    try:
        # 基础统计
        cur = conn.execute(
            """
            SELECT
                COUNT(*) as total_conversations,
                AVG(response_time_ms) as avg_response_time_ms,
                SUM(CASE WHEN should_transfer = 1 THEN 1 ELSE 0 END) as transfer_count,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
                SUM(CASE WHEN status = 'ai_failed' THEN 1 ELSE 0 END) as failed_count
            FROM chat_logs
            WHERE created_at >= ? AND created_at < ?
            """,
            (start, end),
        )
        row = cur.fetchone()

        total = row["total_conversations"] or 0
        transfer_count = row["transfer_count"] or 0
        sent_count = row["sent_count"] or 0
        failed_count = row["failed_count"] or 0

        # AI 成功率（排除转人工的）
        ai_attempts = total - transfer_count
        ai_success_rate = (sent_count / ai_attempts * 100) if ai_attempts > 0 else 0.0

        # 转人工率
        transfer_rate = (transfer_count / total * 100) if total > 0 else 0.0

        # Token 消耗统计
        cur = conn.execute(
            """
            SELECT
                SUM(tokens_in) as total_tokens_in,
                SUM(tokens_out) as total_tokens_out,
                COUNT(CASE WHEN tokens_in IS NOT NULL THEN 1 END) as token_records
            FROM chat_logs
            WHERE created_at >= ? AND created_at < ?
            """,
            (start, end),
        )
        token_row = cur.fetchone()

        total_tokens_in = token_row["total_tokens_in"] or 0
        total_tokens_out = token_row["total_tokens_out"] or 0
        token_records = token_row["token_records"] or 0

        # 咨询类型分布
        cur = conn.execute(
            """
            SELECT inquiry_type, COUNT(*) as count
            FROM chat_logs
            WHERE created_at >= ? AND created_at < ?
            GROUP BY inquiry_type
            """,
            (start, end),
        )
        inquiry_distribution = {
            row["inquiry_type"] or "other": row["count"]
            for row in cur.fetchall()
        }

        # AI 来源分布
        cur = conn.execute(
            """
            SELECT ai_source, COUNT(*) as count
            FROM chat_logs
            WHERE created_at >= ? AND created_at < ?
            GROUP BY ai_source
            """,
            (start, end),
        )
        ai_source_distribution = {
            row["ai_source"] or "unknown": row["count"]
            for row in cur.fetchall()
        }

        # 平台分布
        cur = conn.execute(
            """
            SELECT platform, COUNT(*) as count
            FROM chat_logs
            WHERE created_at >= ? AND created_at < ?
            GROUP BY platform
            """,
            (start, end),
        )
        platform_distribution = {
            row["platform"]: row["count"]
            for row in cur.fetchall()
        }

        stats = {
            "date": target_date,
            "generated_at": datetime.now().isoformat(),
            "summary": {
                "total_conversations": total,
                "ai_success_rate_percent": round(ai_success_rate, 2),
                "transfer_rate_percent": round(transfer_rate, 2),
                "avg_response_time_ms": round(row["avg_response_time_ms"] or 0, 2),
            },
            "status_breakdown": {
                "sent": sent_count,
                "ai_failed": failed_count,
                "transfer": transfer_count,
            },
            "token_usage": {
                "total_tokens_in": total_tokens_in,
                "total_tokens_out": total_tokens_out,
                "total_tokens": total_tokens_in + total_tokens_out,
                "records_with_token_data": token_records,
            },
            "inquiry_type_distribution": inquiry_distribution,
            "ai_source_distribution": ai_source_distribution,
            "platform_distribution": platform_distribution,
        }

        return stats

    finally:
        conn.close()


def save_stats(stats: dict, target_date: str) -> Path:
    """保存统计结果到 JSON 文件"""
    output_dir = Path(settings.data_dir) / "daily_stats"
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{target_date}.json"
    output_path.write_text(
        json.dumps(stats, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return output_path


def main():
    parser = argparse.ArgumentParser(description="生成每日业务数据聚合统计")
    parser.add_argument(
        "--date",
        type=str,
        help="目标日期 (YYYY-MM-DD)，默认为昨天",
    )
    args = parser.parse_args()

    if args.date:
        target_date = args.date
    else:
        # 默认统计昨天
        yesterday = datetime.now() - timedelta(days=1)
        target_date = yesterday.strftime("%Y-%m-%d")

    print(f"正在生成 {target_date} 的统计报告...")

    stats = generate_daily_stats(target_date)
    output_path = save_stats(stats, target_date)

    print(f"统计报告已保存: {output_path}")
    print(f"总对话数: {stats['summary']['total_conversations']}")
    print(f"AI 成功率: {stats['summary']['ai_success_rate_percent']}%")
    print(f"转人工率: {stats['summary']['transfer_rate_percent']}%")


if __name__ == "__main__":
    main()
