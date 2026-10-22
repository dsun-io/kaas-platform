"use client";

/**
 * 订单「已导入单证」面板（§13.3 追加需求）。
 *
 * 展示直接建单时导入的 / 后续补导入的**已有单证**（合同、PO、发票、装箱单、
 * 原产地证…）。这些单证进 `external_doc_uploads` 台账，可下载；
 * 与「订单附件」是两回事（附件走 file_objects，是随单文件），所以分两个面板展示。
 */
import { useState } from "react";
import { Download, FileText, Upload } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EXTERNAL_DOC_ACCEPT,
  EXTERNAL_DOC_TYPES,
  externalDocTypeLabel,
  formatExternalDocSize,
  validateExternalDocFile,
} from "@/lib/orders/external-docs";
import { formatOrderDate } from "@/lib/orders/order-detail";

import {
  fetchExternalDocBlob,
  useExternalDocs,
  useUploadExternalDoc,
} from "../hooks/use-external-docs";

export function OrderExternalDocsPanel({ orderId }: { orderId: number }) {
  const list = useExternalDocs(orderId);
  const upload = useUploadExternalDoc(orderId);

  const [docType, setDocType] = useState("contract");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) {
      setError("请选择要导入的单证文件（PDF / 图片 / Word / Excel）");
      return;
    }
    const reason = validateExternalDocFile(file);
    if (reason) {
      setError(reason);
      return;
    }
    setError(null);
    try {
      await upload.mutateAsync({ file, doc_type: docType, notes });
      toast.success("单证已导入");
      setFile(null);
      setNotes("");
    } catch {
      setError("单证导入失败：请确认文件类型/大小后重试（订单本身不受影响）。");
    }
  };

  const download = async (docId: number, fileName: string) => {
    try {
      const blob = await fetchExternalDocBlob(docId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error("下载单证失败，请稍后重试");
    }
  };

  return (
    <SectionCard
      title="已导入单证"
      description="直接建单时导入的已有单证（合同 / PO / 发票 / 装箱单 / 原产地证）会进单证台账，可下载；与上面的「订单附件」分开管理，后续可继续导入。"
    >
      <div className="mb-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end">
        <label className="space-y-1">
          <span className="text-xs font-medium">单证类型</span>
          <select
            aria-label="单证类型"
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
          >
            {EXTERNAL_DOC_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1">
          <Label htmlFor="external-doc-notes" className="text-xs">
            备注（可选）
          </Label>
          <Input
            id="external-doc-notes"
            value={notes}
            placeholder="如：客户发来的签章扫描件"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="external-doc-file" className="text-xs">
            选择文件
          </Label>
          <Input
            id="external-doc-file"
            type="file"
            accept={EXTERNAL_DOC_ACCEPT}
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
          {upload.isPending ? "导入中…" : "导入单证"}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-destructive sm:col-span-4">
            {error}
          </p>
        )}
      </div>

      {list.isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="已导入单证加载中">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full rounded-md" />
          ))}
        </div>
      ) : list.isError ? (
        <div className="flex items-center gap-2 py-4 text-sm text-destructive">
          <FileText className="h-4 w-4" />
          已导入单证读取失败。
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            重试
          </Button>
        </div>
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState
          icon={FileText}
          title="还没有导入已有单证"
          description="客户已经开好的合同、PO、发票、装箱单、原产地证可以导入这里，单证台账与订单附件分开管理。"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="p-2">
                  类型
                </th>
                <th scope="col" className="p-2">
                  文件名
                </th>
                <th scope="col" className="p-2">
                  大小
                </th>
                <th scope="col" className="p-2">
                  上传时间
                </th>
                <th scope="col" className="p-2">
                  备注
                </th>
                <th scope="col" className="p-2">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((doc) => (
                <tr key={doc.id} className="border-b last:border-0">
                  <td className="p-2">{externalDocTypeLabel(doc.doc_type)}</td>
                  <td
                    className="max-w-[260px] truncate p-2"
                    title={doc.file_name}
                  >
                    {doc.file_name}
                  </td>
                  <td className="p-2">{formatExternalDocSize(doc.file_size)}</td>
                  <td className="p-2">{formatOrderDate(doc.created_at)}</td>
                  <td
                    className="max-w-[200px] truncate p-2"
                    title={doc.notes ?? ""}
                  >
                    {doc.notes || "—"}
                  </td>
                  <td className="p-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void download(doc.id, doc.file_name)}
                      aria-label={`下载单证 ${doc.file_name}`}
                    >
                      <Download className="mr-1 size-3.5" />
                      下载
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
