#!/usr/bin/env python
"""W3 Phase 0 · 金标对照 harness 原型（不改任何产品代码）。

对同一个请求清单分别打两个 base URL（将来 = 本地 Python worker vs 本地 TS
worker；现在可以是任意两个环境，如生产做右端基线），按 JSON 语义 diff
响应（白名单字段忽略），输出 markdown 差异报告。

用法（解释器用 backend/orchestrator/.venv 或 backend/worker/.venv 的 python，
脚本只依赖标准库）：

    python backend/ts-migration/golden/diff_responses.py \
        --left http://localhost:8000 --right https://kaas.powervoy.com --only smoke

    # 列出全部内置请求
    python backend/ts-migration/golden/diff_responses.py --list

    # 报告写入文件（默认只打印到 stdout）
    python backend/ts-migration/golden/diff_responses.py ... --out report.md

纪律：
    - 对生产只打无副作用请求（清单按 side_effect 标注；smoke 全是只读/401 探针）。
    - 生产 auth 端点有 zone 限流（5 次/10 秒/IP，2026-10-20 口径）：
      默认相邻请求间隔 --delay 2.0 秒，别调小。
    - 命中生产域名时若清单含 side_effect != none 的请求会直接拒绝执行。

退出码：0 = 全部一致；1 = 存在差异或某端失败；2 = 用法错误。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

REQUESTS = [
    {
        "group": "smoke",
        "name": "health",
        "method": "GET",
        "path": "/health",
        "body": None,
        "headers": {},
        "expect_status": 200,
        "side_effect": "none",
    },
    {
        "group": "smoke",
        "name": "openapi_surface",
        "method": "GET",
        "path": "/openapi.json",
        "body": None,
        "headers": {},
        "expect_status": 200,
        "side_effect": "none",
    },
    {
        "group": "smoke",
        "name": "login_unknown_account",
        "method": "POST",
        "path": "/api/v1/auth/login",
        "body": {"email": "golden-harness@example.com", "password": "wrong-password-000"},
        "headers": {},
        "expect_status": 401,
        "side_effect": "none",
        "note": "不存在的账号 + 错误密码：探的是 401 形状，不碰真实账号（避免锁死/限流真实用户）。",
    },
    {
        "group": "smoke",
        "name": "me_no_token",
        "method": "GET",
        "path": "/api/v1/auth/me",
        "body": None,
        "headers": {},
        "expect_status": 401,
        "side_effect": "none",
    },
    {
        "group": "smoke",
        "name": "me_invalid_token",
        "method": "GET",
        "path": "/api/v1/auth/me",
        "body": None,
        "headers": {"Authorization": "Bearer golden.invalid.token"},
        "expect_status": 401,
        "side_effect": "none",
    },
]
# 门面域 401 形状探针（2026-10-21 波 A/B 起）
# 全部无 token + side_effect=none：探「路由存在 + 鉴权拒绝信封」，不触达数据。
_FACADE_PROBES = [
    ("GET", "/api/v1/auth/me"),
    ("GET", "/api/v1/customers"),
    ("GET", "/api/v1/customers/capabilities"),
    ("GET", "/api/v1/teams"),
    ("GET", "/api/v1/teams/me"),
    ("GET", "/api/v1/orders"),
    ("GET", "/api/v1/files"),
    ("GET", "/api/v1/outreach"),
    ("GET", "/api/v1/admin/feature_flag"),
    ("GET", "/api/v1/quotes"),
    ("GET", "/api/v1/trade-docs"),
    ("GET", "/api/v1/ai"),
]
for _m, _p in _FACADE_PROBES:
    REQUESTS.append({
        "group": "facade401",
        "name": "unauth_" + _p.strip("/").replace("/", "_").replace("-", "_"),
        "method": _m,
        "path": _p,
        "body": None,
        "headers": {},
        "expect_status": 401,
        "side_effect": "none",
    })


# 白名单：不稳定字段在 JSON 语义 diff 时忽略（计划 §2 风险表：显式登记，不静默放过）。
IGNORE_KEYS = {
    "created_at", "updated_at", "deleted_at",
    "token", "access_token", "refresh_token", "reset_token", "setup_token",
    "expires_at", "expires_in", "issued_at", "last_login_at",
    "timestamp", "request_id", "trace_id", "nonce", "jti",
    "password_hash",
}
IGNORE_KEY_RE = re.compile(r"(_at|_token|_timestamp|_hash)$")
IGNORE_JWT_CLAIMS = {"iat", "exp", "nbf"}


def _ignored(key: str) -> bool:
    if key in IGNORE_JWT_CLAIMS:
        return True
    if key in IGNORE_KEYS:
        return True
    return bool(IGNORE_KEY_RE.match(key))


def fetch(base: str, req: dict, timeout: float) -> dict:
    url = base.rstrip("/") + req["path"]
    data = None
    headers = {"User-Agent": "kaas-golden-harness/0.1", "Accept": "application/json"}
    headers.update(req.get("headers") or {})
    if req.get("body") is not None:
        data = json.dumps(req["body"]).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=req["method"])
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
            ctype = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
        ctype = e.headers.get("Content-Type", "") if e.headers else ""
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    text = raw.decode("utf-8", errors="replace")
    try:
        body = json.loads(text)
        parsed = "json"
    except ValueError:
        body = text
        parsed = "text"
    return {"ok": True, "status": status, "content_type": ctype, "body": body, "parsed": parsed}


def diff_bodies(left, right, path: str = "$", out: list | None = None,
                float_tol: float = 0.0) -> list:
    if out is None:
        out = []
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(set(left) | set(right)):
            p = "%s.%s" % (path, key)
            if key not in left:
                out.append("%s: 仅右侧存在 = %s" % (p, _short(right[key])))
            elif key not in right:
                out.append("%s: 仅左侧存在 = %s" % (p, _short(left[key])))
            elif _ignored(key):
                continue
            else:
                diff_bodies(left[key], right[key], p, out, float_tol)
    elif isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            out.append("%s: 列表长度 %d != %d" % (path, len(left), len(right)))
        for i, (a, b) in enumerate(zip(left, right)):
            diff_bodies(a, b, "%s[%d]" % (path, i), out, float_tol)
    elif isinstance(left, (int, float)) and isinstance(right, (int, float)) \
            and not isinstance(left, bool) and not isinstance(right, bool):
        if abs(left - right) > float_tol:
            out.append("%s: %r != %r" % (path, left, right))
    elif left != right:
        out.append("%s: %r != %r" % (path, left, right))
    return out


def _short(value, limit: int = 80) -> str:
    text = repr(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def run(left_base: str, right_base: str, requests: list, delay: float,
        timeout: float, float_tol: float) -> tuple[str, int]:
    lines = []
    lines.append("# 金标对照报告（golden diff）")
    lines.append("")
    lines.append("- 左（将来 = 本地 Python worker）: %s" % left_base)
    lines.append("- 右（将来 = 本地 TS worker / 当前基线）: %s" % right_base)
    lines.append("- 时间: %s" % datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"))
    lines.append("- 白名单字段: 见 golden/diff_responses.py 的 IGNORE_KEYS / IGNORE_KEY_RE（计划 §2：显式登记）")
    lines.append("")
    lines.append("| # | 请求 | 期望 | 左 status | 右 status | 结论 |")
    lines.append("|---|---|---|---|---|---|")

    details = []
    n_fail = 0
    for i, req in enumerate(requests, 1):
        left = fetch(left_base, req, timeout)
        if delay:
            time.sleep(delay)
        right = fetch(right_base, req, timeout)
        if delay:
            time.sleep(delay)

        verdict_parts = []
        if not left["ok"]:
            verdict_parts.append("左端失败: " + left["error"])
        if not right["ok"]:
            verdict_parts.append("右端失败: " + right["error"])
        diffs = []
        if left["ok"] and right["ok"]:
            if left["status"] != right["status"]:
                verdict_parts.append("status 不一致")
            if left["parsed"] != right["parsed"]:
                verdict_parts.append("body 类型不一致 (%s vs %s)" % (left["parsed"], right["parsed"]))
            elif left["parsed"] == "json":
                diffs = diff_bodies(left["body"], right["body"], float_tol=float_tol)
                if diffs:
                    verdict_parts.append("body 差异 %d 处" % len(diffs))
        verdict = "；".join(verdict_parts) if verdict_parts else "✅ 一致"
        if verdict_parts:
            n_fail += 1

        lines.append("| %d | %s `%s` | %s | %s | %s | %s |" % (
            i,
            req["method"],
            req["path"],
            req.get("expect_status", "—"),
            str(left.get("status")) if left["ok"] else "ERR",
            str(right.get("status")) if right["ok"] else "ERR",
            verdict,
        ))

        details.append((req, left, right, verdict, diffs))

    lines.append("")
    total = len(requests)
    lines.append("**汇总: %d/%d 一致，%d 存在差异/失败。**" % (total - n_fail, total, n_fail))
    lines.append("")

    for req, left, right, verdict, diffs in details:
        lines.append("## %s `%s`（%s）" % (req["method"], req["path"], req["name"]))
        lines.append("")
        if req.get("note"):
            lines.append("> %s" % req["note"])
            lines.append("")
        lines.append("- 结论: %s" % verdict)
        lines.append("- 左: status=%s content-type=%s" % (
            left.get("status", left.get("error")), left.get("content_type", "—")))
        lines.append("- 右: status=%s content-type=%s" % (
            right.get("status", right.get("error")), right.get("content_type", "—")))
        if diffs:
            lines.append("")
            lines.append("差异明细（已应用白名单）:")
            for d in diffs[:50]:
                lines.append("- `%s`" % d)
            if len(diffs) > 50:
                lines.append("- … 共 %d 处，仅显示前 50" % len(diffs))
        lines.append("")

    return "\n".join(lines), (1 if n_fail else 0)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, OSError, ValueError):
        pass

    parser = argparse.ArgumentParser(description="金标对照 harness 原型")
    parser.add_argument("--left", default=None, help="左端 base URL（将来=本地 Python worker）")
    parser.add_argument("--right", default=None, help="右端 base URL（将来=本地 TS worker）")
    parser.add_argument("--only", default=None, help="只跑指定 group（逗号分隔），如 smoke")
    parser.add_argument("--list", action="store_true", help="列出内置请求清单后退出")
    parser.add_argument("--out", default=None, help="报告输出路径（默认只打印到 stdout）")
    parser.add_argument("--delay", type=float, default=2.0,
                        help="相邻请求间隔秒数（生产 auth 限流 5 次/10 秒，别调小；默认 2.0）")
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--float-tolerance", type=float, default=0.0,
                        help="数字比较容差（默认 0 = 精确；Decimal→float 漂移期可调）")
    args = parser.parse_args()

    if args.list:
        requests = REQUESTS
        for r in requests:
            print("%-8s %-6s %-45s expect=%s side_effect=%s" % (
                r["group"], r["method"], r["path"], r.get("expect_status"), r["side_effect"]))
        return 0
    if not args.left or not args.right:
        print("--left 与 --right 必填（--list 除外）", file=sys.stderr)
        return 2
    requests = REQUESTS
    if args.only:
        groups = {g.strip() for g in args.only.split(",") if g.strip()}
        requests = [r for r in requests if r["group"] in groups]
        if not requests:
            print("无匹配 --only %s 的请求" % args.only, file=sys.stderr)
            return 2

    if "kaas.powervoy.com" in (args.left + args.right):
        risky = [r["name"] for r in requests if r.get("side_effect") != "none"]
        if risky:
            print("拒绝打生产: 清单含写操作请求 %s" % risky, file=sys.stderr)
            return 2

    report, code = run(args.left, args.right, requests, args.delay, args.timeout,
                       args.float_tolerance)
    print(report)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(report)
        print("\n[报告已写入 %s]" % args.out, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
