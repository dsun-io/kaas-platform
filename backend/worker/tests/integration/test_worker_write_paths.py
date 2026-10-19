"""worker 写入路径 · 真 Postgres 端到端测试（task-8 / 路线 C 子集）。

覆盖面：注册、初始化系统管理员、客户创建/软删除、手动报价保存 —— 全是 INSERT/UPDATE。
这些路径用假 DB 只能验证"SQL 文本"，验证不了"schema 真的接受它"。

本文件打的每个 bug 都在线上真实发生过（orchestrator 侧 ORM 有 default、DDL 没有）：

- `users.is_tenant_admin`：NOT NULL 且无 server_default，注册 INSERT 必须显式写；
- `customers.plan` / `customers.status`：NOT NULL 且无 server_default（2026-10-17 创建客户 500）；
- `quotations.schema_version`：NOT NULL 且无 server_default（2026-10-19 手动报价 500）。

运行方式见同目录 `README.md`。无 PG 环境时整个文件 skip（conftest 判定）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration

_PASSWORD = "Passw0rd!"
_ADMIN_EMAIL = "root@integration.test"


# ── helpers ──────────────────────────────────────────────────────────────────


def _bootstrap_admin(client, setup_token: str) -> dict:
    """初始化系统管理员，返回响应体（扁平：access_token / user_id，与 orchestrator 同键集）。"""
    resp = client.post(
        "/api/v1/auth/bootstrap-admin",
        json={
            "email": _ADMIN_EMAIL,
            "password": _PASSWORD,
            "display_name": "集成测试系统管理员",
        },
        headers={"Authorization": f"Bearer {setup_token}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _register(client, **overrides):
    payload = {
        "email": "buyer@integration.test",
        "password": _PASSWORD,
        "display_name": "集成测试买家",
        "product_category": "fencing",
        "team_name": "集成测试团队",
    }
    payload.update(overrides)
    return client.post("/api/v1/auth/register", json=payload)


# ── 1. bootstrap-admin 写入 ──────────────────────────────────────────────────


def test_bootstrap_admin_writes_internal_system_admin(client, db, admin_setup_token):
    body = _bootstrap_admin(client, admin_setup_token)
    user_id = body["user_id"]

    row = db.fetchrow(
        "SELECT id, email, password_hash, account_type, role, plan, status,"
        " is_tenant_admin, console_access FROM users WHERE email=$1",
        _ADMIN_EMAIL,
    )
    assert row is not None, "bootstrap-admin 返回 200 但 users 表没有落库"
    assert row["id"] == user_id
    assert row["account_type"] == "internal"
    assert row["role"] == "system_admin"
    assert row["plan"] == "internal"
    assert row["status"] == "active"
    # 关键：显式列，不能靠 DDL 默认值（users.is_tenant_admin 无 server_default）。
    assert row["is_tenant_admin"] is False
    assert row["console_access"] is False
    assert row["password_hash"] != _PASSWORD
    assert row["password_hash"].startswith("$2"), "密码必须 bcrypt 哈希后落库"

    # token 能过真实鉴权链路（JWT_SECRET → users 查询）。
    me = client.get("/api/v1/auth/me", headers=_auth(body["access_token"]))
    assert me.status_code == 200, me.text
    assert me.json()["user_id"] == user_id

    # 已初始化后再次 bootstrap 必须 403（existing 查询分支）。
    again = client.post(
        "/api/v1/auth/bootstrap-admin",
        json={"email": "root2@integration.test", "password": _PASSWORD, "display_name": "第二"},
        headers={"Authorization": f"Bearer {admin_setup_token}"},
    )
    assert again.status_code == 403
    assert db.fetchval("SELECT count(*) FROM users") == 1


# ── 2. 注册写入（用户 + 团队 + 工位订阅）─────────────────────────────────────


def test_register_writes_user_team_and_subscriptions(client, db):
    resp = _register(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    user = db.fetchrow(
        "SELECT id, email, account_type, role, plan, status, is_tenant_admin, team_id"
        " FROM users WHERE email=$1",
        "buyer@integration.test",
    )
    assert user is not None, "注册返回 200 但 users 表没有落库"
    assert user["account_type"] == "customer"
    assert user["role"] == "owner"                  # 建团队者 = 团队管理员
    assert user["plan"] == "free"
    assert user["status"] == "active"
    assert user["is_tenant_admin"] is False         # 显式列（生产注册 500 的关键列）
    assert user["team_id"] is not None
    assert body["user_id"] == user["id"]

    team = db.fetchrow(
        "SELECT id, tenant_id, name, created_by FROM teams WHERE id=$1", user["team_id"]
    )
    assert team is not None, "注册建了 team_id 但 teams 表没有对应行"
    assert team["tenant_id"] == "default"
    assert team["name"] == "集成测试团队"
    assert team["created_by"] == user["id"]

    # 注册时开通的工位订阅（team_subscriptions 是 INSERT ... ON CONFLICT 写入路径）。
    subs = db.fetch(
        "SELECT code, active, source FROM team_subscriptions WHERE team_id=$1",
        team["id"],
    )
    assert len(subs) >= 1, "注册带 team_name 时应至少开通一个默认工位"
    assert all(s["active"] for s in subs)
    assert all(s["source"] == "signup" for s in subs)

    # 2026-10-19 口径：注册只建团队，不再顺手建 customers 行。
    assert db.fetchval("SELECT count(*) FROM customers") == 0

    # 注册返回的 token 可用，且 /me 能解析出团队名（真实 JOIN）。
    me = client.get("/api/v1/auth/me", headers=_auth(body["access_token"]))
    assert me.status_code == 200, me.text
    assert me.json()["team_name"] == "集成测试团队"


# ── 3. 注册事务整体回滚（重复邮箱不产生孤儿团队）──────────────────────────────


def test_register_duplicate_email_rolls_back_without_orphan_team(client, db):
    first = _register(client)
    assert first.status_code == 200, first.text

    duplicate = _register(client, team_name="不该被创建的团队")
    assert duplicate.status_code == 409, duplicate.text

    assert db.fetchval(
        "SELECT count(*) FROM users WHERE email=$1", "buyer@integration.test"
    ) == 1
    # 邮箱查重发生在预检阶段（团队真正创建之前）；顺序被改坏会留下孤儿团队。
    assert db.fetchval("SELECT count(*) FROM teams") == 1
    assert db.fetchval(
        "SELECT count(*) FROM teams WHERE name=$1", "不该被创建的团队"
    ) == 0


# ── 4. 客户创建 + 软删除（customers INSERT/UPDATE）────────────────────────────

_CUSTOMER_PAYLOAD = {
    "company_name": "集成测试贸易有限公司",
    "contact_name": "张三",
    "contact_phone": "13800000000",
    "country": "CN",
}


def test_create_customer_writes_not_null_columns_then_soft_deletes(
    client, db, admin_setup_token
):
    admin = _bootstrap_admin(client, admin_setup_token)
    auth = _auth(admin["access_token"])

    resp = client.post("/api/v1/customers", json=_CUSTOMER_PAYLOAD, headers=auth)
    assert resp.status_code == 201, resp.text
    customer_id = resp.json()["id"]

    row = db.fetchrow(
        "SELECT id, tenant_id, name, plan, status, stage, owner_scope, owner_id,"
        " is_deleted, deleted_at FROM customers WHERE id=$1",
        customer_id,
    )
    assert row is not None, "创建客户返回 201 但 customers 表没有落库"
    assert row["tenant_id"] == "default"
    assert row["name"] == "集成测试贸易有限公司"
    # 下面两列是 2026-10-17 线上 500 的根因：
    # customers.plan / status NOT NULL 且没有 server_default，裸 SQL 必须显式写。
    assert row["plan"] == "free"
    assert row["status"] == "active"
    assert row["stage"] == "active"
    assert row["owner_scope"] == "private"
    assert row["owner_id"] == str(admin["user_id"])
    assert row["is_deleted"] is False
    assert row["deleted_at"] is None

    contact = db.fetchrow(
        "SELECT name, phone, is_primary FROM cust_contacts WHERE customer_id=$1",
        customer_id,
    )
    assert contact is not None, "带 contact_name 时必须落一条主联系人"
    assert contact["name"] == "张三"
    assert contact["phone"] == "13800000000"
    assert contact["is_primary"] is True

    # 软删除：UPDATE customers SET is_deleted/deleted_at，不是物理删除。
    deleted = client.delete(f"/api/v1/customers/{customer_id}", headers=auth)
    assert deleted.status_code == 204, deleted.text
    row = db.fetchrow(
        "SELECT is_deleted, deleted_at FROM customers WHERE id=$1", customer_id
    )
    assert row["is_deleted"] is True
    assert row["deleted_at"] is not None
    # 行还在（历史单据引用保留）。
    assert db.fetchval("SELECT count(*) FROM customers") == 1
    # 软删后按 id 取不可见（404）。
    assert client.get(f"/api/v1/customers/{customer_id}", headers=auth).status_code == 404


# ── 5. 手动报价保存（quotations INSERT）───────────────────────────────────────


def test_create_quotation_writes_schema_version_not_null(client, db, admin_setup_token):
    admin = _bootstrap_admin(client, admin_setup_token)

    resp = client.post(
        "/api/v1/quotations",
        json={
            "customer_id": "cust-integration-001",
            "product_category": "fencing",
            "product_spec": {"height_m": 2.0, "material": "galvanized"},
            "quantity": 100,
            "unit_price": 12.5,
            "currency": "CNY",
            "unit": "meter",
            "notes": "集成测试报价",
        },
        headers=_auth(admin["access_token"]),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()

    row = db.fetchrow(
        "SELECT schema_version, tenant_id, customer_id, product_category,"
        " spec_hash, unit_price, created_by FROM quotations WHERE id=$1",
        int(body["id"]),
    )
    assert row is not None, "报价保存返回 201 但 quotations 表没有落库"
    # schema_version NOT NULL 且无 server_default（2026-10-19 线上 500 的根因）。
    assert row["schema_version"] == 1
    assert row["tenant_id"] == "default"
    assert row["customer_id"] == "cust-integration-001"
    assert row["product_category"] == "fencing"
    assert row["spec_hash"] == body["spec_hash"]
    assert float(row["unit_price"]) == 12.5
    assert row["created_by"] == str(admin["user_id"])
