"""QA 测试账号落库脚本（seed_qa）—— 生产可用的持久化测试账号。

为什么单独一个脚本（而不是 seed_dev.py / Alembic 迁移）
------------------------------------------------------
- seed_dev.py **拒绝在生产运行**（开发种子），而本脚本的目标恰恰是「在生产落一个
  专用测试账号」长期复用，两者职责相反，不能共用。
- 不用 Alembic 迁移：密码是 bcrypt 哈希，不适合固化进迁移；且账号被误删后，
  seed 可重复执行幂等修复，迁移是单向的。

设计要点
--------
- **专用 QA 租户** `qa_smoke`：所有数据隔离在自己的 tenant，天然不碰真实用户
  （lianjia 等）与系统配置（AI providers / 企业抬头 / 税务档案一律不动）。
- **用户权限账号** `qa_user`（internal + role=user）：能用单证/公章工位，
  但**不是管理员**（effective_role != system_admin），验证的是「普通用户」视角。
- **越权对照账号** `qa_customer`（customer + owner）：买家账号，用来做越权审计，
  验证 customer 碰不到公章/单证/内部接口。
- **幂等 upsert**：查无则建、查有则刷新密码与绑定，可重复执行。
- **安全护栏**：只操作 `qa_*` 标识的记录；生产运行需显式 `QA_SEED_CONFIRM=yes`。

用法
----
    # 非生产（开发/预发）直接跑
    python scripts/seed_qa.py

    # 生产：显式确认 + 指定测试密码（不给则随机生成并一次性打印）
    QA_SEED_CONFIRM=yes QA_PASSWORD='<强密码>' \
        DATABASE_URL='<生产 DSN>' python scripts/seed_qa.py

密码默认从 QA_PASSWORD 读取；缺省则随机生成并**仅打印一次**（请立即存入密钥管理，
脚本不会再次显示）。落库的是 bcrypt 哈希，明文不入库。
"""
from __future__ import annotations

import asyncio
import os
import secrets
import sys
import uuid

# 允许 `python scripts/seed_qa.py` 直接运行（补 orchestrator 根到 sys.path）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text  # noqa: E402

from app.config.settings import settings  # noqa: E402
from app.core.auth import hash_password  # noqa: E402
from app.db.session import async_session_factory  # noqa: E402

# ─── QA 标识（脚本只碰这些记录，绝不越界）──────────────────────────────────
QA_TENANT_ID = "qa-smoke-0000-0000-0000-000000000001"   # 固定 UUID，保证可重入
QA_CUSTOMER_CODE = "qa_smoke"
QA_EMAIL_DOMAIN = "qa.kaas.internal"

# 三个账号的定义（email 前缀 qa_ 是脚本的「作用域标记」，勿改）
QA_USERS = [
    {
        "email": f"qa_user@{QA_EMAIL_DOMAIN}",
        "display_name": "QA 冒烟测试（用户权限）",
        "account_type": "internal",
        "role": "user",          # ← 用户权限：非管理员，测单证/公章正向流程
        "plan": "internal",
        "purpose": "正向测试单证工位 + 公章上传/管理（用户权限，非 admin）",
    },
    {
        "email": f"qa_customer@{QA_EMAIL_DOMAIN}",
        "display_name": "QA 越权对照（买家）",
        "account_type": "customer",
        "role": "owner",
        "plan": "free",
        "purpose": "越权审计对照：验证 customer 不能访问公章/单证/内部接口",
    },
]


def _require_confirm() -> None:
    """生产环境护栏：必须显式 QA_SEED_CONFIRM=yes 才执行。"""
    is_prod = (settings.app_env or "").lower() == "production"
    if is_prod and os.environ.get("QA_SEED_CONFIRM") != "yes":
        print("ERROR: 检测到生产环境。请显式设置 QA_SEED_CONFIRM=yes 以确认创建 QA 测试账号。")
        print("       （此脚本只写 qa_* 记录 + qa_smoke 租户，不碰真实用户与系统配置）")
        sys.exit(1)


def _resolve_password() -> tuple[str, bool]:
    """取测试密码：优先 QA_PASSWORD，缺省随机生成。返回 (明文, 是否新生成)。"""
    pw = os.environ.get("QA_PASSWORD", "").strip()
    if pw:
        if len(pw) < 8:
            print("ERROR: QA_PASSWORD 至少 8 位。")
            sys.exit(1)
        return pw, False
    return secrets.token_urlsafe(12), True


