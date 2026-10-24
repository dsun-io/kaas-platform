# -*- coding: utf-8 -*-
"""E1/E3 压测脚本（工单 A6）：串行 vs 并发冷启动。

用法：
  python pressure.py <base_url> [--mode serial|concurrent] [--n 10]

判据（写进工单 §3A/A6）：
  · serial 组与 concurrent 组分别统计 成功/失败 与异常签名；
  · 若只有 concurrent 出现 "Cannot enter a promising task" ⇒ 支持「并发 init 重入竞态」；
  · 若两组都出现 ⇒ 与并发无关，更像一次性初始化必败（包体/运行时）。
"""
from __future__ import annotations

import argparse
import json
import threading
import time
import urllib.error
import urllib.request

# workers.dev 会按 UA 拦机器人（Error 1010）⇒ 压测一律带稳定 UA。
HEADERS = {
    "accept": "application/json",
    "user-agent": "kaas-pyinit-probe/1.0 (+https://kaas.powervoy.com)",
}


def hit(url, out, errors):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            resp.read()
            out.append(resp.status)
    except urllib.error.HTTPError as exc:
        out.append(exc.code)
        errors.append(exc.read().decode("utf-8", "replace")[:300])
    except Exception as exc:  # noqa: BLE001
        out.append(0)
        errors.append(type(exc).__name__ + ": " + str(exc)[:200])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("base_url")
    ap.add_argument("--mode", choices=["serial", "concurrent"], default="serial")
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--gap", type=float, default=1.0, help="serial 模式每次间隔秒数")
    args = ap.parse_args()

    url = args.base_url.rstrip("/") + "/"
    statuses, errors = [], []
    t0 = time.time()
    if args.mode == "serial":
        for _ in range(args.n):
            hit(url, statuses, errors)
            time.sleep(args.gap)
    else:
        threads = [threading.Thread(target=hit, args=(url, statuses, errors)) for _ in range(args.n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    elapsed = round(time.time() - t0, 1)
    ok = sum(1 for s in statuses if 200 <= s < 300)
    print(json.dumps({
        "base_url": args.base_url,
        "mode": args.mode,
        "n": args.n,
        "elapsed_s": elapsed,
        "success": ok,
        "fail": len(statuses) - ok,
        "statuses": statuses,
        "errors_sample": errors[:5],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
