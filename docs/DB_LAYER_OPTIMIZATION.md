# 数据库层优化方案（除单运行时外）

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

**短期（已实施）**：方案1（SQL 查询模板共享）—— 零风险，立即消除 SQL 双份维护。

**中期**：方案2（Repository 模式）—— 把数据访问逻辑抽成类，API 层代码完全一致。

**长期**：合并为单运行时（用户已认可是最优解）—— 彻底消除双份维护。

## 已实施

- [x] `backend/kaas_common/db/queries.py`：客户/报价单/订单/询盘 SQL 模板
- [x] `backend/kaas_common/db/repositories.py`：Repository 模式（CustomerRepository/QuoteRepository/OrderRepository/InquiryRepository）
- [ ] orchestrator 接线（SQLAlchemy 适配器 + API 层改用 Repository）
- [ ] worker 接线（asyncpg 适配器 + API 层改用 Repository）

## 关联

- 产品定义配置化：`docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md`
- 方案A 共享 API：`docs/PLAN_A_SHARED_API_PROGRESS.md`
