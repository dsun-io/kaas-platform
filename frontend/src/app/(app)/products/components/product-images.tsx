"use client";

/**
 * 产品图片：上传 + 命名 + 类型 + 排序 + 主图 + 移除。
 * 全部按当前产品归属（/products/{key}/media），不再有"公共图库"的感觉。
 */
import { useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Link2, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchFileDirectUrl,
  useFileObjectUrl,
  usePatchFile,
  useProductMedia,
  useReorderProductMedia,
  useRetireFile,
  useUploadProductMedia,
  type ProductMedia,
} from "@/lib/products/use-products";

import { sortErrorMessage, uploadErrorMessage } from "../upload-errors";

const MEDIA_KIND_FALLBACK: Record<string, string> = {
  production: "生产图片",
  size: "尺寸图片",
  weight: "重量图片",
  finished: "成品图片",
  other: "其它",
};

export function ProductImagesSection({ productKey }: { productKey: string }) {
  const media = useProductMedia(productKey);
  const upload = useUploadProductMedia(productKey);
  const reorder = useReorderProductMedia();
  const mediaKinds = media.data?.media_kinds ?? MEDIA_KIND_FALLBACK;
  const items = media.data?.items ?? [];
  const [kind, setKind] = useState("production");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const firstIsPrimary = Boolean(items[0]?.is_primary);

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    const patches: { id: number; sort_order: number }[] = [];
    next.forEach((m, i) => {
      if (m.sort_order !== i) patches.push({ id: m.id, sort_order: i });
    });
    reorder.mutate(patches, {
      onSuccess: () => toast.success("顺序已更新"),
      onError: (err) => toast.error(sortErrorMessage(err)),
    });
  };

  const doUpload = async () => {
    if (!file) return toast.error("先选一张图片");
    if (!name.trim()) return toast.error("给图片起个名字，单证引用时能认出来");
    try {
      const uploaded = await upload.mutateAsync({
        file,
        name: name.trim(),
        mediaKind: kind,
      });
      toast.success("已上传");
      setName("");
      setFile(null);
    } catch (err) {
      toast.error(uploadErrorMessage(err));
    }
  };

  return (
    <SectionCard
      title="产品图片"
      description="这些图片只属于当前产品；报价和单证引用时，名称和顺序会一起带过去。"
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">图片类型</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {Object.entries(mediaKinds).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[220px] flex-1 space-y-1">
          <span className="text-sm font-medium">图片名称</span>
          <Input
            value={name}
            placeholder="如：2m×20m 侧面尺寸图"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">选择图片</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="block text-xs"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Button disabled={upload.isPending} onClick={() => void doUpload()}>
          <ImagePlus className="mr-1 h-4 w-4" />
          {upload.isPending ? "上传中…" : "上传"}
        </Button>
      </div>

      {media.isLoading ? (
        <LoadingBlock rows={3} className="py-6" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ImagePlus}
          title="这个产品还没有图片"
          description="上传生产图、尺寸图、重量图或成品图；命名后报价和单证可以直接引用。"
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((m, i) => (
            <MediaCard
              key={m.id}
              media={m}
              position={i + 1}
              kindLabel={mediaKinds[m.media_kind ?? "other"] ?? m.media_kind ?? "其它"}
              canMoveUp={i > 0 && !(firstIsPrimary && i === 1)}
              canMoveDown={i < items.length - 1}
              moving={reorder.isPending}
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function MediaCard({
  media,
  kindLabel,
  position,
  canMoveUp,
  canMoveDown,
  moving,
  onMoveUp,
  onMoveDown,
}: {
  media: ProductMedia;
  kindLabel: string;
  position: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moving: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const url = useFileObjectUrl(media.id);
  const patch = usePatchFile();
  const retire = useRetireFile();
  const [name, setName] = useState(media.name);

  return (
    <div className="rounded-lg border p-2">
      <div className="mb-2 flex h-32 items-center justify-center overflow-hidden rounded bg-muted/30">
        {url.data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url.data} alt={media.name} className="max-h-32 w-auto" />
        ) : (
          <span className="text-xs text-muted-foreground">
            {url.isError ? "读取失败" : "加载中…"}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1">{kindLabel}</span>
        <span className="rounded bg-muted px-1" title="展示顺序">
          #{position}
        </span>
        {media.is_primary && (
          <span className="flex items-center gap-0.5 rounded bg-primary/10 px-1 text-primary">
            <Star className="h-3 w-3" /> 主图
          </span>
        )}
      </div>
      <Input
        className="mt-2 h-8 text-xs"
        value={name}
        aria-label="图片名称"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name !== media.name) {
            patch.mutate(
              { id: media.id, name: name.trim() },
              {
                onSuccess: () => toast.success("已改名"),
                onError: () => toast.error("改名失败"),
              },
            );
          }
        }}
      />
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={"上移 " + media.name}
          title={canMoveUp ? "上移" : "主图恒排最前"}
          disabled={!canMoveUp || moving}
          onClick={onMoveUp}
        >
          <ArrowUp className="mr-1 h-3.5 w-3.5" />
          上移
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={"下移 " + media.name}
          title={canMoveDown ? "下移" : "已经是最后一张"}
          disabled={!canMoveDown || moving}
          onClick={onMoveDown}
        >
          <ArrowDown className="mr-1 h-3.5 w-3.5" />
          下移
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={media.is_primary || patch.isPending}
          onClick={() =>
            patch.mutate(
              { id: media.id, is_primary: true },
              {
                onSuccess: () => toast.success("已设为主图"),
                onError: () => toast.error("设置失败"),
              },
            )
          }
        >
          <Star className="mr-1 h-3.5 w-3.5" />
          设主图
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const directUrl = await fetchFileDirectUrl(media.id);
            if (!directUrl) {
              toast.error("这张图暂不支持复制链接");
              return;
            }
            await navigator.clipboard.writeText(directUrl);
            toast.success("已复制图片链接（15 分钟内有效）");
          }}
        >
          <Link2 className="mr-1 h-3.5 w-3.5" />
          复制链接
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={retire.isPending}
          onClick={() =>
            retire.mutate(media.id, {
              onSuccess: () => toast.success("已移除（存档保留，可恢复）"),
              onError: () => toast.error("移除失败"),
            })
          }
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          移除
        </Button>
      </div>
    </div>
  );
}
