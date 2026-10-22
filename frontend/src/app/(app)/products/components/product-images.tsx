"use client";

/**
 * 产品图片区 = 上传区（`MediaUploadZone`）+ 图库。
 *
 * 2026-10-22 重做（用户原话："交互设计太反人类"）。四条硬约束：
 *
 * 1. **不再有上移/下移按钮**：排序一律拖拽（`SortableList`，网格模式）。
 *    主图固定第一位（后端列表就是 `is_primary DESC, sort_order, id`），
 *    换主图用星标，而不是把某张图拖到最前面 —— 后者会被服务端顶回来。
 *    键盘用户仍有等价操作：Tab 到把手 → Space 拾起 → 方向键移动 → Space 放下。
 * 2. **上传不再是"填表"**：见 `MediaUploadZone`，文件先入队、名称不卡上传。
 * 3. **改名不再 blur 静默写库**：输入框只在 Enter / ✓ 时提交，Esc 撤回。
 *    静默写库最坏的情况是"手滑打了一半就失焦，名字已经存进去了"。
 * 4. **每个动作都要有话说**：移除走二次确认并说明"存档保留可恢复"，
 *    复制链接说明有效期，失败时透出后端可执行原因而不是"操作失败"。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Link2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { SectionCard } from "@/components/shared/section-card";
import { SortableGrip, SortableList } from "@/components/shared/sortable-list";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  fetchFileDirectUrl,
  productKeys,
  useFileObjectUrl,
  usePatchFile,
  useProductMedia,
  useReorderProductMedia,
  useRetireFile,
  type ProductMedia,
} from "@/lib/products/use-products";

import { MEDIA_NAME_MAX, formatBytes, validateMediaName } from "../media-validation";
import { pinPrimaryFirst, reorderPatches } from "../media-order";
import { apiErrorParts, sortErrorMessage } from "../upload-errors";
import { MediaUploadZone } from "./media-upload-zone";

const MEDIA_KIND_FALLBACK: Record<string, string> = {
  production: "生产图片",
  size: "尺寸图片",
  weight: "重量图片",
  finished: "成品图片",
  other: "其它",
};

/** 非上传类写操作（改名/设主图/移除）的失败提示：后端有可执行原因就透出来 */
function actionError(err: unknown, fallback: string): string {
  const detail = apiErrorParts(err).detail;
  return detail ? `${fallback}：${detail}` : fallback;
}

/**
 * 主图恒排最前 —— 规则本体在 `../media-order`（纯函数，可单测），
 * 这里只负责把它接进拖拽落点。
 */
export function ProductImagesSection({ productKey }: { productKey: string }) {
  const qc = useQueryClient();
  const media = useProductMedia(productKey);
  const reorder = useReorderProductMedia();
  const retire = useRetireFile();

  const mediaKinds = media.data?.media_kinds ?? MEDIA_KIND_FALLBACK;
  // 必须 memo：`?? []` 每次渲染都是新数组，会让 SortableList 的 id 列表白算
  const items = useMemo(() => media.data?.items ?? [], [media.data]);

  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const [retireTarget, setRetireTarget] = useState<ProductMedia | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);

  const handleReorder = useCallback(
    (next: ProductMedia[]) => {
      const ordered = pinPrimaryFirst(next);
      // 位次没变（拖回原处、或只是把某张挪到主图前面被收敛回原位）⇒ 不发请求
      const patches = reorderPatches(ordered);
      if (patches.length === 0) return;

      // 乐观：先把拖出来的顺序写进缓存，卡片立刻稳住；失败再拉回服务端真相
      qc.setQueryData<{ items: ProductMedia[]; media_kinds: Record<string, string> }>(
        productKeys.media(productKey),
        (old) =>
          old ? { ...old, items: ordered.map((m, i) => ({ ...m, sort_order: i })) } : old,
      );

      reorder.mutate(patches, {
        onSuccess: () => toast.success("顺序已更新"),
        onError: (err) => {
          toast.error(sortErrorMessage(err));
          // 乐观值现在是假的：立刻拉回服务端顺序，别让界面停在没保存的状态
          void qc.invalidateQueries({ queryKey: productKeys.all });
        },
      });
    },
    [productKey, qc, reorder],
  );

  const lightboxIndex = useMemo(
    () => (lightboxId === null ? -1 : items.findIndex((m) => m.id === lightboxId)),
    [items, lightboxId],
  );

  const navigate = useCallback(
    (delta: number) => {
      if (lightboxIndex < 0 || items.length === 0) return;
      const next = (lightboxIndex + delta + items.length) % items.length;
      const target = items[next];
      if (target) setLightboxId(target.id);
    },
    [items, lightboxIndex],
  );

  const closeRetire = useCallback((open: boolean) => {
    if (!open) {
      setRetireTarget(null);
      setRetireError(null);
    }
  }, []);

  return (
    <SectionCard
      title="产品图片"
      description="只属于当前产品；报价和单证引用时，名称与顺序会一起带过去。拖动卡片右上角的把手可调整顺序，主图固定第一位。"
    >
      <MediaUploadZone productKey={productKey} mediaKinds={mediaKinds} />

      {media.isLoading ? (
        <LoadingBlock rows={3} className="py-6" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ImagePlus}
          title="这个产品还没有图片"
          description="上传生产图、尺寸图、重量图或成品图；命名后报价和单证可以直接引用。"
        />
      ) : (
        <SortableList
          layout="grid"
          items={items}
          onReorder={handleReorder}
          disabled={reorder.isPending}
          // 主图固定第一位：拖它没有意义（服务端会顶回来），直接不给把手
          canDrag={(item) => !item.is_primary}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
          itemClassName="data-[dragging=true]:opacity-40"
          renderItem={(item, index) => (
            <MediaCard
              media={item}
              position={index + 1}
              kindLabel={mediaKinds[item.media_kind ?? "other"] ?? item.media_kind ?? "其它"}
              onOpen={() => setLightboxId(item.id)}
              onRequestRemove={() => {
                setRetireError(null);
                setRetireTarget(item);
              }}
            />
          )}
        />
      )}

      <MediaLightbox
        items={items}
        index={lightboxIndex}
        kindLabels={mediaKinds}
        onClose={() => setLightboxId(null)}
        onNavigate={navigate}
      />

      <ConfirmDialog
        open={retireTarget !== null}
        onOpenChange={closeRetire}
        title="移除这张图片？"
        description={
          retireTarget
            ? `「${retireTarget.name}」会从产品图库移除并进入存档（可恢复）。已引用它的单证不会自动改，需要重新选图。`
            : undefined
        }
        confirmLabel="移除"
        pending={retire.isPending}
        error={retireError}
        onConfirm={() => {
          if (!retireTarget) return;
          retire.mutate(retireTarget.id, {
            onSuccess: () => {
              toast.success("已移除（存档保留，可恢复）");
              setRetireTarget(null);
            },
            onError: (err) => setRetireError(actionError(err, "移除失败")),
          });
        }}
      />
    </SectionCard>
  );
}

