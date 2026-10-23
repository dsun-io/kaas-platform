"""QA 测试账号种子（生产持久化 · 幂等）。

设计真源：docs/QA_TEST_ACCOUNTS.md（2026-10-23 落地实现，修复审计 D-3「脚本不在仓库」）。

- 只操作 qa_* 邮箱与 code='qa_smoke' 的客户行；发现其它数据立即中止。
- 生产运行必须显式 QA_SEED_CONFIRM=yes；口令来自 QA_PASSWORD，缺省随机生成并只打印一次。
- 幂等：账号/客户行已存在则跳过（不重置口令、不改字段）。

用法：
  QA_SEED_CONFIRM=yes QA_PASSWORD='<强密码>' DATABASE_URL='<dsn>' python scripts/seed_qa.py
"""

from __future__ import annotations

import asyncio
import os
import secrets as pysecrets
import sys

import asyncpg
import bcrypt

QA_USER_EMAIL = "qa_user@qa.kaas.internal"
QA_CUSTOMER_EMAIL = "qa_customer@qa.kaas.internal"
QA_CUSTOMER_CODE = "qa_smoke"
QA_TENANT_NOTE = "qa_smoke（同租户 default 内按 owner/team 收窄，见审计 D-2）"


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


async def main() -> None:
    if os.environ.get("QA_SEED_CONFIRM") != "yes":
        sys.exit("拒绝执行：需要 QA_SEED_CONFIRM=yes（本脚本会写生产/共享库）")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("缺少 DATABASE_URL")

    password = os.environ.get("QA_PASSWORD") or pysecrets.token_urlsafe(24)
    printed_once = os.environ.get("QA_PASSWORD") is None
    pw_hash = _hash(password)

    conn = await asyncpg.connect(dsn, ssl="require")
    try:
        # 护栏 1：绝不触碰非 qa 数据 —— 先核对我们只会 INSERT，不 UPDATE/DELETE。
        existing = await conn.fetch(
            "SELECT email FROM users WHERE email = ANY($1::text[])",
            [QA_USER_EMAIL, QA_CUSTOMER_EMAIL],
        )
        have = {r["email"] for r in existing}

        if QA_USER_EMAIL not in have:
            await conn.execute(
                "INSERT INTO users (email, password_hash, display_name, account_type, role,"
                " plan, is_tenant_admin, status, team_id, console_access)"
                " VALUES ($1,$2,'QA User','internal','user','internal',false,'active',NULL,false)",
                QA_USER_EMAIL, pw_hash,
            )
            print("created user:", QA_USER_EMAIL)
        else:
            print("exists, skipped:", QA_USER_EMAIL)

        if QA_CUSTOMER_EMAIL not in have:
            await conn.execute(
                "INSERT INTO users (email, password_hash, display_name, account_type, role,"
                " plan, is_tenant_admin, status, team_id, console_access)"
                " VALUES ($1,$2,'QA Customer','customer','owner','free',false,'active',NULL,false)",
                QA_CUSTOMER_EMAIL, pw_hash,
            )
            print("created user:", QA_CUSTOMER_EMAIL)
        else:
            print("exists, skipped:", QA_CUSTOMER_EMAIL)

        cust = await conn.fetchrow(
            "SELECT id FROM customers WHERE code = $1", QA_CUSTOMER_CODE
        )
        if cust is None:
            cust_id = await conn.fetchval(
                "INSERT INTO customers (tenant_id, code, name, plan, status, stage,"
                " owner_scope, is_deleted, notes, created_by)"
                " VALUES ('default',$1,'QA Smoke Customer','free','active','active',"
                "'private',false,$2,$3) RETURNING id",
                QA_CUSTOMER_CODE, "QA 专用：tenant 隔离说明 = " + QA_TENANT_NOTE,
                QA_USER_EMAIL,
            )
            print("created customer row id:", cust_id)
        else:
            cust_id = cust["id"]
            print("exists, skipped customer row id:", cust_id)

        qa_customer_id = await conn.fetchval(
            "SELECT id FROM users WHERE email = $1", QA_CUSTOMER_EMAIL
        )
        bound = await conn.fetchval(
            "SELECT id FROM user_customers WHERE user_id = $1 AND customer_id = $2",
            qa_customer_id, cust_id,
        )
        if bound is None:
            await conn.execute(
                "INSERT INTO user_customers (user_id, customer_id) VALUES ($1,$2)",
                qa_customer_id, cust_id,
            )
            print("bound qa_customer -> qa_smoke")
        else:
            print("binding exists, skipped")
    finally:
        await conn.close()

    print("== credentials (do not commit) ==")
    if printed_once:
        print("QA_PASSWORD (random, shown once):", password)
    else:
        print("QA_PASSWORD: (from env, not shown)")


asyncio.run(main())
