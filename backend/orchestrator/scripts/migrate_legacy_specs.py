"""
老数据迁移脚本 — product_specs 固定列 → product_skus.spec_values + 初始价格行

用法:
    cd backend/orchestrator
    python -m scripts.migrate_legacy_specs [--dry-run]

幂等: 按 tenant_id + spec_hash 检查已存在则跳过。
"""
import asyncio
import sys
import hashlib
import json
from datetime import datetime, timezone

# Allow running as standalone script
sys.path.insert(0, ".")

from app.db.session import async_session_factory
from sqlalchemy import text


LEGACY_SPEC_COLUMNS = [
    "product_type",
    "wire_diameter",
    "height",
    "mesh_width",
    "mesh_spec",
    "roll_length",
    "weight_kg",
    "bundle_size",
]


def compute_legacy_hash(category_code: str, spec: dict) -> str:
    """兼容老系统的 spec_hash 计算方式。"""
    canonical = json.dumps(
        {"category": category_code, **{k: v for k, v in sorted(spec.items()) if v is not None}},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


async def migrate(dry_run: bool = False):
    async with async_session_factory() as db:
        # 1. 读取所有老 product_specs
        result = await db.execute(text("""
            SELECT id, tenant_id, product_category, product_type, wire_diameter,
                   height, mesh_width, mesh_spec, roll_length, weight_kg,
                   bundle_size, spec_hash, created_at
            FROM product_specs
            ORDER BY id
        """))
        old_specs = result.fetchall()

        if not old_specs:
            print("No legacy product_specs found. Nothing to migrate.")
            return

        print(f"Found {len(old_specs)} legacy product_specs to migrate.")

        migrated = 0
        skipped = 0

        for row in old_specs:
            spec_id, tenant_id, category, ptype, wd, h, mw, ms, rl, wk, bs, old_hash, created = row

            # Build spec_values dict
            spec_values = {}
            if ptype:
                spec_values["product_type"] = ptype
            if wd:
                spec_values["wire_diameter"] = wd
            if h is not None:
                spec_values["height"] = float(h)
            if mw is not None:
                spec_values["mesh_width"] = float(mw)
            if ms:
                spec_values["mesh_spec"] = ms
            if rl is not None:
                spec_values["roll_length"] = float(rl)
            if wk is not None:
                spec_values["weight_kg"] = float(wk)
            if bs is not None:
                spec_values["bundle_size"] = float(bs)

            # Check if SKU already exists with same hash
            existing = await db.execute(text("""
                SELECT id FROM product_skus
                WHERE tenant_id = :tid AND spec_hash = :hash
                LIMIT 1
            """), {"tid": tenant_id, "hash": old_hash})
            if existing.fetchone():
                skipped += 1
                continue

            # Get category_id from product_categories
            cat_result = await db.execute(text("""
                SELECT id FROM product_categories WHERE code = :code LIMIT 1
            """), {"code": category})
            cat_row = cat_result.fetchone()
            if not cat_row:
                print(f"  WARNING: category '{category}' not found in product_categories, skipping spec_id={spec_id}")
                skipped += 1
                continue
            category_id = cat_row[0]

            # Insert into product_skus
            if not dry_run:
                await db.execute(text("""
                    INSERT INTO product_skus
                        (tenant_id, category_id, spec_values, spec_hash, schema_version,
                         weight_kg, revision, created_at)
                    VALUES
                        (:tid, :cid, :sv, :sh, 1, :wk, 1, :cat)
                """), {
                    "tid": tenant_id,
                    "cid": category_id,
                    "sv": json.dumps(spec_values, ensure_ascii=False),
                    "sh": old_hash,
                    "wk": float(wk) if wk else None,
                    "cat": created or datetime.now(timezone.utc),
                })

            migrated += 1

        if not dry_run:
            await db.commit()

        print(f"\nMigration complete: {migrated} migrated, {skipped} skipped (already exist).")
        if dry_run:
            print("(DRY RUN — no changes committed)")


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    asyncio.run(migrate(dry_run=dry))
