"use client";

import { LoadingBlock } from "@/components/shared/loading-block";

/**
 * 产品工位 · tab「图片与基础信息」（P14 行为等价搬入）
 *
 * 本组件的内容与搬家前 `frontend/src/app/(app)/products/page.tsx` 逐项一致
 * （列表、选中态、基础信息表单、上传/命名/分类/排序/主图/下线/直链）。
 * 搬家只换外壳（tab 容器），**不改任何读写行为**：
 *   · 数据层仍走 `@/lib/products/use-products`（一行未动）
 *   · JSON 文本框不存在于本 tab，规格 JSONB 属另一 tab（`ProductsDefinitionsTab`）
 *   · 不引入 Axis 相关字段（三产品 `axes` 全为空列表）
 */
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ImagePlus,
  Link2,
  Package,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  fetchFileDirectUrl,
  useFileObjectUrl,
  usePatchFile,
  useProductMedia,
  useProductProfile,
  useProducts,
  useReorderProductMedia,
  useRetireFile,
  useSaveProductProfile,
  useUploadProductMedia,
  type ProductMedia,
} from "@/lib/products/use-products";

/** 基础信息字段（存进 product_profiles.info，键名稳定、可被单证/报价引用） */
const PROFILE_FIELDS: [string, string, string][] = [
  ["material", "材质", "如：低碳钢丝 / 镀锌丝"],
  ["surface", "表面处理", "如：热镀锌 / 电镀锌 / PVC 浸塑"],
  ["usage", "用途", "如：围栏 / 养殖 / 边坡防护"],
  ["hs_code", "HS 编码", "如：7314.41.00"],
  ["packing", "包装", "如：编织袋 + 钢带 / 裸装"],
  ["origin", "产地", "如：河北安平"],
];

const MEDIA_KIND_FALLBACK: Record<string, string> = {
  production: "生产图片",
  size: "尺寸图片",
  weight: "重量图片",
  finished: "成品图片",
  other: "其它",
};

