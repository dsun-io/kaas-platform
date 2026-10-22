#!/usr/bin/env python
"""部署拓扑静态门禁：生产自定义域名只能归 kaas-edge（TS 门面），内核 kaas 不得声明/持有。

背景（2026-10-22 取证）：
2026-10-21 切流时把内核域名摘了，但改动只落在工作树、没入库 ——
backend/worker/wrangler.jsonc 仍声明 kaas.powervoy.com / api.kaas.powervoy.com。
任何一次内核部署（pywrangler deploy = npx wrangler deploy）都会把这两条域名从
kaas-edge 改绑回 kaas（wrangler 对已属于别的 Worker 的 custom domain 会 override，
非交互环境静默执行）。本门禁把「域名归属」变成可执行的静态断言；--live 另外对
Cloudflare 线上归属做只读断言（部署后等待归属切换）。

检查项：
1. backend/worker/wrangler.jsonc：name=kaas、routes 为空、无 custom_domain、workers_dev=false
2. backend/ts-worker/wrangler.jsonc：name=kaas-edge、custom domain 恰为两条且
   zone_name=powervoy.com、workers_dev=false
3. --live：GET /accounts/{id}/workers/domains，两条域名必须属于 kaas-edge（production），
   且没有任何自定义域名指向 kaas。

用法：
  python scripts/check-deploy-domains.py
  python scripts/check-deploy-domains.py --root <repo copy>        # 负控制/自测
  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
      python scripts/check-deploy-domains.py --live [--retries 12 --delay 10]

退出码：0 通过；1 违规；2 取证失败（配置读不了 / 缺 token / API 报错）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

KERNEL_HOSTS = {"kaas.powervoy.com", "api.kaas.powervoy.com"}
ZONE = "powervoy.com"
KERNEL_SCRIPT = "kaas"
EDGE_SCRIPT = "kaas-edge"


class CheckError(Exception):
    """取证失败（不是配置违规）。"""


def strip_jsonc(text: str) -> str:
    """剥离 JSONC 注释（// 与 /* */）与尾逗号；字符串内部原样保留（S3 endpoint 含 //）。"""
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    escaped = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            nl = text.find("\n", i + 2)
            if nl < 0:
                break
            i = nl
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            if end < 0:
                break
            i = end + 2
            continue
        out.append(ch)
        i += 1
    return _strip_trailing_commas("".join(out))


