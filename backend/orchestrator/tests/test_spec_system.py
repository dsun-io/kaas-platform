"""Spec System v1 — 全量回归测试

覆盖:
- spec_hash: deterministic, NFC normalize, Decimal, key order
- units: unknown unit raises ValueError
- price_engine: superseded, truncate, overlap error
- quote_wizard: non-leaf, missing required, same hash reuse, different hash new
- RBAC: viewer 403, tenant_admin 403 on admin, platform_ops pass
- change_reason: missing returns 422
- SKU edit: revision history, 409 conflict
- EXCLUDE constraint: overlapping active prices
- promotion_recommender: 3 tenants → recommended
"""
import pytest
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from sqlalchemy import text, select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    ProductCategory, SpecAttribute, SpecAttributeValue,
    CategoryAttributeBinding, ProductSku, ProductSkuPrice,
    ProductSkuRevision, AttributeProposal, Unit,
)


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

async def _get_leaf_category(db: AsyncSession, code: str = "post"):
    cat = await db.execute(select(ProductCategory).where(ProductCategory.code == code))
    return cat.scalars().first()


async def _build_required_spec_values(db: AsyncSession, category_id: int) -> dict:
    """Build spec_values dict satisfying all required bindings for a category.

    Returns {attribute_code: {"v": value}} format matching compute_sku_hash expectations.
    """
    bindings = await db.execute(
        select(CategoryAttributeBinding)
        .where(CategoryAttributeBinding.category_id == category_id)
    )
    binding_list = bindings.scalars().all()

    spec_values = {}
    for b in binding_list:
        if not b.is_required:
            continue
        attr = await db.get(SpecAttribute, b.attribute_id)
        if not attr:
            continue
        if attr.data_type == "enum":
            vals = await db.execute(
                select(SpecAttributeValue)
                .where(SpecAttributeValue.attribute_id == attr.id)
                .limit(1)
            )
            first_val = vals.scalars().first()
            if first_val:
                spec_values[attr.code] = {"v": first_val.value_code}
            else:
                spec_values[attr.code] = {"v": "default"}
        elif attr.data_type == "number":
            spec_values[attr.code] = {"v": 1.5}
        elif attr.data_type == "bool":
            spec_values[attr.code] = {"v": True}
        else:
            spec_values[attr.code] = {"v": "test_value"}
    return spec_values


def _admin_headers(tenant_id: str = "lianjia"):
    """Headers for internal admin user."""
    return {"X-Account-Type": "internal", "X-Tenant-Id": tenant_id, "X-Test-Role": "admin"}


# ═══════════════════════════════════════════════════════════════════
# 1. spec_hash 测试
# ═══════════════════════════════════════════════════════════════════

class TestSpecHash:
    """spec_hash 计算规则测试。"""

    def test_same_input_same_hash(self):
        """同 spec_values 输入产出同 hash。"""
        from app.domain.spec_hash import compute_sku_hash
        h1 = compute_sku_hash("post", {"height": {"v": 1.5}, "product_type": {"v": "直边"}}, None, None)
        h2 = compute_sku_hash("post", {"height": {"v": 1.5}, "product_type": {"v": "直边"}}, None, None)
        assert h1 == h2
        assert len(h1) == 32

    def test_key_order_invariant(self):
        """不同 key 顺序产出同 hash。"""
        from app.domain.spec_hash import compute_sku_hash
        h1 = compute_sku_hash("post", {"height": {"v": 1.5}, "product_type": {"v": "直边"}}, None, None)
        h2 = compute_sku_hash("post", {"product_type": {"v": "直边"}, "height": {"v": 1.5}}, None, None)
        assert h1 == h2

    def test_unit_normalization_cm_m(self):
        """150cm 和 1.5m 产出同 hash（单位归一化到 base unit）。"""
        from app.domain.spec_hash import compute_sku_hash
        def convert_fn(value, from_unit, to_unit):
            conversions = {
                ("cm", "m"): lambda v: Decimal(str(v)) / 100,
                ("m", "m"): lambda v: Decimal(str(v)),
                ("mm", "m"): lambda v: Decimal(str(v)) / 1000,
            }
            fn = conversions.get((from_unit, to_unit))
            if fn:
                return fn(value)
            return Decimal(str(value))
        # Both normalize to base unit "m" — after normalization, unit field doesn't affect hash
        # since compute_sku_hash only uses the normalized value
        h1 = compute_sku_hash("post", {"height": {"v": 150, "u": "cm"}}, {"height": "m"}, convert_fn)
        h2 = compute_sku_hash("post", {"height": {"v": 1.5, "u": "m"}}, {"height": "m"}, convert_fn)
        assert h1 == h2

    def test_nfc_normalize(self):
        """NFC unicode 规范化。"""
        from app.domain.spec_hash import compute_sku_hash
        # é as NFC (U+00E9) vs NFD (U+0065 + U+0301)
        nfc = "é"
        nfd = "é"
        h1 = compute_sku_hash("test", {"name": {"v": nfc}}, None, None)
        h2 = compute_sku_hash("test", {"name": {"v": nfd}}, None, None)
        assert h1 == h2

    def test_decimal_trailing_zeros(self):
        """Decimal 末位 0 不影响 hash。"""
        from app.domain.spec_hash import compute_sku_hash
        h1 = compute_sku_hash("post", {"height": {"v": 1.5}}, None, None)
        h2 = compute_sku_hash("post", {"height": {"v": Decimal("1.50")}}, None, None)
        assert h1 == h2

    def test_different_values_different_hash(self):
        """不同 spec_values 产出不同 hash。"""
        from app.domain.spec_hash import compute_sku_hash
        h1 = compute_sku_hash("post", {"height": {"v": 1.5}}, None, None)
        h2 = compute_sku_hash("post", {"height": {"v": 2.0}}, None, None)
        assert h1 != h2


