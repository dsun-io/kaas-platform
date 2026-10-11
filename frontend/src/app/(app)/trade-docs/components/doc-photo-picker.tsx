"use client";

/**
 * 「从产品图库选图」选择器（单证内容填写用）
 *
 * 用户要求（原话）：
 *   「单证直接调用产品管理页面的图片，就行。这样就做到了一次维护，重复使用，一劳永逸。」
 *
 * 为什么做成"选引用"而不是"再传一次"：
 * - 单证的 `product_photos` 支持 `{"file_id": N, "caption": …}` 条目，
 *   由后端 render-data **装配层**解析成 data URI（渲染器的图片白名单不放开，也无需放开）。
 * - 引用而非复制 ⇒ 产品图改名/换图，所有引用它的单证**同步生效**。
 *
 * 只在单证处于 draft（可编辑）时可用；已签发的单据内容冻结。
 */
import { useState } from "react";
import { Images, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useFileObjectUrl,
  useProductMedia,
  useProducts,
  type ProductMedia,
} from "@/lib/products/use-products";

export function DocPhotoPicker({
  onPick,
  disabled,
  pickedIds,
}: {
  onPick: (entry: { file_id: number; caption: string }) => void;
  disabled?: boolean;
  /** 已在本单据里的 file_id（用于标记"已添加"，避免重复引用） */
  pickedIds?: number[];
}) {
  const products = useProducts();
  const [productKey, setProductKey] = useState<string>("");
  const media = useProductMedia(productKey || null);
  const items = products.data?.items ?? [];

  return (
    <div className="mt-3 rounded-md border border-dashed bg-muted/20 p-3 sm:col-span-2">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <Images className="h-3.5 w-3.5" />
        从产品图库选图
        <span className="font-normal text-muted-foreground">
          （产品图在「产品」工位维护一次，这里只做**引用**：改图/改名后所有单证同步生效）
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={productKey}
          disabled={disabled}
          onChange={(e) => setProductKey(e.target.value)}
        >
          <option value="">选择产品…</option>
          {items.map((p) => (
            <option key={p.product_key} value={p.product_key}>
              {p.name}（{p.media_count} 张）
            </option>
          ))}
        </select>
        {productKey && media.isLoading && (
          <span className="text-xs text-muted-foreground">加载图片…</span>
        )}
      </div>

      {productKey && (media.data?.items ?? []).length > 0 && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {(media.data?.items ?? []).map((m: ProductMedia) => (
            <PickablePhoto
              key={m.id}
              media={m}
              disabled={disabled}
              picked={Boolean(pickedIds?.includes(m.id))}
              onPick={onPick}
            />
          ))}
        </div>
      )}
      {productKey && !media.isLoading && (media.data?.items ?? []).length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          这个产品还没有图片 —— 到「产品」工位上传统一命名后即可在此引用。
        </p>
      )}
    </div>
  );
}

function PickablePhoto({
  media,
  disabled,
  picked,
  onPick,
}: {
  media: ProductMedia;
  disabled?: boolean;
  picked: boolean;
  onPick: (entry: { file_id: number; caption: string }) => void;
}) {
  const url = useFileObjectUrl(media.id);
  const kindLabel = media.media_kind ?? "";
  return (
    <div className="rounded border bg-background p-1.5">
      <div className="mb-1 flex h-20 items-center justify-center overflow-hidden rounded bg-muted/30">
        {url.data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url.data} alt={media.name} className="max-h-20 w-auto" />
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {url.isError ? "读取失败" : "加载中…"}
          </span>
        )}
      </div>
      <p className="truncate text-[11px]" title={media.name}>
        {media.name}
      </p>
      <div className="mt-1 flex items-center justify-between gap-1">
        <span className="text-[10px] text-muted-foreground">{kindLabel}</span>
        <Button
          size="sm"
          variant={picked ? "secondary" : "ghost"}
          className="h-6 px-1.5 text-[11px]"
          disabled={disabled || picked}
          onClick={() => onPick({ file_id: media.id, caption: media.name })}
        >
          <Plus className="mr-0.5 h-3 w-3" />
          {picked ? "已添加" : "添加"}
        </Button>
      </div>
    </div>
  );
}
