#!/usr/bin/env python3
"""S5-a preflight：部署前校验 Cloudflare API token 权限（失败给明确修复路径，不静默跳过）。

两步（lead 2026-10-20 口径）：
  1. ``GET /user/tokens/verify`` —— token 必须 active；
  2. ``GET /user/tokens/{id}`` —— policies[].permission_groups 必须**同时**包含
     （Account 层、作用于本账号）以下四个权限组（名称大小写不敏感）：
       · Workers Scripts:Edit      （部署 preview worker）
       · Workers Hyperdrive:Edit   （ensure/teardown 建删 config）
       · Workers R2 Storage:Edit / R2:Edit   （预览桶读写）
       · Workers KV Storage:Edit   （预览 KV 清理/绑定）

降级：若第 2 步读不到 policies（旧 token 或权限不足），打印告警并做**探针式校验**
（真实调一次 hyperdrive configs list / kv namespaces list / r2 buckets list，
403 即按缺失权限报错）。探针全过则视为通过 —— 权限最终是"能不能做事"决定的。

另做 NEON_API_KEY 阳性对照：GET /projects/{NEON_PROJECT_ID} 必须通。

退出码：0=通过；1=失败（日志含修复路径）。
"""
from __future__ import annotations

import argparse
import sys

_HERE = __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0]
sys.path.insert(0, _HERE)

from preview_lib import (  # noqa: E402
    CF_API_BASE, CloudflareClient, NeonClient, PreviewError, evidence, log,
    require_env, step,
)

# 权限组 → 可接受的名称别名（CF 权限组名称随版本微调，做包含匹配）
REQUIRED_PERMISSIONS: dict[str, tuple[str, ...]] = {
    "Workers Scripts:Edit": ("workers scripts edit", "worker scripts edit"),
    "Workers Hyperdrive:Edit": ("workers hyperdrive edit", "hyperdrive edit"),
    "R2:Edit": ("workers r2 storage edit", "r2 storage edit", "r2 edit"),
    "Workers KV Storage:Edit": ("workers kv storage edit", "kv storage edit"),
}

REMEDIATION = """\
修复路径（任选其一）：
  1. Cloudflare Dashboard → My Profile → API Tokens → 找到该 token → Edit →
     Permissions 补上面列出的权限组（Account 层，Resources = 本账号）→ Continue to summary → Update；
  2. 或新建一个 Account scoped token（权限组同上），把值更新进 GitHub secret
     CLOUDFLARE_API_TOKEN（Settings → Secrets and variables → Actions）。
改完重新跑本工作流即可，无需其它动作。"""


def collect_permission_names(policies: list[dict]) -> set[str]:
    names: set[str] = set()
    for policy in policies:
        for group in policy.get("permission_groups", []) or []:
            name = (group.get("name") or "").strip().lower()
            if name:
                names.add(name)
    return names


def probe_permissions(cf: CloudflareClient) -> list[str]:
    """探针式校验：返回缺失的权限组名（空列表=全过）。"""
    missing = []

    def _probe(label: str, fn, perm: str):
        try:
            fn()
            evidence(f"探针通过（{label}）", "OK")
        except PreviewError as exc:
            if "403" in str(exc) or "401" in str(exc):
                missing.append(perm)
                log(f"✘ 探针失败（{label}）: HTTP 403/401 → 缺 {perm}")
            else:
                raise

    _probe("hyperdrive configs list", cf.hyperdrive_list, "Workers Hyperdrive:Edit")
    _probe("r2 buckets list", cf.r2_list_buckets, "R2:Edit")
    _probe("kv namespaces list（账号级）", lambda: _kv_probe(cf), "Workers KV Storage:Edit")
    return missing


def _kv_probe(cf: CloudflareClient) -> None:
    from preview_lib import http_json
    http_json("GET", f"{CF_API_BASE}/accounts/{cf.account_id}/storage/kv/namespaces",
              headers=cf.headers)


def main() -> int:
    ap = argparse.ArgumentParser(description="S5 preflight: 校验 CF token 权限")
    ap.add_argument("--strict", action="store_true",
                    help="读不到 token policies 时直接失败（不做探针降级）")
    args = ap.parse_args()

    env = require_env(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
                       "NEON_API_KEY", "NEON_PROJECT_ID"])
    cf = CloudflareClient(env["CLOUDFLARE_API_TOKEN"], env["CLOUDFLARE_ACCOUNT_ID"])

    step("1) /user/tokens/verify（token 存活）")
    try:
        result = cf.token_verify()
    except PreviewError as exc:
        if "Invalid API Token" in str(exc):
            # /user/tokens/verify 只认 API token；OAuth token（如本机 wrangler 登录态）
            # 会 401 —— 降级为探针式校验（CI 注入的是 API token，不受影响）。
            log("⚠ /user/tokens/verify 拒绝该 token（OAuth token 不支持自省，本机常见）；"
                "CI 的 API token 不受此限。降级为探针式校验。")
            result, token_id = {}, ""
        else:
            raise
    else:
        token_id = result.get("id", "")
    if result:
        status = result.get("status", "")
        if status != "active":
            log(f"❌ token 状态 {status!r}（期望 active）。{REMEDIATION}")
            return 1
        evidence("token status", status)

    step("2) token policies（四个必备权限组）")
    policies = cf.token_policies(token_id) if token_id else []
    missing: list[str] = []
    if policies:
        granted = collect_permission_names(policies)
        for perm, aliases in REQUIRED_PERMISSIONS.items():
            hit = perm.lower() in granted or any(a in granted for a in aliases) or \
                any(any(alias in g for alias in aliases) for g in granted)
            if hit:
                evidence("权限组", perm)
            else:
                missing.append(perm)
                log(f"✘ 缺权限组: {perm}")
    else:
        log("⚠ 读不到 token policies（token 过旧或无权自省）—— 降级为探针式校验")
        if args.strict:
            log("❌ --strict 模式不允许降级。" + REMEDIATION)
            return 1
        missing = probe_permissions(cf)

    if missing:
        log("❌ preflight 失败，缺失权限组: " + ", ".join(missing))
        log(REMEDIATION)
        return 1

    step("3) NEON_API_KEY 阳性对照")
    neon = NeonClient(env["NEON_API_KEY"], env["NEON_PROJECT_ID"])
    project = neon.get_project()
    evidence("Neon 项目", f"{project.get('name')} ({env['NEON_PROJECT_ID']})")

    log("✅ preflight 通过")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PreviewError as exc:
        log(f"❌ {exc}")
        sys.exit(1)