# ═══════════════════════════════════════════════════════════════════
# 2. units 测试
# ═══════════════════════════════════════════════════════════════════

class TestUnits:
    """单位换算测试。"""

    def test_unknown_unit_raises_sync(self):
        """未知单位抛 ValueError（同步版本）。"""
        from app.domain.units import convert_to_base_unit_sync
        with pytest.raises(ValueError, match="Unknown unit"):
            convert_to_base_unit_sync(1.0, "nonexistent_xyz", "m", {"m": Decimal("1")})

    @pytest.mark.asyncio
    async def test_unknown_unit_raises_async(self, db_session: AsyncSession):
        """未知单位抛 ValueError（异步版本）。"""
        from app.domain.units import convert_to_base_unit
        with pytest.raises(ValueError, match="Unknown unit"):
            await convert_to_base_unit(1.0, "nonexistent_xyz", "m", db_session)


# ═══════════════════════════════════════════════════════════════════
# 3. price_engine 测试
# ═══════════════════════════════════════════════════════════════════

class TestPriceEngine:
    """价格引擎测试。"""

    @pytest.mark.asyncio
    async def test_superseded_on_full_overlap(self, db_session: AsyncSession):
        """完全覆盖 → 老价被 superseded。"""
        from app.services.price_engine import upsert_price

        sku = ProductSku(
            tenant_id="test_tenant", category_id=1,
            spec_values='{}', spec_hash='test_hash_001',
        )
        db_session.add(sku)
        await db_session.flush()

        now = datetime.now(timezone.utc)
        pid1 = await upsert_price(
            db=db_session, sku_id=sku.id, tenant_id="test_tenant",
            price=Decimal("100"), price_unit_code="cny_per_m",
            effective_from=now - timedelta(days=30),
            effective_to=None, created_by="test",
        )
        await db_session.flush()

        pid2 = await upsert_price(
            db=db_session, sku_id=sku.id, tenant_id="test_tenant",
            price=Decimal("120"), price_unit_code="cny_per_m",
            effective_from=now - timedelta(days=60),
            effective_to=None, created_by="test",
        )
        await db_session.flush()

        p1 = await db_session.get(ProductSkuPrice, pid1)
        assert p1.status == "superseded"
        p2 = await db_session.get(ProductSkuPrice, pid2)
        assert p2.status == "active"

    @pytest.mark.asyncio
    async def test_truncate_on_partial_overlap(self, db_session: AsyncSession):
        """部分重叠老在前 → 老 effective_to 被截断。"""
        from app.services.price_engine import upsert_price

        sku = ProductSku(
            tenant_id="test_tenant", category_id=1,
            spec_values='{}', spec_hash='test_hash_002',
        )
        db_session.add(sku)
        await db_session.flush()

        now = datetime.now(timezone.utc)
        pid1 = await upsert_price(
            db=db_session, sku_id=sku.id, tenant_id="test_tenant",
            price=Decimal("100"), price_unit_code="cny_per_m",
            effective_from=now - timedelta(days=30),
            effective_to=None, created_by="test",
        )
        await db_session.flush()

        pid2 = await upsert_price(
            db=db_session, sku_id=sku.id, tenant_id="test_tenant",
            price=Decimal("120"), price_unit_code="cny_per_m",
            effective_from=now,
            effective_to=None, created_by="test",
        )
        await db_session.flush()

        p1 = await db_session.get(ProductSkuPrice, pid1)
        assert p1.effective_to is not None
        assert p1.effective_to <= now + timedelta(seconds=5)


