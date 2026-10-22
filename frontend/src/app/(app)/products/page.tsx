"use client";

/**
 * 产品工位（2026-10-22 傻瓜化重做）。
 *
 * 一页三块：产品卡（含主图缩略图）→ 选中产品的详情（图片/基础信息/规格与价格）
 * → 平台管理员折叠的高级设置。
 *
 * 关键变化：
 * - 图片归到对应产品里，不再有“上面图片、下面定义”的割裂；
 * - 普通界面不展示产品 Key，新建时自动生成；
 * - 规格只暴露业务项，公式/JSON 收进仅管理员可见的高级设置。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Package, Plus } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import {
  useProducts,
  productKeys,
} from "@/lib/products/use-products";
import {
  hasCalculationRules,
  mergeWorkProducts,
  tenantProductKeys,
  useProductQuoteStatus,
  useTenantProducts,
} from "@/lib/products/tenant-products";

import { NewProductDialog } from "./components/new-product-dialog";
import { ProductCard } from "./components/product-card";
import { ProductDetail } from "./components/product-detail";

export default function ProductsWorkstationPage() {
  const registry = useProducts();
  const tenants = useTenantProducts();
  const statuses = useProductQuoteStatus();
  const qc = useQueryClient();
  const detailRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const products = useMemo(
    () =>
      mergeWorkProducts(registry.data?.items, tenants.data),
    [registry.data, tenants.data],
  );

  // 首次加载默认展示第一个产品：图片/基础信息一进来就能看到，不用先猜要点谁。
  const activeKey = selected ?? products[0]?.key ?? null;

  // 兼容旧深链 ?tab=definitions：滚到详情，不 404。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("tab") === "definitions") {
      detailRef.current?.scrollIntoView({ block: "start" });
    }
  }, []);

  const selectedProduct =
    products.find((p) => p.key === activeKey) ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: tenantProductKeys.list });
    void qc.invalidateQueries({ queryKey: productKeys.all });
    void qc.invalidateQueries({ queryKey: ["export-products"] });
    void qc.invalidateQueries({ queryKey: tenantProductKeys.status });
    void qc.invalidateQueries({ queryKey: ["product-spec"] });
  };

  const quoteEnabledOf = (key: string) => {
    const row = products.find((p) => p.key === key);
    if (row?.tenant) return row.tenant.is_active !== false;
    return statuses.data?.find((s) => s.product_key === key)?.is_enabled !== false;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="产品"
        description="一个产品一张卡：图片、基础信息、规格与价格都在这里维护；报价和单证都引用这里的数据。"
      />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">产品列表</h2>
            <p className="text-sm text-muted-foreground">
              点任意产品，下面就是它的图片和资料；图片只属于当前产品。
            </p>
          </div>
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            新建产品
          </Button>
        </div>

        {registry.isLoading || tenants.isLoading ? (
          <LoadingBlock rows={2} />
        ) : products.length === 0 ? (
          <EmptyState
            icon={Package}
            title="还没有产品"
            description="点「新建产品」创建一个；可以从现有产品复制计算规则。"
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {products.map((p) => (
              <ProductCard
                key={p.key}
                product={p}
                selected={p.key === activeKey}
                rulesReady={
                  p.isSystem ? true : hasCalculationRules(p.tenant?.spec)
                }
                quoteEnabled={quoteEnabledOf(p.key)}
                onSelect={() => {
                  setSelected(p.key);
                  requestAnimationFrame(() =>
                    detailRef.current?.scrollIntoView({
                      block: "start",
                      behavior: "smooth",
                    }),
                  );
                }}
              />
            ))}
          </div>
        )}
      </section>

      <div ref={detailRef} className="scroll-mt-24">
        {selectedProduct ? (
          <ProductDetail
            key={selectedProduct.key}
            product={selectedProduct}
            candidates={products}
            onChanged={refresh}
            onDeleted={() => {
              setSelected(null);
              refresh();
            }}
          />
        ) : (
          !registry.isLoading &&
          products.length > 0 && (
            <EmptyState
              icon={Package}
              title="选一个产品"
              description="点上面的产品卡，查看它的图片、基础信息和规格。"
            />
          )
        )}
      </div>

      <NewProductDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        products={products}
        onCreated={(key) => {
          setSelected(key);
          refresh();
        }}
      />
    </div>
  );
}
