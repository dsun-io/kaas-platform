# QA 测试账号（生产持久化）· 设计与使用

> 用于**生产环境黑盒测试**的专用测试账号。账号长期落库、可复用，
> 但**权限收敛到"用户权限"、数据隔离在专用租户**，不碰真实用户与系统配置。

---

## 1. 为什么需要专用测试账号

- 单证工位 / 公章等新功能要在**生产**验证（不在本地起库，见 §5）。
- 现有 `scripts/seed_dev.py` **拒绝在生产运行**（它是开发种子），无法满足"在生产落测试账号"。
- `POST /api/v1/auth/register` 只能建 `customer` 账号，测不了需要 `internal` 的单证/公章。

因此新增 `scripts/seed_qa.py`：**允许在生产**幂等创建一套 QA 专用账号。

---

## 2. 账号清单

| 邮箱 | account_type / role | 权限 | 用途 |
|---|---|---|---|
| `qa_user@qa.kaas.internal` | `internal` / `user` | **用户权限**（`is_admin()`=false） | 正向测单证工位、公章上传/管理 |
| `qa_customer@qa.kaas.internal` | `customer` / `owner` | 买家 | **越权对照**：验证 customer 碰不到公章/单证/内部接口 |

- **QA 租户**：`customers.code = qa_smoke`，`tenant_id = qa-smoke-0000-0000-0000-000000000001`
- 所有数据隔离在该租户下，与真实租户（如 `lianjia`）互不可见。

### 权限边界（重要）

- `qa_user` 是 **用户权限**：`effective_role != system_admin`，因此**不能**做管理员操作
  （改 AI Provider、设全局配置、bootstrap 等），只能用普通用户能用的功能。
- 单证/公章判断的是 `is_internal()`（看 `account_type`），`qa_user` 满足；`qa_customer` 不满足 → 用于验证越权被拒。

---

## 3. 落库方式

```bash
# 非生产直接跑
python scripts/seed_qa.py

# 生产：显式确认 + 指定密码（密码不给则随机生成并一次性打印）
QA_SEED_CONFIRM=yes QA_PASSWORD='<强密码>' \
  DATABASE_URL='<生产 DSN>' python scripts/seed_qa.py
```

**落库目标表**（幂等 upsert，可重复执行）：

| 表 | 写入 |
|---|---|
| `customers` | QA 租户 `qa_smoke` |
| `users` | `qa_user`、`qa_customer` |
| `user_customers` | `qa_customer` → `qa_smoke` 绑定 |

**安全护栏**：

1. 只操作 `qa_*` 邮箱 + `qa_smoke` 租户；若发现 `qa_smoke` 的 tenant_id 不符会**中止**，防误伤。
2. 生产运行需 `QA_SEED_CONFIRM=yes` 显式确认。
3. 密码来自 `QA_PASSWORD`；缺省随机生成并**仅打印一次**。落库为 **bcrypt 哈希**，明文不入库。
4. **不碰系统配置**：AI Provider、企业抬头、税务档案、全局开关一律不写。

---

## 4. 用途：生产黑盒测试 + 越权审计

> ⚠ **绝不能把 pytest 连到生产库**——`tests/conftest.py` 的 db fixture 会
> `TRUNCATE` + 跑迁移 + 灌种子，会破坏生产数据。生产验证一律走 **HTTP 黑盒**。

用 `qa_user` / `qa_customer` 登录拿 JWT，调用真实 API 验证功能与越权。

### 越权审计清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | `qa_customer` 上传/读取公章 | `403 INTERNAL_ONLY` |
| 2 | `qa_user` 读**别家租户**的公章/单证 | `404`（不泄露存在性） |
| 3 | `qa_customer` 创建/确认/导出单证 | `403/404` |
| 4 | `qa_user` 调 admin 专属接口 | `403` |
| 5 | `qa_user` 列表只见 `qa_smoke` 数据，不见真实租户 | 通过 |
| 6 | 无 token / 伪造 token 访问任一接口 | `401` |
| 7 | `qa_user` 修改系统配置（AI Provider 等） | `403` |

> **逐条代码级结论（2026-10-21 审计）**：见 [`QA_AUTHZ_AUDIT_2026-10-21.md`](./QA_AUTHZ_AUDIT_2026-10-21.md)
> —— 7 条＝**已有闸门 3 条**（4/5/6）、**闸门缺失（风险）4 条**（1 读侧 / 2 / 3 / 7），高风险 3 条。
> 该文 §0 另列三处前提漂移（`scripts/seed_qa.py` 不在仓库、单租户常量 `default` 非 `qa_smoke` 独立租户、
> 公章写闸门实际是 `403 TEAM_ADMIN_REQUIRED` 而非 `INTERNAL_ONLY`）——真机执行前先按 §0/§3 核对账号。

---

## 5. 与既有机制的关系

| 机制 | 用途 | 生产可用 | 说明 |
|---|---|---|---|
| `seed_dev.py` | 开发种子数据 | ❌ 拒绝 | 开发/预发灌样例数据 |
| `seed_qa.py` | **生产 QA 账号** | ✅ | 本文件；幂等、隔离、用户权限 |
| Alembic 迁移 | schema 演进 | ✅ | 不放账号（密码哈希不进迁移） |

---

## 6. 维护

- **忘记密码**：重跑 `seed_qa.py` 并指定 `QA_PASSWORD` 即可重置（幂等）。
- **下线**：删除 `qa_*` 用户与 `qa_smoke` 租户即可；因隔离在独立租户，不影响他人。
- **改用途/字段**：编辑 `scripts/seed_qa.py` 的 `QA_USERS`，保持 `qa_` 邮箱前缀不变。