function MediaCard({
  media,
  position,
  kindLabel,
  onOpen,
  onRequestRemove,
}: {
  media: ProductMedia;
  position: number;
  kindLabel: string;
  onOpen: () => void;
  onRequestRemove: () => void;
}) {
  const url = useFileObjectUrl(media.id);
  const patch = usePatchFile();
  /**
   * 草稿 = 「基于哪个服务端名称改的」+「改成什么」。
   *
   * 为什么不用 `useState(name)` + `useEffect` 同步：那样要么在 effect 里 setState
   * （级联渲染，eslint 也会告警），要么得自己处理"用户正在打字时服务端名字变了"。
   * 这里把基准名一起存下来，**纯派生**：服务端名字一变，草稿自动作废回到服务端值，
   * 改名成功后也不会出现"输入框里还留着旧草稿"。
   */
  const [edit, setEdit] = useState<{ base: string; value: string } | null>(null);
  const draft = edit && edit.base === media.name ? edit.value : media.name;

  const trimmed = draft.trim();
  const dirty = trimmed !== media.name;
  const nameError = validateMediaName(draft);

  const submitName = () => {
    if (!dirty) return;
    if (nameError) {
      toast.error(nameError);
      return;
    }
    patch.mutate(
      { id: media.id, name: trimmed },
      {
        onSuccess: () => toast.success("已改名"),
        onError: (err) => {
          toast.error(actionError(err, "改名失败"));
          setEdit(null);
        },
      },
    );
  };

  const setPrimary = () => {
    patch.mutate(
      { id: media.id, is_primary: true },
      {
        onSuccess: () => toast.success("已设为主图（固定排第一位）"),
        onError: (err) => toast.error(actionError(err, "设置失败")),
      },
    );
  };

  const copyLink = async () => {
    try {
      const directUrl = await fetchFileDirectUrl(media.id);
      if (!directUrl) {
        toast.error("这张图暂不支持复制链接（未配置对象存储）");
        return;
      }
      await navigator.clipboard.writeText(directUrl);
      toast.success("已复制图片链接（15 分钟内有效）");
    } catch (err) {
      toast.error(actionError(err, "复制失败，请检查浏览器剪贴板权限"));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card">
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`查看大图 ${media.name}`}
          className="block aspect-[4/3] w-full overflow-hidden bg-muted/30"
        >
          {url.data ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url.data}
              alt={media.name}
              className="size-full object-cover transition-transform duration-200 hover:scale-[1.03]"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-xs text-muted-foreground">
              {url.isError ? "读取失败" : "加载中…"}
            </span>
          )}
        </button>

        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-background/85 px-1.5 py-0.5 text-[11px] font-medium tabular-nums shadow-sm backdrop-blur-sm">
          #{position}
        </span>

        {media.is_primary && (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-0.5 rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground shadow-sm">
            <Star className="size-3 fill-current" aria-hidden />
            主图
          </span>
        )}

        <SortableGrip
          className="absolute right-1.5 top-1.5 z-10 inline-flex size-8 cursor-grab touch-none items-center justify-center rounded-md bg-background/85 text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          label={
            media.is_primary
              ? "主图固定第一位（换主图请点下方星标）"
              : `拖动排序 ${media.name}`
          }
        />
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <div className="flex items-center gap-1">
          <Input
            className="h-7 text-xs"
            value={draft}
            maxLength={MEDIA_NAME_MAX}
            aria-label={`图片名称 ${media.name}`}
            aria-invalid={dirty && nameError !== null ? true : undefined}
            onChange={(e) => setEdit({ base: media.name, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitName();
              } else if (e.key === "Escape") {
                setEdit(null);
              }
            }}
          />
          {dirty && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="保存名称"
              title="保存名称（Enter）"
              disabled={patch.isPending || nameError !== null}
              onClick={submitName}
            >
              <Check aria-hidden />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="truncate rounded bg-muted px-1">{kindLabel}</span>
          {media.file_size ? (
            <span className="ml-auto shrink-0 tabular-nums">
              {formatBytes(media.file_size)}
            </span>
          ) : null}
        </div>

        <div className="mt-auto flex items-center gap-0.5">
          {media.is_primary ? (
            <span
              className="inline-flex size-7 items-center justify-center text-primary"
              title="当前主图"
            >
              <Star className="size-4 fill-current" aria-hidden />
              <span className="sr-only">当前主图</span>
            </span>
          ) : (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`把 ${media.name} 设为主图`}
              title="设为主图（固定排第一位）"
              disabled={patch.isPending}
              onClick={setPrimary}
            >
              <Star aria-hidden />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`复制 ${media.name} 的图片链接`}
            title="复制图片直链（15 分钟内有效）"
            onClick={() => void copyLink()}
          >
            <Link2 aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`移除 ${media.name}`}
            title="移除（存档保留，可恢复）"
            onClick={onRequestRemove}
          >
            <Trash2 aria-hidden />
          </Button>
          {patch.isPending && (
            <span className="ml-auto text-[11px] text-muted-foreground">保存中…</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 大图查看（←/→ 翻页、Esc 关闭）。
 *
 * 为什么不用新标签页打开直链：图片要 Bearer 鉴权，直链只有 15 分钟且需要对象存储；
 * 页面内看大图是唯一在所有部署形态下都成立的方案。
 */
function MediaLightbox({
  items,
  index,
  kindLabels,
  onClose,
  onNavigate,
}: {
  items: ProductMedia[];
  index: number;
  kindLabels: Record<string, string>;
  onClose: () => void;
  onNavigate: (delta: number) => void;
}) {
  const current = index >= 0 ? items[index] : undefined;
  const url = useFileObjectUrl(current?.id ?? null);

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onNavigate(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onNavigate(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, onNavigate]);

  const kindLabel = current
    ? kindLabels[current.media_kind ?? "other"] ?? current.media_kind ?? "其它"
    : "";

  return (
    <Dialog open={Boolean(current)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/70 backdrop-blur-sm"
        className="max-w-[min(96vw,64rem)] gap-0 overflow-hidden p-0 ring-foreground/20 sm:max-w-[min(96vw,64rem)]"
      >
        <DialogTitle className="sr-only">{current?.name ?? "图片预览"}</DialogTitle>

        <div className="relative flex min-h-0 items-center justify-center bg-muted/40 p-2">
          {url.data && current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url.data}
              alt={current.name}
              className="max-h-[74vh] w-auto max-w-full object-contain"
            />
          ) : (
            <span className="py-24 text-sm text-muted-foreground">
              {url.isError ? "图片读取失败" : "加载中…"}
            </span>
          )}

          {items.length > 1 && (
            <>
              <Button
                size="icon-lg"
                variant="secondary"
                className="absolute left-2 top-1/2 -translate-y-1/2"
                aria-label="上一张"
                title="上一张（←）"
                onClick={() => onNavigate(-1)}
              >
                <ChevronLeft aria-hidden />
              </Button>
              <Button
                size="icon-lg"
                variant="secondary"
                className="absolute right-2 top-1/2 -translate-y-1/2"
                aria-label="下一张"
                title="下一张（→）"
                onClick={() => onNavigate(1)}
              >
                <ChevronRight aria-hidden />
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs">
          <span className="font-medium">{current?.name}</span>
          <span className="rounded bg-muted px-1 text-muted-foreground">{kindLabel}</span>
          <span className="tabular-nums text-muted-foreground">
            {index + 1} / {items.length}
          </span>
          {current?.file_size ? (
            <span className="tabular-nums text-muted-foreground">
              {formatBytes(current.file_size)}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <X className="mr-1 size-3.5" aria-hidden />
            关闭（Esc）
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
