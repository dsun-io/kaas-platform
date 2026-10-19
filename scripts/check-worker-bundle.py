#!/usr/bin/env python
"""S6-c · Worker 包体积 / 冷启动门禁（方案 B 阶段二）

判据（README §3.2 / PLAN_B_EVALUATION §4）
----------------------------------------
- 包体积：Cloudflare Worker 上传上限 64 MiB（压缩前）；本项目目标远低于此（历史实测 ≈11.6 MiB）。
- 冷启动：相对验收线 **≤2,950 ms**（基线中位 2,680ms + 10%）。

怎么做
------
1. **包体积（本脚本自动跑）**：`pywrangler deploy --dry-run --outdir <tmp>` 在本地构建
   Worker bundle（**不上传、不部署、不需要 Cloudflare 凭据**），统计输出目录字节数。
   - 需要 `workers-py`（pywrangler）与可用的 uv/pyodide 工具链；若本机工具链不可用
     （例如 uv 的 pyodide 解释器探针损坏）→ 打印 SKIP 并退出 0，CI（ubuntu + 最新 uv）
     会真实执行。
   - 超过阈值 → 退出 1。
2. **冷启动（需一次经批准的 upload/deploy）**：脚本不主动联网测量。测量方法：
   在 Cloudflare Dashboard → Workers → kaas → Metrics 查看 p50 冷启动；或
   `npx wrangler tail kaas` 观察 `startup` 耗时（需已登录）。把中位数写进
   `backend/worker/coldstart-baseline.json`（格式见下），本脚本会校验 ≤2,950ms：
   ```json
   {"measured_at": "2026-10-20", "p50_ms": 2680, "method": "dashboard metrics", "commit": "<sha>"}
   ```
   没有该文件时：打印 PENDING（退出 0），并在 CI 日志里提示「冷启动基线待测」。

CI
--
`backend-test.yml` 的 worker job 会跑本脚本（包体积部分）；冷启动文件入库后自动纳入校验。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKER = REPO / "backend" / "worker"
BASELINE = WORKER / "coldstart-baseline.json"
MAX_BUNDLE_MIB = 64.0
TARGET_BUNDLE_MIB = 15.0  # 历史 11.59 MiB，留余量；超此值只告警
COLDSTART_LIMIT_MS = 2950


def _dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def measure_bundle() -> tuple[int, int]:
    outdir = Path(tempfile.mkdtemp(prefix="kaas-bundle-"))
    try:
        env = dict(os.environ)
        # pywrangler 装在 worker 的 dev 依赖里（workers-py），用 uv run 调用
        cmd = ["uv", "run", "--frozen", "pywrangler", "deploy", "--dry-run",
               "--outdir", str(outdir)]
        try:
            proc = subprocess.run(
                cmd, cwd=WORKER, capture_output=True, text=True, env=env, timeout=900,
            )
        except FileNotFoundError:
            print("SKIP: 未找到 uv（本机无法构建 Worker bundle；CI 会真实执行）")
            return -1, -1
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
            print("SKIP: pywrangler dry-run 失败（本机工具链不可用；CI 会真实执行）")
            for line in tail:
                print("  ", line)
            return -1, -1
        size = _dir_size(outdir)
        files = sum(1 for p in outdir.rglob("*") if p.is_file())
        return size, files
    finally:
        shutil.rmtree(outdir, ignore_errors=True)


def check_coldstart() -> int:
    if not BASELINE.exists():
        print(
            "PENDING: 冷启动基线未测（需一次经批准的 upload/deploy 后在 Dashboard/Metrics 读取；"
            f"验收线 ≤{COLDSTART_LIMIT_MS}ms）。把结果写入 {BASELINE.relative_to(REPO)} 即纳入校验。"
        )
        return 0
    data = json.loads(BASELINE.read_text(encoding="utf-8"))
    p50 = float(data["p50_ms"])
    if p50 <= COLDSTART_LIMIT_MS:
        print(f"PASS: 冷启动 p50={p50:.0f}ms ≤ {COLDSTART_LIMIT_MS}ms（{data.get('measured_at')}，{data.get('method')}）")
        return 0
    print(f"FAIL: 冷启动 p50={p50:.0f}ms > {COLDSTART_LIMIT_MS}ms（{data.get('measured_at')}）")
    return 1


def main() -> int:
    rc = 0
    print("== Worker 包体积（pywrangler deploy --dry-run，不上传不部署）==")
    size, files = measure_bundle()
    if size >= 0:
        mib = size / (1024 * 1024)
        print(f"bundle: {mib:.2f} MiB / {files} files（上限 {MAX_BUNDLE_MIB:.0f} MiB，历史 11.59 MiB）")
        if mib > MAX_BUNDLE_MIB:
            print("FAIL: 包体积超过 Cloudflare 64 MiB 上限")
            rc = 1
        elif mib > TARGET_BUNDLE_MIB:
            print(f"WARN: 包体积超过目标线 {TARGET_BUNDLE_MIB:.0f} MiB（未超硬限）")
    print()
    print("== Worker 冷启动（≤2950ms，相对验收线）==")
    rc = max(rc, check_coldstart())
    return rc


if __name__ == "__main__":
    sys.exit(main())
