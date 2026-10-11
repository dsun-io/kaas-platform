"use client";

/**
 * 客户盖章回传（版本化留档）
 *
 * 用户原话：
 *   「图片一定要存储啊，签章要存，pdf 要存，客户盖章回传以后要覆盖没有盖章的旧文件。
 *    要留档肯定要存的。」
 *
 * 语义（内核 `kaas_common.files.next_version` 实现，两端一致）：
 * - 再次上传 = **新版本上位**（`file_objects.is_current=true`），旧版本**保留**
 *   并用 `supersedes_id` 串成版本链 —— 对外看到的是最新盖章件，历史版本仍可回溯。
 * - 这里**不物理删除**：摘除只解绑引用（文件是留档资料）。
 *
 * 为什么不受"已签发冻结"限制：客户是**签发之后**才盖章回传的，
 * 冻结的是单据内容，不是回传件。
 */
import { useRef, useState } from "react";
import { FileCheck2, History, ImageUp, Link2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFileObjectUrl } from "@/lib/products/use-products";

import {
  useDetachTradeDocFile,
  useTradeDocFiles,
  useUploadTradeDocFile,
  type TradeDocFile,
} from "../hooks/use-trade-docs";

export function DocStampReturn({ docId }: { docId: number }) {
  const files = useTradeDocFiles(docId);
  const upload = useUploadTradeDocFile(docId);
  const detach = useDetachTradeDocFile(docId);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = files.data ?? [];
  const currentStamps = all.filter((f) => f.role === "stamp_scan");
  const historyStamps = all.filter((f) => f.role === "stamp_scan_superseded");
  const photos = all.filter((f) => f.role === "product_photo");
  const pdfs = all.filter((f) => f.role === "render_pdf");

  const doUpload = async () => {
    if (!picked) return toast.error("先选文件（扫描件/照片 PDF 均可）");
    try {
      await upload.mutateAsync({ file: picked, role: "stamp_scan", name: name.trim() });
      toast.success("已回传：新版本上位，旧版本保留在历史里");
      setPicked(null);
      setName("");
      if (inputRef.current) inputRef.current.value = "";
    } catch {
      toast.error("回传失败（类型/大小不合规时后端会明确拒绝）");
    }
  };

  return (
    <div className="mb-4 rounded-md border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <FileCheck2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">客户盖章回传</span>
        <span className="text-xs text-muted-foreground">
          再次上传会**覆盖当前件**（新版本上位），旧版本保留在历史里 —— 要留档
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b p-3">
        <label className="space-y-1">
          <span className="text-xs font-medium">文件</span>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="block text-xs"
            onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="min-w-[200px] flex-1 space-y-1">
          <span className="text-xs font-medium">名称（可留空，默认用文件名）</span>
          <Input
            className="h-8 text-xs"
            value={name}
            placeholder="如：BABAN KORI 盖章回传 PI 2026-10-11"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button size="sm" disabled={upload.isPending} onClick={doUpload}>
          <ImageUp className="mr-1 h-3.5 w-3.5" />
          {upload.isPending ? "上传中…" : "上传回传件"}
        </Button>
      </div>

      <div className="space-y-3 p-3">
        {files.isLoading ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : all.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有附件。产品图可在上方「从产品图库选图」引用；客户盖章后从这里回传。
          </p>
        ) : (
          <>
            {currentStamps.length > 0 && (
              <FileRow title="当前盖章件" files={currentStamps} onDetach={(id) => detach.mutate(id)} />
            )}
            {photos.length > 0 && <FileRow title="产品图引用" files={photos} />}
            {pdfs.length > 0 && <FileRow title="系统出的 PDF" files={pdfs} />}
            {historyStamps.length > 0 && (
              <div>
                <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <History className="h-3 w-3" />
                  历史版本 {historyStamps.length} 件（留档，不再对外展示）
                </p>
                <ul className="space-y-1">
                  {historyStamps.map((f) => (
                    <li key={f.link_id} className="text-xs text-muted-foreground">
                      {f.name} · v{f.version} · 已被 v{f.version + 1} 取代
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({
  title,
  files,
  onDetach,
}: {
  title: string;
  files: TradeDocFile[];
  onDetach?: (linkId: number) => void;
}) {
  return (
    <div>
      <p className="mb-1 flex items-center gap-1 text-xs font-medium">
        <Link2 className="h-3 w-3" />
        {title} {files.length} 件
      </p>
      <div className="flex flex-wrap gap-2">
        {files.map((f) => (
          <StampCard key={f.link_id} file={f} onDetach={onDetach} />
        ))}
      </div>
    </div>
  );
}

function StampCard({ file, onDetach }: { file: TradeDocFile; onDetach?: (linkId: number) => void }) {
  const isImage = (file.content_type ?? "").startsWith("image/");
  const url = useFileObjectUrl(isImage ? file.id : null);
  return (
    <div className="w-40 rounded border p-1.5">
      <div className="mb-1 flex h-24 items-center justify-center overflow-hidden rounded bg-muted/30">
        {isImage && url.data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url.data} alt={file.name} className="max-h-24 w-auto" />
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {isImage ? (url.isError ? "读取失败" : "加载中…") : "PDF"}
          </span>
        )}
      </div>
      <p className="truncate text-[11px]" title={file.name}>
        {file.name}
      </p>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className="rounded bg-muted px-1">v{file.version}</span>
        <span>{file.storage}</span>
        {onDetach && (
          <button
            type="button"
            className="ml-auto flex items-center gap-0.5 text-destructive"
            onClick={() => onDetach(file.link_id)}
          >
            <Trash2 className="h-3 w-3" />
            摘除
          </button>
        )}
      </div>
    </div>
  );
}
