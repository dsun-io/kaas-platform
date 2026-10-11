"use client";

/**
 * 产品管理（产品图 + 基础信息）
 *
 * 用户要求（原话）：
 *   「产品图片可以在产品管理页面添加，可以添加各种类型的图片（生产/尺寸/重量/成品）；
 *    上传图片以后，有一个输入框可以给图片命名；还可以添加产品的一些基础信息。
 *    单证直接调用产品管理页面的图片，就行。这样就做到了一次维护，重复使用，一劳永逸。」
 *
 * 设计要点
 * --------
 * - 产品清单来自**代码里的 ProductSpec**（勾花网/牛栏网/鹿网），页面不新建产品主数据 ——
 *   避免"两套真相"（规格定义仍以产品模块为准）。
 * - 图片按**类型**归类（生产/尺寸/重量/成品）+ **用户命名**；同一类型**可以多张**
 *   （不同角度/批次本就该并存），只有"主图"唯一。
 * - 右边概览里的图片数即单证可引用的库存：单证**引用**这些图，改一次全同步。
 */
import { useEffect, useMemo, useState } from "react";
import { ImagePlus, Link2, Package, Save, Star, Trash2 } from "lucide-react";
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

export default function ProductsPage() {
  const products = useProducts();
  const [selected, setSelected] = useState<string | null>(null);
  const mediaKinds = products.data?.media_kinds ?? MEDIA_KIND_FALLBACK;

  const media = useProductMedia(selected);
  const profile = useProductProfile(selected);
  const saveProfile = useSaveProductProfile(selected ?? "");
  const upload = useUploadProductMedia(selected ?? "");

  const [info, setInfo] = useState<Record<string, string>>({});
  const [kind, setKind] = useState("production");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    const raw = (profile.data?.info ?? {}) as Record<string, unknown>;
    setInfo(Object.fromEntries(PROFILE_FIELDS.map(([k]) => [k, raw[k] == null ? "" : String(raw[k])])));
  }, [profile.data]);

  const items = products.data?.items ?? [];
  const current = useMemo(
    () => items.find((p) => p.product_key === selected) ?? null,
    [items, selected],
  );

  const doUpload = async () => {
    if (!file) return toast.error("先选一张图片");
    if (!name.trim()) return toast.error("给图片起个名字（要求：上传后可命名）");
    try {
      await upload.mutateAsync({ file, name: name.trim(), mediaKind: kind });
      toast.success("已上传");
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

      <SectionCard title="产品" description="产品来自产品模块的注册表（勾花网 / 牛栏网 / 鹿网），这里维护图片与基础信息。">
        {products.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
        ) : products.isError ? (
          <p className="py-6 text-center text-sm text-destructive">读取产品列表失败。</p>
        ) : items.length === 0 ? (
          <EmptyState icon={Package} title="没有产品" description="产品定义在产品模块中维护。" />
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
                  {p.product_key}
                  {p.category_code ? ` · ${p.category_code}` : ""}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  图片 {p.media_count} 张
                  {Object.keys(p.profile ?? {}).length > 0 ? " · 已填基础信息" : ""}
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
                    onChange={(e) => setInfo((prev) => ({ ...prev, [key]: e.target.value }))}
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
              <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
            ) : (media.data?.items ?? []).length === 0 ? (
              <EmptyState
                icon={ImagePlus}
                title="还没有图片"
                description="上传生产图 / 尺寸图 / 重量图 / 成品图，命名后单证即可直接引用。"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {(media.data?.items ?? []).map((m) => (
                  <MediaCard
                    key={m.id}
                    media={m}
                    kindLabel={mediaKinds[m.media_kind ?? "other"] ?? m.media_kind ?? "其它"}
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

function MediaCard({ media, kindLabel }: { media: ProductMedia; kindLabel: string }) {
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
          <span className="text-xs text-muted-foreground">{url.isError ? "读取失败" : "加载中…"}</span>
        )}
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1">{kindLabel}</span>
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
            patch.mutate({ id: media.id, name: name.trim() }, {
              onSuccess: () => toast.success("已改名"),
              onError: () => toast.error("改名失败"),
            });
          }
        }}
      />
      <div className="mt-2 flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={media.is_primary || patch.isPending}
          onClick={() =>
            patch.mutate({ id: media.id, is_primary: true }, {
              onSuccess: () => toast.success("已设为主图"),
              onError: () => toast.error("设置失败"),
            })
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
              onSuccess: () => toast.success("已下线（行档保留，可回溯）"),
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
            // 短时效直链（预签名 GET）：给货代/客户看大图或下载，不必登录我们的系统
            const url = await fetchFileDirectUrl(media.id);
            if (!url) {
              toast.error("该文件不在对象存储里（可能是回退落库的旧文件）");
              return;
            }
            await navigator.clipboard.writeText(url);
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
