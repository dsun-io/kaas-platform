#!/usr/bin/env python3
"""
项目备份工具 - 备份数据库、日志、配置
支持自动压缩和保留策略
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import sys
import tarfile
import zipfile
from datetime import datetime
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="备份KAAS项目数据")
    parser.add_argument(
        "--output-dir",
        type=str,
        default="backups",
        help="备份输出目录",
    )
    parser.add_argument(
        "--format",
        choices=["zip", "tar.gz", "tar"],
        default="zip",
        help="备份格式",
    )
    parser.add_argument(
        "--retention-days",
        type=int,
        default=30,
        help="保留天数",
    )
    parser.add_argument(
        "--include-logs",
        action="store_true",
        help="包含日志文件",
    )
    parser.add_argument(
        "--include-debug",
        action="store_true",
        help="包含调试截图",
    )
    return parser.parse_args()


def get_project_root() -> Path:
    """获取项目根目录"""
    return Path(__file__).parent.parent.resolve()


def create_backup(
    project_root: Path,
    output_dir: Path,
    format_type: str,
    include_logs: bool,
    include_debug: bool,
) -> Path:
    """创建备份"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"kaas_backup_{timestamp}"

    output_dir.mkdir(parents=True, exist_ok=True)

    if format_type == "zip":
        backup_path = output_dir / f"{backup_name}.zip"
        with zipfile.ZipFile(backup_path, "w", zipfile.ZIP_DEFLATED) as zf:

            def add_file(path: Path, arcname: str) -> None:
                if path.exists():
                    zf.write(path, arcname)

            # 数据文件
            for subdir in ["rpa-qianniu", "rpa-pdd", "msg-router"]:
                data_dir = project_root / subdir / "data"
                if data_dir.exists():
                    for f in data_dir.glob("*"):
                        add_file(f, f"{subdir}/data/{f.name}")

            # 配置
            for subdir in ["rpa-qianniu", "rpa-pdd", "msg-router"]:
                config_dir = project_root / subdir / "config"
                if config_dir.exists():
                    for f in config_dir.glob("*.json"):
                        add_file(f, f"{subdir}/config/{f.name}")

            # 环境变量配置（脱敏）
            for subdir in ["rpa-qianniu", "rpa-pdd", "msg-router"]:
                env_example = project_root / subdir / ".env.example"
                add_file(env_example, f"{subdir}/.env.example")

            # 日志（可选）
            if include_logs:
                for subdir in ["rpa-qianniu", "rpa-pdd", "msg-router"]:
                    log_dir = project_root / subdir / "logs"
                    if log_dir.exists():
                        for f in log_dir.glob("*.log"):
                            add_file(f, f"{subdir}/logs/{f.name}")

            # 调试截图（可选）
            if include_debug:
                for subdir in ["rpa-qianniu", "rpa-pdd"]:
                    debug_dir = project_root / subdir / "debug"
                    if debug_dir.exists():
                        # 只包含最近24小时的调试文件
                        cutoff = datetime.now().timestamp() - 86400
                        for f in debug_dir.glob("*.png"):
                            if f.stat().st_mtime > cutoff:
                                add_file(f, f"{subdir}/debug/{f.name}")

    else:
        backup_path = output_dir / f"{backup_name}.tar.gz"
        with tarfile.open(backup_path, "w:gz") as tf:

            def add_tar(path: Path, arcname: str) -> None:
                if path.exists():
                    tf.add(path, arcname)

            # 同样逻辑
            for subdir in ["rpa-qianniu", "rpa-pdd", "msg-router"]:
                data_dir = project_root / subdir / "data"
                if data_dir.exists():
                    for f in data_dir.glob("*"):
                        add_tar(f, f"{subdir}/data/{f.name}")

    return backup_path


def cleanup_old_backups(output_dir: Path, retention_days: int) -> None:
    """清理旧备份"""
    if not output_dir.exists():
        return

    cutoff = datetime.now().timestamp() - (retention_days * 86400)
    cleaned = 0

    for backup_file in output_dir.glob("kaas_backup_*"):
        if backup_file.stat().st_mtime < cutoff:
            backup_file.unlink()
            cleaned += 1

    if cleaned > 0:
        print(f"清理了 {cleaned} 个旧备份文件")


def main() -> int:
    args = parse_args()

    project_root = get_project_root()
    output_dir = Path(args.output_dir)

    print("=" * 60)
    print("KAAS 项目备份工具")
    print("=" * 60)
    print()

    print(f"项目根目录: {project_root}")
    print(f"备份格式: {args.format}")
    print(f"包含日志: {args.include_logs}")
    print(f"包含调试: {args.include_debug}")
    print()

    try:
        backup_path = create_backup(
            project_root,
            output_dir,
            args.format,
            args.include_logs,
            args.include_debug,
        )
        print(f"✓ 备份创建成功: {backup_path}")

        size_mb = backup_path.stat().st_size / (1024 * 1024)
        print(f"  文件大小: {size_mb:.2f} MB")

        # 清理旧备份
        cleanup_old_backups(output_dir, args.retention_days)

        print()
        print("=" * 60)
        print("备份完成")
        print("=" * 60)
        return 0

    except Exception as e:
        print(f"✗ 备份失败: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
