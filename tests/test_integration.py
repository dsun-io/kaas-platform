#!/usr/bin/env python3
"""
集成测试套件 - 测试端到端流程
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path


def test_chat_logger() -> bool:
    """测试 chat_logger 功能"""
    print("Testing chat_logger...")

    # 模拟导入和测试
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "rpa-qianniu"))
        from app.chat_logger import log_conversation, _log_path

        # 创建临时目录
        with tempfile.TemporaryDirectory() as tmpdir:
            # 临时修改 state_dir
            import app.config

            original_dir = app.config.settings.state_dir
            app.config.settings.state_dir = tmpdir

            # 写入测试日志
            log_conversation(
                buyer_nick="test_buyer",
                buyer_msg="hello",
                ai_reply="hi",
                status="sent",
                platform="qianniu",
                session_id="test_session",
            )

            # 验证文件写入
            log_file = Path(tmpdir) / "chat_logs.jsonl"
            if log_file.exists():
                content = log_file.read_text()
                record = json.loads(content.strip())
                assert record["buyer_nick"] == "test_buyer"
                assert record["platform"] == "qianniu"
                assert record["session_id"] == "test_session"
                print("  ✓ chat_logger 测试通过")
                return True
            else:
                print("  ✗ chat_logger 文件未创建")
                return False

    except Exception as e:
        print(f"  ✗ chat_logger 测试失败: {e}")
        return False


def test_perf_analyzer() -> bool:
    """测试 perf_analyzer 功能"""
    print("Testing perf_analyzer...")

    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
        from scripts.perf_analyzer import load_records, analyze_latency

        # 创建临时日志文件
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            f.write(
                json.dumps(
                    {
                        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "platform": "qianniu",
                        "buyer_nick": "test",
                        "buyer_msg": "hello",
                        "ai_reply": "hi",
                        "status": "sent",
                        "latency_total_ms": 3000,
                        "latency_ai_ms": 1500,
                        "session_id": "abc123",
                    }
                )
                + "\n"
            )
            temp_path = f.name

        records = load_records(Path(temp_path))
        report = analyze_latency(records, target_ms=5000)

        Path(temp_path).unlink()

        assert report["count"] == 1
        assert report["meet_target_rate"] == 100.0
        print("  ✓ perf_analyzer 测试通过")
        return True

    except Exception as e:
        print(f"  ✗ perf_analyzer 测试失败: {e}")
        return False


def test_soak_report() -> bool:
    """测试 soak_report 功能"""
    print("Testing soak_report...")

    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
        from scripts.soak_report import load_logs, generate_report

        # 创建临时日志文件
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            f.write(
                json.dumps(
                    {
                        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "platform": "qianniu",
                        "buyer_nick": "test",
                        "buyer_msg": "hello",
                        "ai_reply": "hi",
                        "status": "sent",
                        "session_id": "abc123",
                    }
                )
                + "\n"
            )
            temp_path = f.name

        records = load_logs(Path(temp_path), since=None)
        report = generate_report(records, min_duration=0)

        Path(temp_path).unlink()

        assert report["total_sessions"] == 1
        assert report["success_count"] == 1
        print("  ✓ soak_report 测试通过")
        return True

    except Exception as e:
        print(f"  ✗ soak_report 测试失败: {e}")
        return False


def run_all_tests() -> bool:
    """运行所有集成测试"""
    print("=" * 60)
    print("KAAS 平台集成测试")
    print("=" * 60)
    print()

    results = []
    results.append(("chat_logger", test_chat_logger()))
    results.append(("perf_analyzer", test_perf_analyzer()))
    results.append(("soak_report", test_soak_report()))

    print()
    print("=" * 60)
    passed = sum(1 for _, r in results if r)
    total = len(results)
    print(f"测试结果: {passed}/{total} 通过")
    print("=" * 60)

    return passed == total


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
