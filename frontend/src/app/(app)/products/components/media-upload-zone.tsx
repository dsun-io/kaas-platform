"use client";

/**
 * 产品图上传区：拖拽 / 点击 / 粘贴三入口 + 待传队列 + 逐张进度 + 失败重试。
 *
 * 为什么要队列而不是"一次一张填表单"（2026-10-22 用户反馈：原交互反人类）：
 * 原实现是「选类型 → 起名 → 选文件 → 点上传」×N 张，且名称是前置必填。
 * 现在：文件先进队列（本地缩略图、名称默认取文件名、类型可批量改），
 * 用户确认后一次传完；名称上传后仍可在卡片上改，所以**不再**卡在上传前。
 *
 * 几个刻意的取舍：
 * - **校验前置**：不合规的文件也进队列，但标红并写明原因（而不是静默丢弃）——
 *   用户至少知道"这张没传上去、因为什么"。
 * - **串行上传**：一次一张。并发会让弱网下的进度条互相打架，也让"第几张失败"说不清；
 *   产品图一次十来张，串行慢不了多少。
 * - **失败可单独重试**：已成功的不会重传（字节已经落库，重传只会产生重复对象）。
 * - **上传完才汇总提示**：成功 X 张 / 失败 Y 张，失败项留在队列里等重试。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ImagePlus, Loader2, RotateCw, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUploadProductMedia } from "@/lib/products/use-products";

import {
  MEDIA_ACCEPT,
  MEDIA_MAX_BYTES,
  MEDIA_NAME_MAX,
  defaultMediaName,
  formatBytes,
  resolveMediaContentType,
  validateMediaFile,
  validateMediaName,
} from "../media-validation";
import { uploadErrorMessage } from "../upload-errors";

type QueueStatus = "ready" | "invalid" | "uploading" | "done" | "error";

interface QueueItem {
  /** 本地唯一 id（文件没有 id，别用 index——删中间一项就串位） */
  key: string;
  file: File;
  name: string;
  mediaKind: string;
  /** 本地预览 objectURL（组件卸载/移除时必须 revoke） */
  preview: string;
  status: QueueStatus;
  progress: number | null;
  /** invalid / error 的原因，直接显示在行内 */
  reason?: string;
}

let seq = 0;
const nextKey = () => `q${++seq}`;

