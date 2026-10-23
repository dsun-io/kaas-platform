"use client";

/**
 * 第 5 步：附件上传（合同 / PO / 信用证 / 其他）+ 导入已有单证（可选）。
 * 两者都只是**草稿**：建单成功后逐个上传/导入，失败会明确提示去订单详情补。
 */
import { Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  attachmentKindLabel,
  formatFileSize,
  ORDER_ATTACHMENT_ACCEPT,
  ORDER_ATTACHMENT_KINDS,
} from "@/lib/orders/order-attachments";
import {
  EXTERNAL_DOC_ACCEPT,
  EXTERNAL_DOC_TYPES,
} from "@/lib/orders/external-docs";

import { useWizard } from "./wizard-context";

export function StepAttachments() {
  const {
    attachments,
    setAttachments,
    externalDocs,
    addAttachments,
    addExternalDocs,
    updateExternalDoc,
    removeExternalDoc,
  } = useWizard();
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">随单附件</h3>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/40">
          <Upload className="size-4" />
          选择文件
          <input
            type="file"
            className="sr-only"
            aria-label="选择订单附件"
            accept={ORDER_ATTACHMENT_ACCEPT}
            multiple
            onChange={(e) => {
              addAttachments(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <span className="text-xs text-muted-foreground">
          合同 / PO / 信用证，PDF、JPG、PNG，可多份；提交后再上传。
        </span>
      </div>

      {attachments.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          可以不传附件直接建单；建单后仍可在订单详情里补传。
        </p>
      ) : (
        <ul className="space-y-2">
          {attachments.map((attachment) => (
            <li
              key={attachment.key}
              className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_10rem_1fr_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{attachment.file.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatFileSize(attachment.file.size)}
                </p>
              </div>
              <select
                aria-label={`附件类别 ${attachment.file.name}`}
                className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                value={attachment.kind}
                onChange={(e) =>
                  setAttachments((prev) =>
                    prev.map((item) =>
                      item.key === attachment.key
                        ? { ...item, kind: e.target.value }
                        : item,
                    ),
                  )
                }
              >
                {ORDER_ATTACHMENT_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
              <Input
                aria-label={`附件名称 ${attachment.file.name}`}
                className="h-8 text-xs"
                value={attachment.name}
                onChange={(e) =>
                  setAttachments((prev) =>
                    prev.map((item) =>
                      item.key === attachment.key
                        ? { ...item, name: e.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`移除附件 ${attachment.file.name}`}
                onClick={() =>
                  setAttachments((prev) =>
                    prev.filter((item) => item.key !== attachment.key),
                  )
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
              {attachment.error && (
                <p className="text-xs text-destructive sm:col-span-4">
                  {attachment.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        类别会写进附件名（如「
        {attachmentKindLabel("contract")} ·
        合同扫描件.pdf」），订单详情按名字展示。
      </p>

      <div className="space-y-3 border-t pt-3">
        <div>
          <h3 className="text-sm font-medium">导入已有单证（可选）</h3>
          <p className="text-xs text-muted-foreground">
            客户/第三方已经开好的合同、PO、发票、装箱单、原产地证。导入后进单证台账
            （可在订单详情下载），与上面的随单附件分开管理；订单创建成功后逐份导入，
            失败可在订单详情「已导入单证」里补导入。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/40">
            <Upload className="size-4" />
            添加已有单证
            <input
              type="file"
              className="sr-only"
              aria-label="选择已有单证文件"
              accept={EXTERNAL_DOC_ACCEPT}
              multiple
              onChange={(e) => {
                addExternalDocs(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <span className="text-xs text-muted-foreground">
            PDF / JPG / PNG / Word / Excel，可多份。
          </span>
        </div>

        {externalDocs.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            没有已有单证也可以直接建单；建单后仍可在订单详情里补导入。
          </p>
        ) : (
          <ul className="space-y-2">
            {externalDocs.map((doc) => (
              <li
                key={doc.key}
                className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_10rem_1fr_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{doc.file.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatFileSize(doc.file.size)}
                  </p>
                </div>
                <select
                  aria-label={`单证类型 ${doc.file.name}`}
                  className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                  value={doc.doc_type}
                  onChange={(e) =>
                    updateExternalDoc(doc.key, {
                      doc_type: e.target.value,
                    })
                  }
                >
                  {EXTERNAL_DOC_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`单证备注 ${doc.file.name}`}
                  className="h-8 text-xs"
                  placeholder="备注（可选）"
                  value={doc.notes}
                  onChange={(e) =>
                    updateExternalDoc(doc.key, { notes: e.target.value })
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`移除单证 ${doc.file.name}`}
                  onClick={() => removeExternalDoc(doc.key)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
                {doc.error && (
                  <p className="text-xs text-destructive sm:col-span-4">
                    {doc.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
