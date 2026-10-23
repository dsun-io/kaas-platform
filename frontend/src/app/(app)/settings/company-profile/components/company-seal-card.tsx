"use client";

import { LoadingBlock } from "@/components/shared/loading-block";

/**
 * 公司公章（设置 → 企业信息）
 *
 * 为什么必须配：PI / 合同 / 装箱单的签章区要盖公司公章（渲染字段 `company_stamp`）。
 * 公章是**图片资产**而不是文本配置 —— 后端两端（orchestrator `app/api/company_seals.py`、
 * worker `ws_seals.py`）接口早已就绪，但前端此前**没有任何上传入口**：
 * 生产 `tenant_company_seals` 一直是 0 行，用户根本传不了章，单据就永远出不来章。
 *
 * 接口逐字对齐后端（勿凭猜测）：
 *   POST   /tenant/company-seals              multipart：file + name + set_default(false)
 *   GET    /tenant/company-seals              列表（只回元数据 + preview_url，不回裸字节）
 *   GET    /tenant/company-seals/{id}/image   取 PNG（要 Bearer；`<img src>` 带不上 → blob→objectURL）
 *   PUT    /tenant/company-seals/{id}/default 设为默认（事务内先清后设，全局唯一）
 *   DELETE /tenant/company-seals/{id}         删除（默认章若还有别的章 → 后端 409 要求先转移默认）
 *
 * 后端铁律（2026-09-30 设计裁决）：**后端零图像库**，只收 PNG 字节 + 纯 Python 校验
 * （`kaas_common.trade_doc.validate_seal_image` 只认 PNG 魔数）。所以格式转换 / 白底透明 /
 * 裁白边必须由前端 Canvas 完成（见 `normalizeSealToPng`）—— 这不是降级逻辑，是接口契约。
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageOff, Loader2, Stamp, Star, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { ErrorState } from "@/components/shared/error-state";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { normalizeApiError } from "@/lib/api/api-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import apiClient from "@/lib/api/client";

/** 后端 `_to_meta()` 的字段（列表与上传/设默认的返回值同形）。 */
export interface CompanySeal {
  id: number;
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  is_default: boolean;
  created_by: string | null;
  created_at: string | null;
  preview_url: string;
}

const sealKeys = {
  list: ["company-seals"] as const,
  image: (id: number) => ["company-seals", "image", id] as const,
};

// ─── 数据层 ──────────────────────────────────────────────────────────────────

function useCompanySeals() {
  return useQuery({
    queryKey: sealKeys.list,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: CompanySeal[] }>(
        "/tenant/company-seals",
      );
      return data.items;
    },
  });
}

function useUploadCompanySeal(onError?: (error: unknown) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      blob: Blob;
      name: string;
      setDefault: boolean;
    }) => {
      const form = new FormData();
      form.append("file", input.blob, "seal.png");
      form.append("name", input.name);
      form.append("set_default", input.setDefault ? "true" : "false");
      const { data } = await apiClient.post<CompanySeal>(
        "/tenant/company-seals",
        form,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: sealKeys.list }),
    onError: (error) => onError?.(error),
  });
}

function useSetDefaultCompanySeal(onError?: (error: unknown) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await apiClient.put<CompanySeal>(
        `/tenant/company-seals/${id}/default`,
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: sealKeys.list }),
    onError: (error) => onError?.(error),
  });
}

