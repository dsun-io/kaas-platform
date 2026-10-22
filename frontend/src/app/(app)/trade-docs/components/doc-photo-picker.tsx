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
 *
 * 2026-10-22 补充：已引用的图**按出图顺序**排在这里，可以拖动把手调整、也可以
 * 直接移除。原先只能靠手改 `product_photos` 的 JSON 调顺序 —— 那是让用户编辑
 * 序列化数据，既容易写坏格式，也不知道"改完到底长什么样"。
 */
import { useState } from "react";
import { Images, Plus, X } from "lucide-react";

import { SortableGrip, SortableList } from "@/components/shared/sortable-list";
import { Button } from "@/components/ui/button";
import {
  useFileObjectUrl,
  useProductMedia,
  useProducts,
  type ProductMedia,
} from "@/lib/products/use-products";

import type { PickedPhoto } from "./photo-entries";

// 类型定义在 photo-entries（纯函数模块）里，这里只做转出，避免两处各写一份
export type { PickedPhoto };

/** 模块级：`SortableList` 会把它放进 memo 依赖，内联箭头函数会让 id 列表白算 */
const pickedPhotoId = (photo: PickedPhoto): number => photo.file_id;

export function DocPhotoPicker({
  onPick,
  disabled,
  pickedIds,
  picked = [],
  onReorder,
  onRemove,
}: {
  onPick: (entry: { file_id: number; caption: string }) => void;
  disabled?: boolean;
  /** 已在本单据里的 file_id（用于标记"已添加"，避免重复引用） */
  pickedIds?: number[];
  /** 已引用的图（按出图顺序） */
  picked?: PickedPhoto[];
  /** 拖动后的新顺序（调用方负责写回 `product_photos`） */
  onReorder?: (next: PickedPhoto[]) => void;
  onRemove?: (fileId: number) => void;
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

      {picked.length > 0 && (
        <div className="mb-3 rounded-md border bg-background p-2">
          <p className="mb-1.5 text-xs font-medium">
            已引用 {picked.length} 张
            <span className="ml-1 font-normal text-muted-foreground">
              （按这个顺序出图，拖动把手可调整）
            </span>
          </p>
          <SortableList
            items={picked}
            getItemId={pickedPhotoId}
            onReorder={onReorder ?? (() => {})}
            disabled={disabled || !onReorder}
            className="space-y-1"
            renderItem={(photo) => (
              <div className="flex items-center gap-2 rounded border px-1.5 py-1">
                <SortableGrip
                  className="inline-flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  label={`拖动排序 ${photo.caption || `图片 ${photo.file_id}`}`}
                />
                <PickedPhotoThumb fileId={photo.file_id} caption={photo.caption} />
                <span className="min-w-0 flex-1 truncate text-[11px]">
                  {photo.caption || `#${photo.file_id}`}
                </span>
                {onRemove && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 p-0"
                    aria-label={`移除引用 ${photo.caption || `图片 ${photo.file_id}`}`}
                    disabled={disabled}
                    onClick={() => onRemove(photo.file_id)}
                  >
                    <X className="size-3" />
                  </Button>
                )}
              </div>
            )}
          />
        </div>
      )}

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

/** 已引用图的缩略图（走 blob 鉴权取图，`<img src>` 带不上 Bearer） */
function PickedPhotoThumb({ fileId, caption }: { fileId: number; caption: string }) {
  const url = useFileObjectUrl(fileId);
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/40">
      {url.data ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url.data} alt={caption || `图片 ${fileId}`} className="size-full object-cover" />
      ) : (
        <span className="text-[9px] text-muted-foreground">
          {url.isError ? "×" : "…"}
        </span>
      )}
    </span>
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