export function ProductsMediaTab() {
  const products = useProducts();
  const [selected, setSelected] = useState<string | null>(null);
  const mediaKinds = products.data?.media_kinds ?? MEDIA_KIND_FALLBACK;

  const media = useProductMedia(selected);
  const profile = useProductProfile(selected);
  const saveProfile = useSaveProductProfile(selected ?? "");
  const upload = useUploadProductMedia(selected ?? "");
  const reorder = useReorderProductMedia();

  const [info, setInfo] = useState<Record<string, string>>({});
  const [kind, setKind] = useState("production");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    const raw = (profile.data?.info ?? {}) as Record<string, unknown>;
    setInfo(
      Object.fromEntries(
        PROFILE_FIELDS.map(([k]) => [k, raw[k] == null ? "" : String(raw[k])]),
      ),
    );
  }, [profile.data]);

  const items = products.data?.items ?? [];
  const current = useMemo(
    () => items.find((p) => p.product_key === selected) ?? null,
    [items, selected],
  );

  const mediaItems = media.data?.items ?? [];
  // 主图恒排最前（服务端 ORDER BY is_primary DESC, sort_order, id）：
  // 把别的图"上移"到主图之前只是个视觉假动作（重新加载后主图又回到第一），
  // 所以第二张图在主图存在时不允许上移。
  const firstIsPrimary = Boolean(mediaItems[0]?.is_primary);

  /**
   * 上/下移：交换展示顺序里相邻的两张，然后把**整个顺序**压成 0..n-1 落库。
   *
   * 为什么不只改这两张图的 `sort_order`：新上传的图都是默认 0，
   * 交换两个 0 等于没动 —— 整体重排一次才能把顺序固化下来。
   * 只对位次真的变了的图发 PATCH；任何一条失败都提示用户（不静默）。
   */
  const moveMedia = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= mediaItems.length) return;
    const next = [...mediaItems];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);

    const patches: { id: number; sort_order: number }[] = [];
    next.forEach((m, i) => {
      if (m.sort_order !== i) patches.push({ id: m.id, sort_order: i });
    });
    reorder.mutate(patches, {
      onSuccess: () => toast.success("顺序已更新"),
      onError: () => toast.error("排序失败，请重试"),
    });
  };

  const doUpload = async () => {
    if (!file) return toast.error("先选一张图");
    if (!name.trim())
      return toast.error("给图片起个名字（要求：上传后可命名）");
    try {
      const uploaded = await upload.mutateAsync({
        file,
        name: name.trim(),
        mediaKind: kind,
      });
      // 直传失败但**服务端代理兜底成功**时，上传是成功 —— 但必须如实说出来：
      // 否则"对象存储配错了、所有图都在经服务端中转"永远没人发现（直传路径形同废弃）。
      const fallbackReason = uploaded.fallbackReason || "原因未知";
      toast.success(
        uploaded.fellBackToProxy
          ? `已上传（直传失败：${fallbackReason}；已走服务端兜底）`
          : "已上传",
      );
      setName("");
      setFile(null);
    } catch {
      toast.error("上传失败（类型/大小/命名不合规时后端会明确拒绝）");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="产品管理"
        description="维护产品的基础信息与图片（生产/尺寸/重量/成品）。单证直接引用这里的图片 —— 一次维护，重复使用。"
      />

      <SectionCard
        title="产品"
        description="产品来自产品模块的注册表（勾花网 / 牛栏网 / 鹿网），这里维护图片与基础信息。"
      >
        {products.isLoading ? (
          <LoadingBlock rows={3} className="py-6" />
        ) : products.isError ? (
          <p className="py-6 text-center text-sm text-destructive">
            读取产品列表失败。
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Package}
            title="没有产品"
            description="产品定义在产品模块中维护。"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {items.map((p) => (
              <button
                key={p.product_key}
                type="button"
                onClick={() => setSelected(p.product_key)}
                className={`rounded-md border p-3 text-left transition hover:bg-muted/40 ${
                  selected === p.product_key ? "border-primary bg-muted/40" : ""
                }`}
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">
                  {p.name_en || "（未填英文名）"}
                  {p.category_code ? ` · ${p.category_code}` : ""}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  图片 {p.media_count} 张
                  {typeof p.profile?.hs_code === "string" && p.profile.hs_code
                    ? ` · HS ${p.profile.hs_code}`
                    : ""}
                  {Object.keys(p.profile ?? {}).length > 0
                    ? " · 已填基础信息"
                    : ""}
                </div>
              </button>
            ))}
          </div>
        )}
      </SectionCard>

      {selected && (
        <>
          <SectionCard
            title={`基础信息 · ${current?.name ?? selected}`}
            description="存进 product_profiles（租户级），不改产品规格定义本身。"
            action={
              <Button
                size="sm"
                disabled={saveProfile.isPending}
                onClick={() =>
                  saveProfile.mutate(info, {
                    onSuccess: () => toast.success("已保存"),
                    onError: () => toast.error("保存失败"),
                  })
                }
              >
                <Save className="mr-1 h-4 w-4" />
                {saveProfile.isPending ? "保存中…" : "保存"}
              </Button>
            }
          >
            <div className="grid gap-3 sm:grid-cols-3">
              {PROFILE_FIELDS.map(([key, label, placeholder]) => (
                <label key={key} className="space-y-1">
                  <span className="text-sm font-medium">{label}</span>
                  <Input
                    value={info[key] ?? ""}
                    placeholder={placeholder}
                    onChange={(e) =>
                      setInfo((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
          </SectionCard>

          <SectionCard
            title="产品图片"
            description="先选类型（生产/尺寸/重量/成品），上传后给它命名。同一类型可以多张；单证直接引用这些图。"
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
                  placeholder="如：勾花网 2m×20m 侧面尺寸图"
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
              <Button disabled={upload.isPending} onClick={doUpload}>
                <ImagePlus className="mr-1 h-4 w-4" />
                {upload.isPending ? "上传中…" : "上传"}
              </Button>
            </div>

            {media.isLoading ? (
              <LoadingBlock rows={3} className="py-6" />
            ) : mediaItems.length === 0 ? (
              <EmptyState
                icon={ImagePlus}
                title="还没有图片"
                description="上传生产图 / 尺寸图 / 重量图 / 成品图，命名后单证即可直接引用。"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {mediaItems.map((m, i) => (
                  <MediaCard
                    key={m.id}
                    media={m}
                    position={i + 1}
                    kindLabel={
                      mediaKinds[m.media_kind ?? "other"] ??
                      m.media_kind ??
                      "其它"
                    }
                    canMoveUp={i > 0 && !(firstIsPrimary && i === 1)}
                    canMoveDown={i < mediaItems.length - 1}
                    moving={reorder.isPending}
                    onMoveUp={() => moveMedia(i, -1)}
                    onMoveDown={() => moveMedia(i, 1)}
                  />
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
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
    <div className="rounded-md border p-2">
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
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1">{kindLabel}</span>
        <span className="rounded bg-muted px-1" title="当前展示位次">
          #{position}
        </span>
        {media.is_primary && (
          <span className="flex items-center gap-0.5 rounded bg-primary/10 px-1 text-primary">
            <Star className="h-3 w-3" /> 主图
          </span>
        )}
        <span className="ml-auto">{media.storage}</span>
      </div>
      <Input
        className="mt-2 h-8 text-xs"
        value={name}
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
          aria-label={`上移 ${media.name}`}
          title={canMoveUp ? "上移" : "主图恒排最前，不能移到它前面"}
          disabled={!canMoveUp || moving}
          onClick={onMoveUp}
        >
          <ArrowUp className="mr-1 h-3.5 w-3.5" />
          上移
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`下移 ${media.name}`}
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
          disabled={retire.isPending}
          onClick={() =>
            retire.mutate(media.id, {
              onSuccess: () => toast.success("已下线（存档保留，可回溯）"),
              onError: () => toast.error("下线失败"),
            })
          }
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          下线
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            // 短时效直链（预签名 GET），给货代/客户看大图或下载，不必登录我们的系统
            const directUrl = await fetchFileDirectUrl(media.id);
            if (!directUrl) {
              toast.error("该文件不在对象存储里（可能是回退落库的旧文件）");
              return;
            }
            await navigator.clipboard.writeText(directUrl);
            toast.success("已复制短时效直链（默认 15 分钟有效）");
          }}
        >
          <Link2 className="mr-1 h-3.5 w-3.5" />
          直链
        </Button>
      </div>
    </div>
  );
}