function useDeleteCompanySeal(onError?: (error: unknown) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/tenant/company-seals/${id}`);
    },
    onSuccess: (_data, id) => {
      // 图字节跟着章一起没了，缓存一并清掉
      qc.removeQueries({ queryKey: sealKeys.image(id) });
      qc.invalidateQueries({ queryKey: sealKeys.list });
    },
    onError: (error) => onError?.(error),
  });
}

/**
 * 取章图字节 → objectURL。
 * `<img src>` 带不上 Authorization 头，只能先 axios 拉 blob（与 `useFileObjectUrl` 同做法）。
 */
function useSealObjectUrl(sealId: number) {
  return useQuery({
    queryKey: sealKeys.image(sealId),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const res = await apiClient.get(`/tenant/company-seals/${sealId}/image`, {
        responseType: "blob",
      });
      return URL.createObjectURL(res.data as Blob);
    },
  });
}

// ─── 图片归一化（后端只收 PNG） ───────────────────────────────────────────────

const NEAR_WHITE = 235; // ≥ 这个亮度视为纸底 → 透明
const ALPHA_FLOOR = 8; // 裁边时忽略接近全透明的噪点
const MAX_EDGE = 1600; // 章不需要更大；顺带把 PNG 体积压在 5MB 上限内
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // 个别格式/浏览器创建位图失败 → 回退 <img> 解码
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * 任意常见图片 → 透明底 PNG。
 * 三步：等比缩到 ≤1600px → 近白像素透明化（去掉纸底，盖章时不会出现白方块）→ 裁掉透明边。
 */
export async function normalizeSealToPng(file: File): Promise<Blob> {
  const decoded = await decodeImage(file);
  try {
    const scale = Math.min(
      1,
      MAX_EDGE / Math.max(decoded.width, decoded.height),
    );
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
    ctx.drawImage(decoded.source, 0, 0, width, height);

    let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
    let analyzed = false;
    try {
      const image = ctx.getImageData(0, 0, width, height);
      const px = image.data;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const alpha = px[i + 3] ?? 0;
          if (alpha <= ALPHA_FLOOR) continue;
          const r = px[i] ?? 0;
          const g = px[i + 1] ?? 0;
          const b = px[i + 2] ?? 0;
          if (r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE) {
            px[i + 3] = 0; // 纸底 → 透明
            continue;
          }
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      ctx.putImageData(image, 0, 0);
      analyzed = true;
      if (maxX >= minX && maxY >= minY) {
        box = { x0: minX, y0: minY, x1: maxX, y1: maxY };
      }
    } catch {
      // 像素读不出来（极少见）→ 不透明化也不裁边，仍按原图导出 PNG
      analyzed = false;
    }
    if (analyzed && !box) throw new Error("BLANK_IMAGE");

    const pad = 2; // 留 2px 余量，避免裁到印迹边缘
    const x0 = box ? Math.max(0, box.x0 - pad) : 0;
    const y0 = box ? Math.max(0, box.y0 - pad) : 0;
    const x1 = box ? Math.min(width - 1, box.x1 + pad) : width - 1;
    const y1 = box ? Math.min(height - 1, box.y1 + pad) : height - 1;

    const out = document.createElement("canvas");
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    const octx = out.getContext("2d");
    if (!octx) throw new Error("CANVAS_UNAVAILABLE");
    octx.drawImage(
      canvas,
      x0,
      y0,
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height,
    );

    const blob = await new Promise<Blob | null>((resolve) =>
      out.toBlob(resolve, "image/png"),
    );
    if (!blob || blob.size === 0) throw new Error("PNG_ENCODE_FAILED");
    return blob;
  } finally {
    decoded.dispose();
  }
}

function imageErrorMessage(err: unknown): string {
  const code = err instanceof Error ? err.message : "";
  if (code === "BLANK_IMAGE") {
    return "这张图找不到印章印迹（整张接近空白），请换一张。";
  }
  if (code === "CANVAS_UNAVAILABLE" || code === "PNG_ENCODE_FAILED") {
    return "浏览器无法转换这张图，请直接上传 PNG 文件。";
  }
  return "图片读取失败，请换一张 PNG / JPG 图片再试。";
}

function formatTime(iso: string | null): string {
  if (!iso) return "时间未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── 组件 ────────────────────────────────────────────────────────────────────

export function CompanySealCard({ canWrite = true }: { canWrite?: boolean }) {
  /** 上传/设默认/删除的失败原因（role=alert；apiClient 已 toast，这里不重复弹） */
  const [actionError, setActionError] = useState<string | null>(null);
  const reportActionError = (error: unknown) =>
    setActionError(normalizeApiError(error).message);

  const seals = useCompanySeals();
  const upload = useUploadCompanySeal(reportActionError);
  const setDefault = useSetDefaultCompanySeal(reportActionError);
  const remove = useDeleteCompanySeal(reportActionError);

  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [converting, setConverting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CompanySeal | null>(null);

  const items = seals.data ?? [];
  const defaultSeal = items.find((s) => s.is_default) ?? null;
  const busy = converting || upload.isPending;
  const mutatingId = setDefault.isPending
    ? setDefault.variables
    : remove.isPending
      ? remove.variables
      : null;

  const handleFile = async (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;

    const sealName = name.trim();
    if (!sealName) {
      toast.error("请先给公章起个名字（如：公章 / 财务章）");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      toast.error("图片超过 20MB，请先压缩或裁剪后再上传");
      return;
    }

    let png: Blob | null = null;
    setConverting(true);
    try {
      png = await normalizeSealToPng(file);
    } catch (err) {
      toast.error(imageErrorMessage(err));
      return;
    } finally {
      setConverting(false);
    }
    if (!png) return;
    if (png.size > MAX_UPLOAD_BYTES) {
      toast.error("转换后的图仍超过 5MB，请裁剪后再传");
      return;
    }

    setActionError(null);
    upload.mutate(
      { blob: png, name: sealName, setDefault: makeDefault },
      {
        onSuccess: (created) => {
          toast.success(
            created.is_default
              ? `已上传「${created.name}」，它是默认章 —— 单证签章区会自动盖这枚。`
              : `已上传「${created.name}」。`,
          );
          setName("");
          setMakeDefault(false);
        },
      },
    );
  };

  return (
    <>
      <SectionCard
        title="公司公章（单据签章区使用）"
        description="PI / 合同 / 装箱单的签章区盖的就是这里设为默认的那枚章。"
        action={
          seals.isSuccess ? (
            <StatusBadge tone={defaultSeal ? "success" : "warning"} dot>
              {defaultSeal ? `默认章：${defaultSeal.name}` : "还没有默认章"}
            </StatusBadge>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {/* 上传（仅内部账号可写：后端 ws_seals.py:46 只允许内部账号管理公章） */}
          {canWrite ? (
            <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-sm font-medium">公章名称（必填）</span>
                  <Input
                    value={name}
                    maxLength={50}
                    disabled={busy}
                    placeholder="公章 / 财务章 / 合同章"
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="flex items-start gap-2 text-sm sm:mt-6">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={makeDefault}
                    disabled={busy}
                    onChange={(e) => setMakeDefault(e.target.checked)}
                  />
                  <span>
                    上传后设为默认章
                    <span className="block text-xs text-muted-foreground">
                      首枚章会自动成为默认章；单据自动盖的就是默认章。
                    </span>
                  </span>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled={!name.trim() || busy}
                  onClick={() => inputRef.current?.click()}
                >
                  {busy ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-1 h-4 w-4" />
                  )}
                  {converting
                    ? "转换图片中…"
                    : upload.isPending
                      ? "上传中…"
                      : "选择图片并上传"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  支持 PNG / JPG / WebP / BMP；浏览器会自动转成透明底
                  PNG（≤5MB）
                </span>
                <input
                  ref={inputRef}
                  type="file"
                  aria-label="选择公章图片"
                  className="hidden"
                  accept="image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp"
                  onChange={(e) => {
                    void handleFile(e.target.files?.[0]);
                  }}
                />
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed bg-muted/20 p-4 text-xs text-muted-foreground">
              当前账号只能查看公章；上传 / 设默认 / 删除需要内部账号。
            </p>
          )}

          {actionError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {actionError}
            </p>
          ) : null}

          {/* 列表 */}
          {seals.isLoading ? (
            <LoadingBlock rows={3} className="py-6" />
          ) : seals.isError ? (
            <ErrorState
              title="公章列表读取失败"
              message={normalizeApiError(seals.error).message}
              onRetry={() => void seals.refetch()}
            />
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm">
              <p className="font-medium">还没有公章</p>
              <p className="mt-1 text-muted-foreground">
                没有公章时，PI / 合同 / 装箱单的签章区<b>不会盖章</b>
                ——
                客户收到的单据上没有公章。在上方上传第一枚即可（它会自动成为默认章）。
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {!defaultSeal && (
                <p className="text-sm text-destructive">
                  当前没有默认章 —— 单证不会盖章，请把下面其中一枚设为默认。
                </p>
              )}
              <ul className="space-y-2">
                {items.map((seal) => (
                  <SealRow
                    key={seal.id}
                    seal={seal}
                    busy={mutatingId === seal.id}
                    canWrite={canWrite}
                    onSetDefault={() => {
                      setActionError(null);
                      setDefault.mutate(seal.id, {
                        onSuccess: () =>
                          toast.success(
                            `已把「${seal.name}」设为默认章 —— 单证签章区会自动盖这枚。`,
                          ),
                      });
                    }}
                    onDelete={() => setPendingDelete(seal)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </SectionCard>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除公章「{pendingDelete?.name}」？</DialogTitle>
            <DialogDescription>
              删除后无法恢复，需要重新上传。
              {pendingDelete?.is_default
                ? " 它还是默认章，且还有其他公章 —— 请先把别的章设为默认，再回来删它（否则单据会突然没章可盖）。"
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => setPendingDelete(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (!pendingDelete) return;
                const target = pendingDelete;
                setActionError(null);
                remove.mutate(target.id, {
                  onSuccess: () => {
                    toast.success(`已删除「${target.name}」`);
                    setPendingDelete(null);
                  },
                });
              }}
            >
              {remove.isPending ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SealRow({
  seal,
  busy,
  canWrite,
  onSetDefault,
  onDelete,
}: {
  seal: CompanySeal;
  busy: boolean;
  canWrite: boolean;
  onSetDefault: () => void;
  onDelete: () => void;
}) {
  const image = useSealObjectUrl(seal.id);

  return (
    <li className="flex items-center gap-3 rounded-lg border bg-background p-3">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/30">
        {image.data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.data}
            alt={seal.name}
            className="max-h-16 w-auto max-w-16"
          />
        ) : image.isError ? (
          <ImageOff className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Stamp className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{seal.name}</span>
          {seal.is_default ? (
            <StatusBadge tone="success" dot>
              默认章 · 单据自动盖这枚
            </StatusBadge>
          ) : (
            <StatusBadge tone="default" dot>
              非默认
            </StatusBadge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {seal.width && seal.height
            ? `${seal.width}×${seal.height} px · `
            : ""}
          上传于 {formatTime(seal.created_at)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canWrite && !seal.is_default && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onSetDefault}
          >
            <Star className="mr-1 h-3.5 w-3.5" />
            设为默认
          </Button>
        )}
        {canWrite && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            删除
          </Button>
        )}
      </div>
    </li>
  );
}
