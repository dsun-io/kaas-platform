"""清空生产库的账号 / 团队 / 业务数据（保留全局字典与系统配置）。

背景
----
2026-10-21 用户裁决：生产要「清除所有账号信息，重新创建」。
旧账号/团队占着邮箱与团队名（注册时团队名唯一 -> 409），且历史业务数据会变成孤儿，
所以一次清到「空平台」，但仍保留：

- 迁移状态：alembic_version（不降级、不删表）
- 全局字典 / 参考数据：market_ports（港口，103 行）、units / unit_groups / price_units
  （计量单位）、product_categories / product_specs / spec_*、subscriptions /
  subscription_bundles、fx_rates（汇率）、industry_templates
- 系统配置：ai_providers（AI Provider 配置，1 行）、feature_flags、intel_* 系统级配置
- 其余所有业务 / 账号表一律 TRUNCATE ... RESTART IDENTITY（含 users / teams /
  customers / 询盘 / 报价 / 订单 / 单证 / 事件流水 / 会话令牌 / 文件元数据等）。
- --keep-user <email>：白名单里的 users 行在 TRUNCATE 后**原样插回**（同 id / 同密码哈希 /
  同角色），用于「只保留某个管理员、其余全清」。未指定则一个账号都不留。

安全口径
--------
- 默认 dry-run：只读统计，不写库。
- 必须同时满足 --apply 且环境变量 RESET_CONFIRM=yes 才执行。
- 单事务内 TRUNCATE：要么全成功，要么回滚；开启 lock_timeout 防长时间锁表。
- 执行后自检：业务表计数必须全 0；保留表计数必须与执行前完全一致，否则非零退出。
- 生产 DSN 从环境变量 KAAS_DSN 或 ~/.dsh/secrets/neon-prod-dsn.txt 读取；
  不打印 DSN，只打印 current_database() / current_user。

用法
----
    # 只读盘点（默认）
    python scripts/reset-production-accounts.py

    # 真清（需用户明确确认后再执行）
    $env:RESET_CONFIRM="yes"
    python scripts/reset-production-accounts.py --apply --keep-user david@powervoy.com
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SECRETS = Path.home() / ".dsh" / "secrets" / "neon-prod-dsn.txt"

# 保留表：全局字典 / 参考数据 / 系统配置 / 迁移状态。
# 规则：只放「不属于任何账号或团队、重建账号后仍应存在」的表。
KEEP_TABLES = frozenset(
    {
        "alembic_version",
        # 全局字典
        "market_ports",
        "units",
        "unit_groups",
        "price_units",
        "product_categories",
        "product_specs",
        "spec_attributes",
        "spec_attribute_values",
        "subscriptions",
        "subscription_bundles",
        "industry_templates",
        # 全局汇率
        "fx_rates",
        # 系统配置
        "ai_providers",
        "feature_flags",
        "feature_flag_audit",
        "user_roles",
        # 市场情报的系统级配置（非用户业务数据）
        "intel_sources",
        "intel_data_channels",
        "intel_keyword_rules",
        "intel_product_categories",
        "intel_trade_stats",
        "intel_entities",
        "intel_demand_index",
        "intel_matches",
        "market_region_products",
        "market_region_product_specs",
        "market_product_usages",
        "market_product_usage_mappings",
        "market_product_name_mappings",
    }
)


def dsn_from_sources() -> str:
    dsn = os.environ.get("KAAS_DSN")
    if not dsn and SECRETS.exists():
        dsn = SECRETS.read_text(encoding="utf-8").strip()
    if not dsn:
        raise SystemExit(
            "缺少 DSN：设置 KAAS_DSN，或把生产连接串写入 ~/.dsh/secrets/neon-prod-dsn.txt"
        )
    return (
        dsn.replace("+asyncpg", "")
        .replace("postgresql+psycopg2", "postgresql")
        .strip()
    )


def qident(name: str) -> str:
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
        raise SystemExit(f"非法表名：{name!r}")
    return f'"{name}"'


def connect(readonly: bool):
    import psycopg2

    conn = psycopg2.connect(dsn_from_sources(), connect_timeout=30)
    conn.set_session(readonly=readonly, autocommit=False)
    return conn


def list_tables(cur) -> list[str]:
    cur.execute(
        "select table_name from information_schema.tables "
        "where table_schema='public' and table_type='BASE TABLE' order by 1"
    )
    return [r[0] for r in cur.fetchall()]


def count(cur, table: str) -> int:
    cur.execute(f"select count(*) from public.{qident(table)}")
    return int(cur.fetchone()[0])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="清空生产账号/团队/业务数据（默认 dry-run）")
    ap.add_argument("--apply", action="store_true", help="真清（需 RESET_CONFIRM=yes）")
    ap.add_argument("--yes", action="store_true", help="与 --apply 同义（便于手工执行）")
    ap.add_argument(
        "--keep-user",
        action="append",
        default=[],
        metavar="EMAIL",
        help="保留该邮箱的 users 行（可多次；也支持环境变量 KEEP_USERS=逗号分隔）",
    )
    args = ap.parse_args(argv)
    apply = bool(args.apply or args.yes)

    keep_emails = [e.strip().lower() for e in (args.keep_user or []) if e.strip()]
    keep_emails += [
        e.strip().lower()
        for e in os.environ.get("KEEP_USERS", "").split(",")
        if e.strip()
    ]
    keep_emails = list(dict.fromkeys(keep_emails))

    if apply and os.environ.get("RESET_CONFIRM") != "yes":
        print("拒绝执行：真清必须同时设置 RESET_CONFIRM=yes（防误触）。")
        return 3

    conn = connect(readonly=not apply)
    try:
        cur = conn.cursor()
        cur.execute("SET statement_timeout = 300000")
        cur.execute("select current_database(), current_user")
        db, user = cur.fetchone()
        cur.execute("select version_num from alembic_version")
        head = cur.fetchone()
        print(f"目标库：database={db} user={user} alembic={head[0] if head else '<none>'}")

        tables = list_tables(cur)
        unknown_keep = sorted(t for t in KEEP_TABLES if t not in tables)
        if unknown_keep:
            print(f"警告：保留表在库中不存在（忽略）：{unknown_keep}")

        business = [t for t in tables if t not in KEEP_TABLES]
        if not business:
            print("没有可清的业务表，退出。")
            return 0

        before_keep = {t: count(cur, t) for t in tables if t in KEEP_TABLES}
        before_business = {t: count(cur, t) for t in business}
        nonzero = {t: c for t, c in before_business.items() if c}
        total_rows = sum(nonzero.values())
        print(
            f"表总数 {len(tables)}：保留 {len(before_keep)} 张，待清 {len(business)} 张；"
            f"待清表中有数据的 {len(nonzero)} 张、共 {total_rows} 行。"
        )
        print("--- 待清（有数据的表）---")
        for t in sorted(nonzero, key=lambda x: (-nonzero[x], x)):
            print(f"  {t}: {nonzero[t]}")

        # 需要保留的 users 行：TRUNCATE 之后原样插回（仅保留白名单里的账号）
        keep_rows: list[dict] = []
        if "users" in business:
            cur.execute("select * from users")
            cols = [d[0] for d in cur.description]
            all_users = [dict(zip(cols, r)) for r in cur.fetchall()]
            by_email = {u["email"].lower(): u for u in all_users}
            missing = [e for e in keep_emails if e not in by_email]
            if missing:
                print(f"拒绝执行：要保留的账号不存在：{missing}")
                return 5
            keep_rows = [by_email[e] for e in keep_emails]
            print("--- 保留的 users（TRUNCATE 后原样插回）---")
            for u in keep_rows:
                print(
                    f"  {u['email']} | {u['account_type']}/{u['role']} | "
                    f"id={u['id']} status={u['status']}"
                )
            keep_set = set(keep_emails)
            print("--- 将被删除的 users ---")
            for u in all_users:
                if u["email"].lower() not in keep_set:
                    print(f"  {u['email']} | {u['account_type']}/{u['role']}")
        if "teams" in before_business:
            cur.execute("select id, name from teams order by id")
            print("--- 将被删除的 teams ---")
            for tid, name in cur.fetchall():
                print(f"  {tid}: {name}")

        if not apply:
            print("\nDRY-RUN：未修改任何数据。确认后加 --apply（并设 RESET_CONFIRM=yes）执行。")
            return 0

        if total_rows == 0:
            print("待清表都没有数据，无需执行。")
            return 0

        print("\n开始 TRUNCATE（单事务，含插回保留账号）...")
        try:
            cur.execute("SET lock_timeout = '20s'")
            sql = (
                "TRUNCATE TABLE "
                + ", ".join(f"public.{qident(t)}" for t in business)
                + " RESTART IDENTITY"
            )
            cur.execute(sql)
            if keep_rows:
                cur.execute(
                    "select column_name from information_schema.columns "
                    "where table_schema='public' and table_name='users' "
                    "order by ordinal_position"
                )
                ucols = [r[0] for r in cur.fetchall()]
                collist = ", ".join(qident(c) for c in ucols)
                placeholders = ", ".join(["%s"] * len(ucols))
                for u in keep_rows:
                    cur.execute(
                        f"INSERT INTO public.users ({collist}) VALUES ({placeholders})",
                        [u[c] for c in ucols],
                    )
                cur.execute("select coalesce(max(id), 1) from users")
                max_id = int(cur.fetchone()[0])
                cur.execute("select setval('users_id_seq', %s, true)", (max_id,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        print("TRUNCATE 已提交。")

        # ── 执行后自检 ──
        bad = 0
        for t in business:
            c = count(cur, t)
            expected = len(keep_rows) if t == "users" else 0
            if c != expected:
                print(f"  [异常] {t} 期望 {expected} 行，实际 {c} 行")
                bad += 1
        if keep_rows:
            cur.execute("select email from users order by email")
            emails = [r[0].lower() for r in cur.fetchall()]
            want = sorted(u["email"].lower() for u in keep_rows)
            if emails != want:
                print(f"  [异常] 保留账号不匹配：{emails} != {want}")
                bad += 1
        for t, expected in before_keep.items():
            c = count(cur, t)
            if c != expected:
                print(f"  [异常] 保留表 {t} 行数变化 {expected} -> {c}")
                bad += 1
        print(
            "自检："
            + (
                "PASS（业务表清零，仅保留白名单账号，保留表行数不变）"
                if bad == 0
                else f"FAIL（{bad} 项异常）"
            )
        )
        return 0 if bad == 0 else 4
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
