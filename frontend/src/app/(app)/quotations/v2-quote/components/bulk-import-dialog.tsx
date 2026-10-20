"use client";

/**
 * 「批量导入」入口（C19 / G-10：放在 v2 报价工作台顶部，与单条报价并列）。
 *
 * 复用 `BulkImportPanel`（其内部复用既有 hooks `useImportPreview` /
 * `useImportCalculate` / `useDownloadTemplate` 与 `lib/export-quote/import-file`
 * 的预检/分组/摘要/CSV 能力），这里只做「入口 + 弹窗 + 成功后刷新」。
 *
 * 口径：**只算不落库**（WORKSTATION_DESIGN §6.1.4 的批量导入是"一次算完整张表"），
 * 因此成功后刷新的是产品/模板与报价记录缓存，不会凭空多出一条报价单。
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { BulkImportPanel } from "./bulk-import-panel";

export function BulkImportEntry() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const refreshAfterImport = () => {
    // 模板/产品缓存与报价记录可能因计算参数变化而过期；刷新它们，
    // 用户关闭弹窗后看到的是最新列表（导入本身不写入任何报价单）。
    void queryClient.invalidateQueries({ queryKey: ["export-quote"] });
    void queryClient.invalidateQueries({ queryKey: ["quote-orders"] });
  };

  return (
    <>
      {/* 与其他弹窗一致：外部按钮控制 open（本仓库 Dialog 未使用 Trigger/asChild） */}
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <FileSpreadsheet className="mr-2 size-4" />
        批量导入表格
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>批量导入报价表</DialogTitle>
            <DialogDescription>
              下载模板 → 填好规格行 → 上传预览（逐行校验）→ 批量计算 → 导出
              CSV。只算不落库：结果用于核对与导出，存成报价单仍走单条/批量报价。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[72vh] overflow-y-auto pr-1">
            <BulkImportPanel onImported={refreshAfterImport} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