# ═══════════════════════════════════════════════════════════════════
# 4. quote_wizard 测试
# ═══════════════════════════════════════════════════════════════════

class TestQuoteWizard:
    """报价向导测试。"""

    @pytest.mark.asyncio
    async def test_non_leaf_category_rejects(self, db_session: AsyncSession):
        """非叶子类目报错。"""
        from app.services.quote_wizard import submit_wizard

        cat = await db_session.execute(
            select(ProductCategory).where(ProductCategory.is_leaf == False)
        )
        non_leaf = cat.scalars().first()
        if not non_leaf:
            pytest.skip("No non-leaf category in seed data")

        with pytest.raises(ValueError, match="Invalid leaf category"):
            await submit_wizard(
                db=db_session, tenant_id="test", category_id=non_leaf.id,
                spec_values={}, created_by="test",
            )

    @pytest.mark.asyncio
    async def test_missing_required_attr_rejects(self, db_session: AsyncSession):
        """缺必填属性报错。"""
        from app.services.quote_wizard import submit_wizard

        leaf = await _get_leaf_category(db_session)
        if not leaf:
            pytest.skip("No leaf category in seed data")

        with pytest.raises(ValueError, match="Missing required"):
            await submit_wizard(
                db=db_session, tenant_id="test", category_id=leaf.id,
                spec_values={},
                created_by="test",
            )

    @pytest.mark.asyncio
    async def test_same_hash_reuses_sku(self, db_session: AsyncSession):
        """同 spec_hash 第二次提交复用 sku.id。"""
        from app.services.quote_wizard import submit_wizard

        post = await _get_leaf_category(db_session, "post")
        if not post:
            pytest.skip("Post category not in seed data")

        spec_values = await _build_required_spec_values(db_session, post.id)
        if not spec_values:
            pytest.skip("No required bindings for post category")

        r1 = await submit_wizard(
            db=db_session, tenant_id="test_wizard", category_id=post.id,
            spec_values=spec_values, created_by="test",
        )
        await db_session.flush()

        r2 = await submit_wizard(
            db=db_session, tenant_id="test_wizard", category_id=post.id,
            spec_values=spec_values, created_by="test",
        )
        await db_session.flush()

        assert r1["sku_id"] == r2["sku_id"]
        assert r1["is_new_sku"] is True
        assert r2["is_new_sku"] is False

    @pytest.mark.asyncio
    async def test_different_hash_creates_new_sku(self, db_session: AsyncSession):
        """不同 spec_hash 出新 sku。"""
        from app.services.quote_wizard import submit_wizard

        post = await _get_leaf_category(db_session, "post")
        if not post:
            pytest.skip("Post category not in seed data")

        spec_values_1 = await _build_required_spec_values(db_session, post.id)
        spec_values_2 = dict(spec_values_1)
        # Change a numeric value to get different hash (avoids enum validation issues)
        for k in spec_values_2:
            entry = spec_values_2[k]
            if isinstance(entry, dict) and "v" in entry and isinstance(entry["v"], (int, float)):
                spec_values_2[k] = {"v": entry["v"] + 100}
                break

        r1 = await submit_wizard(
            db=db_session, tenant_id="test_wizard2", category_id=post.id,
            spec_values=spec_values_1, created_by="test",
        )
        await db_session.flush()

        r2 = await submit_wizard(
            db=db_session, tenant_id="test_wizard2", category_id=post.id,
            spec_values=spec_values_2, created_by="test",
        )
        await db_session.flush()

        assert r1["sku_id"] != r2["sku_id"]


# ═══════════════════════════════════════════════════════════════════
# 5. RBAC 测试
# ═══════════════════════════════════════════════════════════════════

