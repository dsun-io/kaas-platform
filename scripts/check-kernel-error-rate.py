#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内核错误率门禁（2026-10-24 事故驱动）。

背景（为什么必须有这个门禁）
--------------------------
2026-10-24 生产事故：Python 内核（Pyodide）初始化间歇失败，当日 scriptThrewException 3030 次、
错误率约 56%，用户侧成片 502；而**部署冒烟的探针全程返回 ok**（探针是匿名请求，且失败是概率性的）。
=> 只探"活着"不够，还要看「真实调用里失败占多少」。

判据
----
拉 Cloudflare GraphQL workersInvocationsAdaptive（script=kaas）最近 N 分钟，按 status 聚合：
- requests < min_requests ⇒ **跳过**（样本太少，不下结论；不会误报）；
- error_rate > max_error_rate ⇒ exit 1（打印按 status 的明细，便于判因）；
- 否则 exit 0。

用法
----
  python scripts/check-kernel-error-rate.py                     # 最近 15 分钟，阈值 30%
  python scripts/check-kernel-error-rate.py --minutes 30 --max-error-rate 0.2
  python scripts/check-kernel-error-rate.py --script kaas-edge  # 换脚本（默认内核 kaas）

环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID（部署流水线已注入）。只读：仅查询 GraphQL。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.request

# 控制台编码兜底（Windows 默认 GBK 会让 emoji/生僻字符抛 UnicodeEncodeError ⇒ 误判为门禁失败）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"

QUERY = """
query($acct: String!, $script: String!, $from: Time!) {
  viewer {
    accounts(filter: {accountTag: $acct}) {
      workersInvocationsAdaptive(
        limit: 500,
        filter: {datetimeMinute_geq: $from, scriptName: $script},
        orderBy: [datetimeMinute_ASC]
      ) {
        sum { requests errors }
        dimensions { status datetimeMinute }
      }
    }
  }
}
"""


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print("ERROR: 缺少环境变量 " + name + "（本脚本只读，但需要 Cloudflare API 凭据）", file=sys.stderr)
        raise SystemExit(2)
    return value


def fetch_rows(account_id: str, token: str, script: str, minutes: int) -> list[dict]:
    since = (
        _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=minutes)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = json.dumps({"query": QUERY, "variables": {"acct": account_id, "script": script, "from": since}}).encode()
    req = urllib.request.Request(
        GRAPHQL_URL,
        data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print("ERROR: GraphQL HTTP " + str(exc.code) + ": " + exc.read().decode("utf-8", "replace")[:500], file=sys.stderr)
        raise SystemExit(2)
    except Exception as exc:  # noqa: BLE001
        print("ERROR: GraphQL 请求失败: " + str(exc), file=sys.stderr)
        raise SystemExit(2)

    if payload.get("errors"):
        print("ERROR: GraphQL 返回错误: " + json.dumps(payload["errors"], ensure_ascii=False)[:800], file=sys.stderr)
        raise SystemExit(2)
    accounts = (payload.get("data") or {}).get("viewer", {}).get("accounts") or []
    if not accounts:
        return []
    return accounts[0].get("workersInvocationsAdaptive") or []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="内核错误率门禁（只读）")
    parser.add_argument("--minutes", type=int, default=15, help="回看窗口（分钟），默认 15")
    parser.add_argument("--max-error-rate", type=float, default=0.30, help="允许的最大错误率，默认 0.30")
    parser.add_argument("--min-requests", type=int, default=50, help="样本下限，低于此值跳过判定，默认 50")
    parser.add_argument("--script", default="kaas", help="Worker 脚本名，默认内核 kaas")
    args = parser.parse_args(argv)

    account_id = _require_env("CLOUDFLARE_ACCOUNT_ID")
    token = _require_env("CLOUDFLARE_API_TOKEN")

    rows = fetch_rows(account_id, token, args.script, args.minutes)

    totals: dict[str, list[int]] = {}
    requests = 0
    errors = 0
    for row in rows:
        status = (row.get("dimensions") or {}).get("status") or "unknown"
        sums = row.get("sum") or {}
        req = int(sums.get("requests") or 0)
        err = int(sums.get("errors") or 0)
        slot = totals.setdefault(status, [0, 0])
        slot[0] += req
        slot[1] += err
        requests += req
        errors += err

    print("== 内核错误率检查：script=" + args.script + " 最近 " + str(args.minutes) + " 分钟 ==")
    if not rows:
        print("（窗口内无调用数据）")
    for status, (req, err) in sorted(totals.items(), key=lambda kv: -kv[1][0]):
        print("  " + status.ljust(26) + " requests=" + str(req).ljust(7) + " errors=" + str(err))

    if requests < args.min_requests:
        print("SKIP: 样本不足（requests=" + str(requests) + " < " + str(args.min_requests) + "），本次不下结论")
        return 0

    rate = errors / requests if requests else 0.0
    print("  合计 requests=" + str(requests) + " errors=" + str(errors) + " error_rate=" + format(rate, ".1%") + "（阈值 " + format(args.max_error_rate, ".0%") + "）")
    if rate > args.max_error_rate:
        print("::error::内核错误率超阈值 —— 大概率是 Pyodide 初始化期失败（NoGilError / promising-task SystemError）。"
              "请查 wrangler tail kaas 与 docs/INCIDENT_2026-10-24_KERNEL_502.md")
        return 1
    print("PASS: 内核错误率在阈值内")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
