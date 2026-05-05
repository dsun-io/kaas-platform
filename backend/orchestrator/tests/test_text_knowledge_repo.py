"""
Kaas v2 · TextKnowledge Repository 测试
─────────────────────────────────────

覆盖:
  - 创建/查询/检索
  - tenant/customer/scope 隔离
  - 组合检索 (keywords / tags / ILIKE / FTS)
"""
import pytest
pytestmark = pytest.mark.unit

from app.repositories.text_knowledge_repo import (
    create_text_knowledge,
    search_text_knowledge,
    get_text_knowledge_by_id,
    list_text_knowledge,
    soft_delete_text_knowledge,
)


class TestCreateAndQuery:
    """基础创建和查询。"""

    async def test_create_text_knowledge(self, db_session):
        entry = await create_text_knowledge(
            session=db_session,
            tenant_id="lianjia",
            knowledge_type="faq",
            title="牛栏网使用寿命",
            content="牛栏网一般可用 8-10 年",
            scope="tenant",
            keywords=["牛栏网", "寿命"],
        )
        assert entry.id is not None
        assert entry.tenant_id == "lianjia"
        assert entry.status == "active"

    async def test_get_by_id(self, db_session):
        entry = await create_text_knowledge(
            session=db_session,
            tenant_id="lianjia",
            knowledge_type="faq",
            title="测试",
            content="测试内容",
        )
        found = await get_text_knowledge_by_id(db_session, entry.id)
        assert found is not None
        assert found.title == "测试"

    async def test_soft_delete(self, db_session):
        entry = await create_text_knowledge(
            session=db_session,
            tenant_id="lianjia",
            knowledge_type="faq",
            title="将被删除",
            content="内容",
        )
        ok = await soft_delete_text_knowledge(db_session, entry.id)
        assert ok is True
        # 软删除后，search 不应返回该条目
        results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="将被删除",
        )
        assert all(r.id != entry.id for r in results)


class TestTenantIsolation:
    """租户/客户隔离测试。"""

    async def test_tenant_isolation(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="tenant_a",
            knowledge_type="faq", title="A的知识", content="A的内容",
            scope="tenant",
        )
        await create_text_knowledge(
            session=db_session, tenant_id="tenant_b",
            knowledge_type="faq", title="B的知识", content="B的内容",
            scope="tenant",
        )

        a_results = await search_text_knowledge(
            session=db_session, tenant_id="tenant_a",
            query_text="知识",
        )
        # tenant_a 只能查到自己的
        for r in a_results:
            assert r.tenant_id == "tenant_a"

    async def test_customer_scope_isolation(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia", customer_id="cust_a",
            knowledge_type="faq", title="客户A专属", content="机密",
            scope="customer",
        )
        # 用 customer_id=cust_a 可以查到
        results_a = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="客户A专属", customer_id="cust_a",
        )
        assert len(results_a) > 0

        # 用 customer_id=cust_b 不能查到 cust_a 的知识
        results_b = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="客户A专属", customer_id="cust_b",
        )
        assert len(results_b) == 0


class TestRetrieval:
    """检索测试。"""

    async def test_keywords_match_priority(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="faq",
            title="牛栏网寿命",
            content="牛栏网一般可用 8-10 年",
            keywords=["牛栏网", "寿命", "几年"],
        )
        results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="牛栏网 寿命 几年",
            limit=5,
        )
        assert len(results) > 0
        assert "牛栏网" in results[0].title

    async def test_title_ilike_fallback(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="faq",
            title="牛栏网能用几年",
            content="牛栏网可用 8-10 年",
        )
        results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="能用几年",
            limit=5,
        )
        assert len(results) > 0

    async def test_content_ilike_fallback(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="faq",
            title="关于牛栏网",
            content="牛栏网一般可用 8-10 年，热镀锌可达 10-15 年",
        )
        results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="热镀锌可达",
            limit=5,
        )
        assert len(results) > 0

    async def test_knowledge_type_filter(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="faq", title="FAQ问题", content="FAQ答案",
        )
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="script_template", title="话术模板", content="话术内容",
        )

        faq_results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="FAQ", knowledge_types=["faq"],
        )
        assert all(r.knowledge_type == "faq" for r in faq_results)

    async def test_product_category_filter(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            product_category="牛栏网",
            knowledge_type="faq", title="牛栏网FAQ", content="牛栏网内容",
        )
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            product_category="石笼网",
            knowledge_type="faq", title="石笼网FAQ", content="石笼网内容",
        )

        nlw_results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="FAQ", product_category="牛栏网",
        )
        for r in nlw_results:
            if r.product_category is not None:
                assert r.product_category == "牛栏网"

    async def test_global_scope_is_visible(self, db_session):
        await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="faq", title="全球知识", content="所有租户可见",
            scope="global",
        )
        results = await search_text_knowledge(
            session=db_session, tenant_id="some_other_tenant",
            query_text="全球知识",
        )
        assert len(results) > 0

    async def test_limit_respected(self, db_session):
        for i in range(5):
            await create_text_knowledge(
                session=db_session, tenant_id="lianjia",
                knowledge_type="faq",
                title=f"限流测试{i}", content=f"内容{i}",
            )
        results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="限流测试", limit=2,
        )
        assert len(results) <= 2

    async def test_inactive_not_returned(self, db_session):
        entry = await create_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="faq", title="已禁用", content="内容",
            status="disabled",
        )
        results = await search_text_knowledge(
            session=db_session, tenant_id="lianjia",
            query_text="已禁用",
        )
        assert all(r.id != entry.id for r in results)

    async def test_list_with_pagination(self, db_session):
        for i in range(5):
            await create_text_knowledge(
                session=db_session, tenant_id="lianjia",
                knowledge_type="faq", title=f"分页{i}", content=f"内容{i}",
            )
        items, total = await list_text_knowledge(
            session=db_session, tenant_id="lianjia",
            knowledge_type="faq", limit=2, offset=0,
        )
        assert len(items) <= 2
        assert total >= 5