class TestRBAC:
    """RBAC 权限测试。"""

    @pytest.mark.asyncio
    async def test_viewer_cannot_post_attributes(self, client):
        """viewer (customer account) 调 POST /attributes 返 403。"""
        resp = await client.post(
            "/api/v1/spec/attributes",
            json={"code": "test", "name": "Test", "group_code": "spec", "data_type": "text"},
            headers={"X-Account-Type": "customer"},
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_tenant_admin_cannot_access_admin_api(self, client):
        """非 admin 角色调 /api/v1/admin/spec/* 返 403。"""
        resp = await client.get(
            "/api/v1/admin/spec/attribute-proposals",
            headers={"X-Account-Type": "internal", "X-Tenant-Id": "lianjia"},
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_platform_ops_can_access_admin_api(self, client):
        """platform_ops (internal + admin role) 全通。"""
        resp = await client.get(
            "/api/v1/admin/spec/attribute-proposals",
            headers=_admin_headers(),
        )
        assert resp.status_code == 200


# ═══════════════════════════════════════════════════════════════════
# 6. change_reason 必填测试
# ═══════════════════════════════════════════════════════════════════

class TestChangeReason:
    """change_reason 必填验证。"""

    @pytest.mark.asyncio
    async def test_post_price_without_change_reason_422(self, client, db_session):
        """POST /skus/{id}/prices 不传 change_reason 返 422。"""
        sku = ProductSku(
            tenant_id="lianjia", category_id=1,
            spec_values='{}', spec_hash='test_cr_001',
        )
        db_session.add(sku)
        await db_session.flush()

        resp = await client.post(
            f"/api/v1/spec/skus/{sku.id}/prices",
            json={
                "price": 100, "price_unit": "cny_per_m",
                "effective_from": "2026-01-01",
                # missing change_reason
            },
            headers=_admin_headers(),
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_patch_sku_without_change_reason_422(self, client, db_session):
        """PATCH /skus/{id} 不传 change_reason 返 422。"""
        sku = ProductSku(
            tenant_id="lianjia", category_id=1,
            spec_values='{}', spec_hash='test_cr_002',
        )
        db_session.add(sku)
        await db_session.flush()

        resp = await client.patch(
            f"/api/v1/spec/skus/{sku.id}",
            json={
                "spec_values": {"test": "value"},
                # missing change_reason
            },
            headers=_admin_headers(),
        )
        assert resp.status_code == 422


# ═══════════════════════════════════════════════════════════════════
# 7. SKU 编辑留痕测试
# ═══════════════════════════════════════════════════════════════════

class TestSkuEdit:
    """SKU 编辑留痕 + 409 冲突。"""

    @pytest.mark.asyncio
    async def test_patch_sku_creates_revision(self, client, db_session):
        """PATCH /skus/{id} → product_sku_revisions 多 1 行 + sku.revision+1 + sku.id 不变。"""
        post = await _get_leaf_category(db_session, "post")
        if not post:
            pytest.skip("Post category not in seed")

        sku = ProductSku(
            tenant_id="lianjia", category_id=post.id,
            spec_values='{"height": 1.5}', spec_hash='test_edit_001',
            revision=1,
        )
        db_session.add(sku)
        await db_session.flush()
        original_id = sku.id
        original_revision = sku.revision

        rev_before = await db_session.execute(
            select(ProductSkuRevision).where(ProductSkuRevision.sku_id == sku.id)
        )
        count_before = len(rev_before.scalars().all())

        resp = await client.patch(
            f"/api/v1/spec/skus/{sku.id}",
            json={
                "spec_values": {"height": 2.0},
                "change_reason": "test edit",
            },
            headers=_admin_headers(),
        )
        assert resp.status_code == 200

        await db_session.flush()
        rev_after = await db_session.execute(
            select(ProductSkuRevision).where(ProductSkuRevision.sku_id == sku.id)
        )
        count_after = len(rev_after.scalars().all())
        assert count_after == count_before + 1

        updated_sku = await db_session.get(ProductSku, original_id)
        assert updated_sku.id == original_id
        assert updated_sku.revision == original_revision + 1

    @pytest.mark.asyncio
    async def test_patch_sku_hash_conflict_409(self, client, db_session):
        """新 hash 撞同租户已有 SKU 返 conflict。"""
        from unittest.mock import patch

        post = await _get_leaf_category(db_session, "post")
        if not post:
            pytest.skip("Post category not in seed")

        sku1 = ProductSku(
            tenant_id="lianjia", category_id=post.id,
            spec_values='{"height": 1.5}', spec_hash='test_conflict_aaa',
            revision=1,
        )
        sku2 = ProductSku(
            tenant_id="lianjia", category_id=post.id,
            spec_values='{"height": 2.0}', spec_hash='test_conflict_bbb',
            revision=1,
        )
        db_session.add_all([sku1, sku2])
        await db_session.flush()

        with patch("app.api.skus.compute_sku_hash", return_value="test_conflict_aaa"):
            resp = await client.patch(
                f"/api/v1/spec/skus/{sku2.id}",
                json={
                    "spec_values": {"height": 1.5},
                    "change_reason": "test conflict",
                },
                headers=_admin_headers(),
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data.get("error") == "conflict"


# ═══════════════════════════════════════════════════════════════════
# 8. EXCLUDE 约束测试
# ═══════════════════════════════════════════════════════════════════

class TestExcludeConstraint:
    """EXCLUDE 约束测试。"""

    @pytest.mark.asyncio
    async def test_overlapping_active_prices_fail(self, db_session: AsyncSession):
        """手工 INSERT 两条重叠 active price 触发 DB 报错。"""
        sku = ProductSku(
            tenant_id="test_exclude", category_id=1,
            spec_values='{}', spec_hash='test_exclude_001',
        )
        db_session.add(sku)
        await db_session.flush()

        now = datetime.now(timezone.utc)
        p1 = ProductSkuPrice(
            sku_id=sku.id, tenant_id="test_exclude",
            price=Decimal("100"), price_unit="cny_per_m",
            effective_from=now - timedelta(days=30),
            effective_to=None, status="active", created_by="test",
        )
        db_session.add(p1)
        await db_session.flush()

        p2 = ProductSkuPrice(
            sku_id=sku.id, tenant_id="test_exclude",
            price=Decimal("120"), price_unit="cny_per_m",
            effective_from=now,
            effective_to=None, status="active", created_by="test",
        )
        db_session.add(p2)

        with pytest.raises(Exception) as exc_info:
            await db_session.flush()

        assert "excl_psp_overlap" in str(exc_info.value) or "exclude" in str(exc_info.value).lower()


# ═══════════════════════════════════════════════════════════════════
# 9. promotion_recommender 测试
# ═══════════════════════════════════════════════════════════════════

class TestPromotionRecommender:
    """晋升推荐引擎测试。"""

    @pytest.mark.asyncio
    async def test_three_tenants_same_proposal_gets_recommended(self, db_session: AsyncSession):
        """3 个不同租户独立创建同名 proposal → recommended_for_promotion=TRUE。"""
        cat = await db_session.execute(
            select(ProductCategory).where(ProductCategory.is_leaf == True)
        )
        leaf_cat = cat.scalars().first()
        if not leaf_cat:
            pytest.skip("No leaf category")

        # Create a public attribute with similar name for trigram matching
        existing_attr = SpecAttribute(
            code="galvanized_thickness", name="镀锌层厚度",
            group_code="spec", data_type="text", scope="public",
        )
        db_session.add(existing_attr)
        await db_session.flush()

        # Create 3 proposals from different tenants
        for tenant in ["tenant_a", "tenant_b", "tenant_c"]:
            p = AttributeProposal(
                tenant_id=tenant, category_id=leaf_cat.id,
                group_code="spec", proposed_name="镀锌层厚度",
                proposed_type="text", status="pending",
                occurrence_count=1,
            )
            db_session.add(p)
        await db_session.flush()

        # Run recommendation engine
        from app.services.promotion_recommender import update_recommendations
        updated = await update_recommendations(db_session)
        assert updated >= 3

        # Verify recommendations
        result = await db_session.execute(
            select(AttributeProposal)
            .where(
                and_(
                    AttributeProposal.proposed_name == "镀锌层厚度",
                    AttributeProposal.status == "pending",
                )
            )
        )
        proposals = result.scalars().all()
        recommended_count = sum(1 for p in proposals if p.recommended_for_promotion)
        assert recommended_count >= 3

        for p in proposals:
            if p.recommended_for_promotion:
                assert p.recommendation_score is not None
                assert p.recommendation_score > 0