export function MediaUploadZone({
  productKey,
  mediaKinds,
  disabled,
}: {
  productKey: string;
  mediaKinds: Record<string, string>;
  disabled?: boolean;
}) {
  const upload = useUploadProductMedia(productKey);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [kind, setKind] = useState("production");
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  /** 直传回退到服务端代理的真相：整批只提示一次，别每张都弹 */
  const fallbackNotified = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // objectURL 是手动内存管理：卸载时统一回收，避免长页面累积
  useEffect(() => {
    return () => {
      setQueue((prev) => {
        prev.forEach((item) => URL.revokeObjectURL(item.preview));
        return prev;
      });
    };
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const items: QueueItem[] = list.map((file) => {
        const reject = validateMediaFile(file);
        return {
          key: nextKey(),
          file,
          name: defaultMediaName(file.name),
          mediaKind: kind,
          preview: URL.createObjectURL(file),
          status: reject ? "invalid" : "ready",
          progress: null,
          reason: reject?.message,
        };
      });
      setQueue((prev) => [...prev, ...items]);
      const invalid = items.filter((i) => i.status === "invalid").length;
      if (invalid > 0) {
        toast.error(
          `${invalid} 个文件不符合要求（${formatBytes(MEDIA_MAX_BYTES)} 以内的 PNG/JPG/WebP），已在队列中标红`,
        );
      }
    },
    [kind],
  );

  // 粘贴截图：只在焦点不在输入框时接管，避免把"粘贴到名称框"抢走
  useEffect(() => {
    if (disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles, disabled]);

  const pending = useMemo(
    () => queue.filter((i) => i.status === "ready" || i.status === "error"),
    [queue],
  );

  const patchItem = useCallback((key: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

  const removeItem = useCallback((key: string) => {
    setQueue((prev) => {
      const target = prev.find((i) => i.key === key);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((i) => i.key !== key);
    });
  }, []);

  /** 传一张（供首次上传与单张重试共用） */
  const uploadOne = useCallback(
    async (item: QueueItem): Promise<boolean> => {
      const nameError = validateMediaName(item.name);
      if (nameError) {
        patchItem(item.key, { status: "error", reason: nameError });
        return false;
      }
      patchItem(item.key, { status: "uploading", progress: 0, reason: undefined });
      try {
        const result = await upload.mutateAsync({
          file: item.file,
          name: item.name.trim(),
          mediaKind: item.mediaKind,
          contentType: resolveMediaContentType(item.file) ?? undefined,
          onProgress: (p) => patchItem(item.key, { progress: p.percent }),
        });
        patchItem(item.key, { status: "done", progress: 100 });
        if (result.fellBackToProxy && result.fallbackReason && !fallbackNotified.current) {
          fallbackNotified.current = true;
          // 不弹 modal：这是运维信息，不是用户错误。但必须说出来——
          // 否则"对象存储配错了、所有图都在经服务端中转"永远没人发现。
          toast.warning("本次上传走了服务端中转（对象存储直传未生效）", {
            description: result.fallbackReason,
          });
        }
        return true;
      } catch (err) {
        patchItem(item.key, {
          status: "error",
          progress: null,
          reason: uploadErrorMessage(err),
        });
        return false;
      }
    },
    [patchItem, upload],
  );

  const startUpload = useCallback(async () => {
    if (running) return;
    const targets = queue.filter(
      (i) => i.status === "ready" || i.status === "error",
    );
    if (targets.length === 0) return;
    setRunning(true);
    let ok = 0;
    let failed = 0;
    for (const item of targets) {
      const success = await uploadOne(item);
      if (success) ok += 1;
      else failed += 1;
    }
    setRunning(false);
    // 成功的行从队列里清掉（图已经出现在下方图库），失败的留着等重试
    setQueue((prev) => {
      prev
        .filter((i) => i.status === "done")
        .forEach((i) => URL.revokeObjectURL(i.preview));
      return prev.filter((i) => i.status !== "done");
    });
    if (ok > 0 && failed === 0) toast.success(`已上传 ${ok} 张`);
    else if (ok > 0 && failed > 0)
      toast.error(`上传完成：成功 ${ok} 张，失败 ${failed} 张（失败项可单独重试）`);
    else if (failed > 0) toast.error(`上传失败 ${failed} 张，原因见队列`);
  }, [queue, running, uploadOne]);

  const clearQueue = useCallback(() => {
    setQueue((prev) => {
      prev.forEach((i) => URL.revokeObjectURL(i.preview));
      return [];
    });
  }, []);

  return (
    <div className="mb-4 space-y-3">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="添加产品图片：点击选择文件、拖拽图片到这里，或按 Ctrl+V 粘贴"
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
        }}
        className={[
          "cursor-pointer rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border bg-muted/20 hover:bg-muted/40",
          disabled ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        <ImagePlus className="mx-auto mb-2 size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">拖拽图片到这里，或点击选择文件</p>
        <p className="mt-1 text-xs text-muted-foreground">
          支持 PNG / JPG / WebP，单张不超过 {formatBytes(MEDIA_MAX_BYTES)}，可多选；
          Ctrl+V 可直接粘贴截图
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={MEDIA_ACCEPT}
          disabled={disabled}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            // 清空 value：同一文件再选一次也要触发 change
            e.target.value = "";
          }}
        />
      </div>

      {queue.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              待上传 {pending.length} 张
            </span>
            <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              类型（应用到新加入的图片）
              <select
                className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                value={kind}
                disabled={disabled || running}
                onChange={(e) => {
                  const next = e.target.value;
                  setKind(next);
                  // 未开始的项跟随批量选择；已开始/已完成的保持原类型
                  setQueue((prev) =>
                    prev.map((i) =>
                      i.status === "ready" || i.status === "invalid"
                        ? { ...i, mediaKind: next }
                        : i,
                    ),
                  );
                }}
              >
                {Object.entries(mediaKinds).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <ul className="space-y-2">
            {queue.map((item) => (
              <li
                key={item.key}
                className={[
                  "flex items-center gap-3 rounded-md border px-2 py-2",
                  item.status === "invalid" || item.status === "error"
                    ? "border-destructive/40"
                    : "",
                ].join(" ")}
              >
                {/* 本地预览：上传前就能看清传的是哪张 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.preview}
                  alt={item.name}
                  className="size-11 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <Input
                    className="h-8 text-xs"
                    value={item.name}
                    maxLength={MEDIA_NAME_MAX}
                    aria-label="图片名称"
                    disabled={disabled || item.status === "uploading"}
                    onChange={(e) => patchItem(item.key, { name: e.target.value })}
                  />
                  {item.status === "uploading" ? (
                    <div
                      className="h-1 overflow-hidden rounded bg-muted"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={item.progress ?? undefined}
                    >
                      <div
                        className="h-full rounded bg-primary transition-[width]"
                        style={{
                          width: item.progress === null ? "30%" : `${item.progress}%`,
                        }}
                      />
                    </div>
                  ) : (
                    <p
                      className={[
                        "truncate text-[11px]",
                        item.status === "invalid" || item.status === "error"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      ].join(" ")}
                    >
                      {item.status === "invalid" || item.status === "error" ? (
                        <span className="inline-flex items-center gap-1">
                          <AlertCircle className="size-3" aria-hidden />
                          {item.reason ?? "上传失败"}
                        </span>
                      ) : (
                        `${formatBytes(item.file.size)} · ${item.file.name}`
                      )}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <select
                    className="h-7 rounded-md border border-input bg-background px-1 text-xs"
                    aria-label="图片类型"
                    value={item.mediaKind}
                    disabled={disabled || item.status === "uploading"}
                    onChange={(e) =>
                      patchItem(item.key, { mediaKind: e.target.value })
                    }
                  >
                    {Object.entries(mediaKinds).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {item.status === "uploading" ? (
                    <span className="w-9 text-right text-xs text-muted-foreground">
                      {item.progress === null ? "…" : `${item.progress}%`}
                    </span>
                  ) : item.status === "error" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={disabled || running}
                      onClick={() => void uploadOne(item)}
                    >
                      <RotateCw className="mr-1 size-3.5" aria-hidden />
                      重试
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    aria-label={`移出队列 ${item.name}`}
                    disabled={disabled || item.status === "uploading"}
                    onClick={() => removeItem(item.key)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              上传前可改名称与类型；成功后图片进入下方图库
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={running}
                onClick={clearQueue}
              >
                清空队列
              </Button>
              <Button
                size="sm"
                disabled={disabled || running || pending.length === 0}
                onClick={() => void startUpload()}
              >
                {running ? (
                  <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                ) : (
                  <Upload className="mr-1 size-4" aria-hidden />
                )}
                {running ? "上传中…" : `开始上传 (${pending.length})`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
