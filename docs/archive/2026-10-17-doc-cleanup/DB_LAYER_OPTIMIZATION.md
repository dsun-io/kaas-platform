# 数据库层优化方案（除单运行时外）

> ⚠️ **方案 1、2 已于 2026-10-11 退役，代码已删除，不要再接线。**
> 真正的双份维护痛点在「业务规则」与「序列化」，不在 SQL 字符串 ——
> 该问题后来由 `kaas_common/workstation/*` 与 `kaas_common/trade_doc/*`
> 的共享规则解决，并由 `sync-shared.ps1` 镜像进 Worker。
> 详见文末「结局：方案 1、2 已退役」。

## 现状

orchestrator（SQLAlchemy ORM + asyncpg）与 worker（asyncpg 直连 Hyperdrive）
是**两套数据库绑定**，SQL 查询逻辑各自维护，容易漂移。

## 优化方案（除合并为单运行时外）

### 方案1：SQL 查询模板共享（已实施）

**思路**：SQL 语句本身可以共享，只把「绑定方式」留给各端适配。

```python
# backend/kaas_common/db/queries.py —— 共享 SQL 模板
CUSTOMER_BY_ID = """
SELECT *, name AS company_name FROM customers
WHERE id = :customer_id AND tenant_id = :tenant_id
"""

# orchestrator（SQLAlchemy）
await db.execute(text(CUSTOMER_BY_ID), {"tenant_id": t, "customer_id": c})

# worker（asyncpg）
await conn.fetchrow(CUSTOMER_BY_ID.replace(":customer_id", "$1")...)  # 或用命名参数
```

**效果**：改一次 SQL，两端同时生效；SQL 逻辑（JOIN、WHERE、聚合）不再双份维护。

**局限**：asyncpg 用 `$1/$2` 位置参数，SQLAlchemy 用 `:name` 命名参数，需要一层
参数转换（或统一用位置参数）。

### 方案2：Repository 模式（推荐）

**思路**：把「数据访问逻辑」抽成 Repository 类，ORM/SQL 细节藏在内部，API 层只调 Repository。

```python
# backend/kaas_common/db/repositories.py
class CustomerRepository:
    def __init__(self, adapter):
        self._adapter = adapter  # SQLAlchemy 或 asyncpg 适配器

    async def get_by_id(self, tenant_id: str, customer_id: int):
        return await self._adapter.fetch_one(CUSTOMER_BY_ID, {...})

    async def list(self, tenant_id: str, **filters):
        return await self._adapter.fetch_all(CUSTOMER_LIST, {...})
```

**效果**：API 层代码完全一致，只换适配器；测试可用内存适配器 mock。

### 方案3：数据库视图/存储过程

**思路**：把复杂查询逻辑下沉到数据库视图（VIEW）或存储过程，应用层只调视图。

```sql
CREATE VIEW customer_with_stats AS
SELECT c.*, COUNT(i.id) AS inquiry_count
FROM customers c LEFT JOIN cust_inquiries i ON i.customer_id = c.id
GROUP BY c.id;
```

**效果**：查询逻辑只有一份（数据库里），应用层代码简化；但**迁移复杂**（视图变更需迁移），
且调试困难（逻辑分散在应用层和数据库层）。

### 方案4：GraphQL/统一查询层

**思路**：用 GraphQL（如 Strawberry）或统一查询服务，前端只写查询，后端自动生成 SQL。

**效果**：消除 API 层重复；但**引入新技术栈**，学习成本高，不适合当前阶段。

## 推荐

**短期**：~~方案 1（SQL 查询模板共享）~~ → **已退役**（见下）。

**中期**：~~方案 2（Repository 模式）~~ → **已退役**（见下）。

**长期**：合并为单运行时（用户已认可是最优解）—— 彻底消除双份维护。

## 结局：方案 1、2 已退役（2026-10-11）

`backend/kaas_common/db/`（`queries.py` + `repositories.py` + `__init__.py`）**已删除**。

### 为什么是删除，而不是接线

1. **从来没被接线过**：全仓（含测试）零引用 —— 唯一命中是这两个文件自己的
   docstring 示例。`Adapter` 协议在 orchestrator 与 Worker 两侧都**没有实现**，
   Repository 类根本无法构造。
2. **接上去会绕过团队隔离**：模板写死 `WHERE tenant_id = :tenant_id`，
   **完全没有 `team_id` / `owner_id` / `owner_scope` 过滤**；而真实实现是
   `(owner_id = $x OR owner_scope = 'tenant' OR team_id = $y)`。
   它们是 2026-10-11 三层组织（管理员/团队/成员）**之前**写的东西，
   直接接线等于给刚修好的隔离开一个口子。
3. **真正的问题已用更好的方式解决**：共享的是**业务规则与序列化** ——
   `kaas_common/workstation/*`（scope / customer_rules / state_machines /
   amount_rules / teams / `*_serializers`）与 `kaas_common/trade_doc/*`，
   由 `scripts/sync-shared.ps1` 镜像进 Worker。规则只有一份，
   两端各自用擅长的绑定方式执行 —— 这正是方案 2 想要的"只换适配器"效果，
   但不需要共享 SQL 字符串。
4. **参数风格不兼容**：模板用 `:named`（SQLAlchemy），Worker 用 `$1` 位置参数。
   本方案自己就承认"需要一层参数转换（或统一用位置参数）"——
   而那层转换正是"接线"的主要工作量，收益却低于共享规则。

需要时从 git 历史取回：`git show 6645092:backend/kaas_common/db/repositories.py`。

## 已实施

- [x] ~~`queries.py`：客户/报价单/订单/询盘 SQL 模板~~ → **已删除**（未接线 + 缺团队隔离）
- [x] ~~`repositories.py`：Repository 模式~~ → **已删除**（无 Adapter 实现，无法构造）
- [x] ~~orchestrator 接线~~ → **不做**（改由共享规则 + 序列化承担）
- [x] ~~worker 接线~~ → **不做**（同上）

## 关联

- 产品定义配置化：`docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md`
- 方案A 共享 API：`docs/PLAN_A_SHARED_API_PROGRESS.md`
