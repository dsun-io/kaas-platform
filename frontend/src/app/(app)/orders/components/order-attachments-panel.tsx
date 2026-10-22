"use client";

/**
 * 订单附件面板（§13.3）：合同 / PO / 信用证扫描件的列表 + 补传。
 *
 * 与正式单证的分工（用户拍板）：订单附件是**客户给的原件扫描件**，可随时补传；
 * 正式发票/装箱单仍在单证工位生成，两者不混在一起。
 *
 * 上传失败的兜底：附件与订单分离，上传失败不会让用户以为没建单 ——
 * 面板给出人话原因，可重试；本面板也是建单向导"附件没传成功"的补传入口。
 */
import { useState } from "react";
import { ExternalLink, Paperclip, Upload } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import apiClient from "@/lib/api/client";
import {
  attachmentDisplayName,
  formatFileSize,
  ORDER_ATTACHMENT_ACCEPT,
  ORDER_ATTACHMENT_KINDS,
  validateAttachmentFile,
} from "@/lib/orders/order-attachments";
import { formatOrderDate } from "@/lib/orders/order-detail";

import { useOrderFiles, useUploadOrderFile } from "../hooks/use-order-files";

export function OrderAttachmentsPanel({ orderId }: { orderId: number }) {
  const files = useOrderFiles(orderId);
  const upload = useUploadOrderFile(orderId);

  const [kind, setKind] = useState("contract");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) {
      setError("请选择要上传的文件（PDF / JPG / PNG）");
      return;
    }
    const reason = validateAttachmentFile(file);
    if (reason) {
      setError(reason);
      return;
    }
    setError(null);
    try {
      await upload.mutateAsync({
        file,
        name: attachmentDisplayName(kind, name, file.name),
      });
      toast.success("附件已上传");
      setName("");
      setFile(null);
    } catch {
      setError("附件上传失败：请确认文件格式/大小后重试（订单本身不受影响）。");
    }
  };

  const openFile = async (fileId: number) => {
    try {
      const res = await apiClient.get(`/file-objects/${fileId}/content`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data as Blob);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error("打开附件失败，请稍后重试");
    }
  };

  return (
    <SectionCard
      title="订单附件"
      description="合同 / PO / 信用证的扫描件；正式发票与装箱单请到单证工位生成。上传失败不影响订单，可在此重试。"
    >
      <div className="mb-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end">
        <label className="space-y-1">
          <span className="text-xs font-medium">附件类别</span>
          <select
            aria-label="附件类别"
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {ORDER_ATTACHMENT_KINDS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1">
          <Label htmlFor="order-attachment-name" className="text-xs">
            附件名称（可选）
          </Label>
          <Input
            id="order-attachment-name"
            value={name}
            placeholder="留空用文件名"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="order-attachment-file" className="text-xs">
            选择文件
          </Label>
          <Input
            id="order-attachment-file"
            type="file"
            accept={ORDER_ATTACHMENT_ACCEPT}
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              e.target.value = "";
              setFile(next);
              setError(null);
            }}
          />
        </div>
        <Button disabled={upload.isPending} onClick={() => void submit()}>
          <Upload className="mr-1 h-4 w-4" />
          {upload.isPending ? "上传中…" : "上传附件"}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-destructive sm:col-span-4">
            {error}
          </p>
        )}
      </div>

      {files.isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="附件加载中">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full rounded-md" />
          ))}
        </div>
      ) : files.isError ? (
        <div className="flex items-center gap-2 py-4 text-sm text-destructive">
          <Paperclip className="h-4 w-4" />
          附件读取失败。
          <Button size="sm" variant="outline" onClick={() => void files.refetch()}>
            重试
          </Button>
        </div>
      ) : (files.data ?? []).length === 0 ? (
        <EmptyState
          icon={Paperclip}
          title="还没有订单附件"
          description="把客户签回的合同、PO、信用证扫描件传上来，后续开单证不用再翻邮箱。"
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {(files.data ?? []).map((attachment) => (
            <li
              key={attachment.id}
              className="flex flex-wrap items-center gap-3 py-2 text-sm"
            >
              <Paperclip className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={attachment.name}>
                {attachment.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {attachment.content_type ?? ""}
                {typeof attachment.size === "number"
                  ? ` · ${formatFileSize(attachment.size)}`
                  : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatOrderDate(attachment.created_at)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void openFile(attachment.id)}
                aria-label={`打开附件 ${attachment.name}`}
              >
                <ExternalLink className="mr-1 size-3.5" />
                打开
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