def _strip_trailing_commas(text: str) -> str:
    """在字符串**外**删除 } / ] 前的尾逗号（不能直接对全文用正则，否则会误伤字符串内容）。"""
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    escaped = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "}]":
                i += 1
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def load_config(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError as exc:
        raise CheckError(f"找不到配置文件: {path}") from exc
    except (UnicodeDecodeError, OSError) as exc:
        raise CheckError(f"读取配置文件失败（编码/权限）: {path}: {exc}") from exc
    try:
        return json.loads(strip_jsonc(text))
    except json.JSONDecodeError as exc:
        raise CheckError(f"{path} 不是合法 JSONC: {exc}") from exc


def custom_domains(config: dict) -> list[dict]:
    routes = config.get("routes") or []
    if not isinstance(routes, list):
        raise CheckError("routes 必须是数组")
    return [r for r in routes if isinstance(r, dict) and r.get("custom_domain") is True]


def check_static(root: Path) -> list[str]:
    errors: list[str] = []
    kernel = load_config(root / "backend" / "worker" / "wrangler.jsonc")
    edge = load_config(root / "backend" / "ts-worker" / "wrangler.jsonc")

    if kernel.get("name") != KERNEL_SCRIPT:
        errors.append(f"内核 name 应为 {KERNEL_SCRIPT!r}，实际 {kernel.get('name')!r}")
    if kernel.get("routes"):
        errors.append(
            f"内核 routes 必须为空（否则部署会把生产域名抢回内核），实际 {kernel.get('routes')!r}"
        )
    kernel_domains = custom_domains(kernel)
    if kernel_domains:
        errors.append(
            "内核不得声明 custom_domain，实际 "
            + repr([d.get("pattern") for d in kernel_domains])
        )
    if kernel.get("workers_dev") is not False:
        errors.append("内核 workers_dev 必须为 false（否则会拿到 workers.dev 公网入口）")

    if edge.get("name") != EDGE_SCRIPT:
        errors.append(f"门面 name 应为 {EDGE_SCRIPT!r}，实际 {edge.get('name')!r}")
    if edge.get("workers_dev") is not False:
        errors.append("门面 workers_dev 必须为 false（仅保留生产自定义域名）")
    edge_domains = custom_domains(edge)
    patterns = [d.get("pattern") for d in edge_domains]
    if set(patterns) != KERNEL_HOSTS or len(patterns) != len(KERNEL_HOSTS):
        errors.append(
            f"门面 custom domains 应恰为 {sorted(KERNEL_HOSTS)}（且不重复），实际 {patterns!r}"
        )
    services = edge.get("services") or []
    kernel_bindings = [
        s for s in services if isinstance(s, dict) and s.get("binding") == "KERNEL"
    ]
    if not kernel_bindings or kernel_bindings[0].get("service") != KERNEL_SCRIPT:
        errors.append(
            "门面 services 必须声明 {binding: KERNEL, service: kaas}，实际 "
            + repr(kernel_bindings)
        )
    for domain in edge_domains:
        if domain.get("zone_name") != ZONE:
            errors.append(
                f"门面域名 {domain.get('pattern')} zone_name 应为 {ZONE!r}，"
                f"实际 {domain.get('zone_name')!r}"
            )
    return errors


def _cf_get(url: str, token: str, attempts: int = 3) -> dict:
    """GET CF API；429/5xx/网络错误做有限重试（云侧抖动 ≠ 配置违规），401/403 快速失败。"""
    last: CheckError | None = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            last = CheckError(f"Cloudflare API HTTP {exc.code}: {detail}")
            if (exc.code == 429 or exc.code >= 500) and attempt < attempts:
                time.sleep(2 * attempt)
                continue
            raise last from exc
        except urllib.error.URLError as exc:
            last = CheckError(f"Cloudflare API 不可达: {exc.reason}")
            if attempt < attempts:
                time.sleep(2 * attempt)
                continue
            raise last from exc
        if not payload.get("success"):
            raise CheckError(f"Cloudflare API 返回失败: {payload.get('errors')}")
        return payload
    raise last or CheckError("Cloudflare API 请求失败")


def _fetch_all_domains(account_id: str, token: str) -> list[dict]:
    """分页拉取账号全部 Worker custom domains（默认每页 20，必须翻页）。"""
    base = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/domains"
    out: list[dict] = []
    page = 1
    while page <= 20:
        payload = _cf_get(f"{base}?per_page=100&page={page}", token)
        result = payload.get("result") or []
        out.extend(result)
        info = payload.get("result_info") or {}
        total = info.get("total_count")
        if not result or (isinstance(total, int) and len(out) >= total):
            break
        page += 1
    return out


def check_live(account_id: str, token: str, retries: int, delay: float) -> list[str]:
    last = ""
    for attempt in range(1, retries + 1):
        # environment 缺失时按 production 处理（避免 API 字段口径变化造成假 FAIL）
        domains = [
            d for d in _fetch_all_domains(account_id, token)
            if d.get("environment") in (None, "production")
        ]
        owners = {d.get("hostname"): d.get("service") for d in domains}
        errors: list[str] = []
        for host in sorted(KERNEL_HOSTS):
            owner = owners.get(host)
            if owner != EDGE_SCRIPT:
                errors.append(f"线上域名 {host} 应归 {EDGE_SCRIPT!r}，实际 {owner!r}")
        for host, owner in sorted(owners.items()):
            if owner == KERNEL_SCRIPT:
                errors.append(f"线上域名 {host} 仍指向内核 {KERNEL_SCRIPT!r}（应只归 {EDGE_SCRIPT!r}）")
        if not errors:
            rendered = ", ".join(f"{h}->{owners.get(h)}" for h in sorted(KERNEL_HOSTS))
            print(f"[deploy-topology] live OK (attempt {attempt}): {rendered}")
            return []
        last = "; ".join(errors)
        if attempt < retries:
            print(
                f"[deploy-topology] live not settled (attempt {attempt}/{retries}): {last}",
                file=sys.stderr,
            )
            time.sleep(delay)
    return [f"线上域名归属校验失败（{retries} 次重试）: {last}"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="部署拓扑门禁：生产域名只归 kaas-edge")
    parser.add_argument(
        "--root", default=str(Path(__file__).resolve().parent.parent), help="仓库根（负控制用）"
    )
    parser.add_argument("--live", action="store_true", help="同时做 Cloudflare 线上归属断言")
    parser.add_argument("--retries", type=int, default=12, help="--live 重试次数（默认 12）")
    parser.add_argument("--delay", type=float, default=10.0, help="--live 重试间隔秒（默认 10）")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    try:
        errors = check_static(root)
        if args.live:
            token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
            account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
            if not token or not account:
                raise CheckError("--live 需要 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID")
            errors += check_live(
                account, token, max(1, args.retries), max(0.0, args.delay)
            )
    except CheckError as exc:
        print(f"[deploy-topology] ERROR: {exc}", file=sys.stderr)
        return 2

    if errors:
        print("[deploy-topology] FAIL:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        print(
            "  纪律：生产域名只能由 kaas-edge 持有；内核 routes 必须为 []（AGENTS.md 两层架构）。",
            file=sys.stderr,
        )
        return 1
    print(
        "[deploy-topology] OK: 内核无公网域名；kaas-edge 持有 "
        + ", ".join(sorted(KERNEL_HOSTS))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
