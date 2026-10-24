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
import { AlertTriangle, Loader2, Package, Plus } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { useProducts, productKeys } from "@/lib/products/use-products";
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
  // silent：这一页自己渲染错误态（ErrorState + 重试），一次加载里 N 个查询同时 502
  // 不该刷 N 条「后端忙碌」toast —— 那正是用户说的"控制台大量报错"。
  const registry = useProducts({ silent: true });
  const tenants = useTenantProducts({ silent: true });
  const statuses = useProductQuoteStatus({ silent: true });
  const qc = useQueryClient();
  const detailRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const products = useMemo(
    () => mergeWorkProducts(registry.data?.items, tenants.data),
    [registry.data, tenants.data],
  );

  // 首次加载默认展示第一个产品：图片/基础信息一进来就能看到，不用先猜要点谁。
  const activeKey = selected ?? products[0]?.key ?? null;

  // 兼容旧深链 ?tab=definitions：滚到详情，不 404。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      new URLSearchParams(window.location.search).get("tab") === "definitions"
    ) {
      detailRef.current?.scrollIntoView({ block: "start" });
    }
  }, []);

  const selectedProduct = products.find((p) => p.key === activeKey) ?? null;

  /**
   * 列表整体加载失败时的重试：把这一页依赖的三份数据一起重拉。
   * `refetch` 是立即拉（不受 staleTime 限制），比 invalidate 更符合"用户点了重试"。
   */
  const reloadProducts = () => {
    void registry.refetch();
    void tenants.refetch();
    void statuses.refetch();
  };

  /** 失败后仍在自动重试（重试期间 isError 仍为 true，要结合 isFetching 判断） */
  const listRetrying =
    (registry.isFetching && (registry.failureCount > 0 || registry.isError)) ||
    (tenants.isFetching && (tenants.failureCount > 0 || tenants.isError));

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
    return (
      statuses.data?.find((s) => s.product_key === key)?.is_enabled !== false
    );
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

        {/* 失败后仍在自动重试：先说明"在重试"，别让用户对着骨架干等 */}
        {listRetrying ? (
          <div
            role="status"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning-muted-foreground"
          >
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            <span>服务暂时不可用（后台内核正在启动），正在自动重试…</span>
          </div>
        ) : null}

        {registry.isError && products.length === 0 ? (
          // 关键：失败**不能**渲染成"还没有产品" —— 用户会以为数据没了，
          // 也不会点重试（第一版就是把 502 显示成了空态）。
          <ErrorState
            title="产品列表暂时加载不了"
            message="后台服务暂时不可用（内核正在启动），已自动重试。数据没有丢，稍后点「重试」再取一次。"
            onRetry={reloadProducts}
            retryLabel="重试"
          />
        ) : registry.isLoading || tenants.isLoading ? (
          <LoadingBlock rows={2} />
        ) : products.length === 0 ? (
          <EmptyState
            icon={Package}
            title="还没有产品"
            description="点「新建产品」创建一个；可以从现有产品复制计算规则。"
          />
        ) : (
          <>
            {/* 手里有上次的列表、但刷新失败：明说这是旧数据 */}
            {registry.isError || tenants.isError ? (
              <div
                role="alert"
                className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
              >
                <AlertTriangle
                  className="size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <span>
                  产品列表刷新失败（服务暂时不可用），下面显示的是上次加载的内容。
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  onClick={reloadProducts}
                >
                  重试
                </Button>
              </div>
            ) : null}
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
          </>
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
