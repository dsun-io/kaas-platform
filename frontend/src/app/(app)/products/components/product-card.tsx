"use client";

/**
 * 产品卡：主图缩略图 + 名称 + 图片张数 + 状态。
 * 图片用 /products/{key}/media 取（按产品存图），点击卡片进入该产品详情。
 */
import { ImagePlus, Package } from "lucide-react";

import { LoadingBlock } from "@/components/shared/loading-block";
import { StatusBadge } from "@/components/shared/status-badge";
import { useFileObjectUrl, useProductMedia } from "@/lib/products/use-products";
import { cn } from "@/lib/utils";

import type { WorkProduct } from "@/lib/products/tenant-products";

export function ProductCard({
  product,
  selected,
  rulesReady,
  quoteEnabled,
  onSelect,
}: {
  product: WorkProduct;
  selected: boolean;
  rulesReady: boolean;
  quoteEnabled: boolean;
  onSelect: () => void;
}) {
  // 产品列表一屏十来张卡：缩略图/媒体失败不弹全局 toast（错误的可见入口在详情页图库）
  const media = useProductMedia(product.key, { silent: true });
  const items = media.data?.items ?? [];
  const primary = items.find((m) => m.is_primary) ?? items[0] ?? null;
  const url = useFileObjectUrl(primary?.id ?? null, { silent: true });

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
        {media.isLoading ? (
          <LoadingBlock rows={1} className="w-full px-2" />
        ) : url.data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url.data}
            alt={primary?.name ?? product.name}
            className="size-full object-cover"
          />
        ) : (
          <ImagePlus
            className="size-6 text-muted-foreground/60"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{product.name}</span>
          {!rulesReady ? (
            <StatusBadge tone="warning" className="shrink-0 whitespace-nowrap">
              待配置规则
            </StatusBadge>
          ) : quoteEnabled ? (
            <StatusBadge tone="success" className="shrink-0 whitespace-nowrap">
              报价中
            </StatusBadge>
          ) : (
            <StatusBadge tone="default" className="shrink-0 whitespace-nowrap">
              已停用
            </StatusBadge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {product.nameEn || "未填英文名"}
          {product.isSystem ? " · 平台内置" : " · 我们自定义"}
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Package className="size-3.5" aria-hidden="true" />
          图片 {items.length} 张
        </p>
      </div>
    </button>
  );
}