async def seed(password: str) -> None:
    """幂等落库 —— 用原生 SQL 只操作生产库实际存在的列。

    为什么不用 ORM：生产库 schema 与 orchestrator ORM 存在 drift
    （如 customers.country 列在生产库不存在），ORM 全列映射会抛
    UndefinedColumnError。原生 SQL 只碰实际存在的列，最稳。
    生产实际列：customers(tenant_id,code,name,plan,status) /
    users(email,password_hash,display_name,account_type,role,plan,is_tenant_admin,status) /
    user_customers(user_id,customer_id)。
    """
    s = async_session_factory()
    try:
        pwd_hash = hash_password(password)

        # ── 1. QA 租户（customers）── 幂等 ─────────────────────────────
        r = await s.execute(
            text("SELECT id, tenant_id FROM customers WHERE code = :c"),
            {"c": QA_CUSTOMER_CODE},
        )
        row = r.first()
        if row is None:
            await s.execute(
                text("INSERT INTO customers (tenant_id, code, name, plan, status) "
                     "VALUES (:t, :c, :n, :p, 'active')"),
                {"t": QA_TENANT_ID, "c": QA_CUSTOMER_CODE,
                 "n": "QA 冒烟测试（勿删）", "p": "free"},
            )
            row = (await s.execute(
                text("SELECT id FROM customers WHERE code = :c"),
                {"c": QA_CUSTOMER_CODE},
            )).first()
            print(f"  [qa] 创建 QA 租户: {QA_CUSTOMER_CODE} (id={row[0]})")
        else:
            if row[1] != QA_TENANT_ID:
                print(f"ERROR: code=qa_smoke 租户 tenant_id={row[1]} 与预期不符，中止防误伤。")
                sys.exit(1)
            print(f"  [qa] QA 租户已存在: {QA_CUSTOMER_CODE} (id={row[0]})")
        cust_id = row[0]

        # ── 2. QA 账号（users）── 幂等 upsert ─────────────────────────
        user_ids: dict[str, int] = {}
        for u in QA_USERS:
            r = await s.execute(
                text("SELECT id FROM users WHERE email = :e"), {"e": u["email"]})
            row = r.first()
            if row is None:
                await s.execute(
                    text("INSERT INTO users (email, password_hash, display_name, "
                         "account_type, role, plan, is_tenant_admin, status) "
                         "VALUES (:e, :p, :d, :at, :r, :pl, false, 'active')"),
                    {"e": u["email"], "p": pwd_hash, "d": u["display_name"],
                     "at": u["account_type"], "r": u["role"], "pl": u["plan"]},
                )
                row = (await s.execute(
                    text("SELECT id FROM users WHERE email = :e"), {"e": u["email"]}
                )).first()
                print(f"  [qa] 创建账号: {u['email']} ({u['account_type']}/{u['role']}, id={row[0]})")
            else:
                await s.execute(
                    text("UPDATE users SET password_hash=:p, display_name=:d, "
                         "account_type=:at, role=:r, plan=:pl WHERE id=:id"),
                    {"p": pwd_hash, "d": u["display_name"], "at": u["account_type"],
                     "r": u["role"], "pl": u["plan"], "id": row[0]},
                )
                print(f"  [qa] 更新账号: {u['email']} ({u['account_type']}/{u['role']}, id={row[0]})")
            user_ids[u["email"]] = row[0]

        # ── 3. 绑定（user_customers）── 幂等 ─────────────────────────
        for u in QA_USERS:
            if u["account_type"] != "customer":
                continue
            uid = user_ids[u["email"]]
            r = await s.execute(
                text("SELECT id FROM user_customers WHERE user_id=:u AND customer_id=:c"),
                {"u": uid, "c": cust_id},
            )
            if r.first() is None:
                await s.execute(
                    text("INSERT INTO user_customers (user_id, customer_id) VALUES (:u, :c)"),
                    {"u": uid, "c": cust_id},
                )
                print(f"  [qa] 绑定: {u['email']} → {QA_CUSTOMER_CODE}")

        await s.commit()
    except Exception:
        await s.rollback()
        raise
    finally:
        await s.close()


def main() -> None:
    _require_confirm()
    password, generated = _resolve_password()

    print("=" * 72)
    print("QA 测试账号落库（seed_qa）")
    print(f"  环境: {settings.app_env}    QA 租户: {QA_CUSTOMER_CODE} ({QA_TENANT_ID})")
    print("=" * 72)

    asyncio.run(seed(password))

    print("-" * 72)
    print("账号清单：")
    for u in QA_USERS:
        print(f"  · {u['email']}")
        print(f"      权限: {u['account_type']}/{u['role']}   用途: {u['purpose']}")
    print("-" * 72)
    if generated:
        print("⚠ 密码为本次随机生成（仅显示这一次，请立即存入密钥管理）：")
        print(f"    {password}")
    else:
        print("密码：来自 QA_PASSWORD 环境变量（已落库为 bcrypt 哈希，明文不入库）。")
    print("完成。账号已持久化到数据库，可反复用于生产黑盒测试。")


if __name__ == "__main__":
    main()
