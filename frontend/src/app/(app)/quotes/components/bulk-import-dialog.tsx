"use client";

/**
 * 「批量导入」入口（C19 / G-10：放在 v2 报价工作台顶部，与单条报价并列）。
 *
 * 复用 `BulkImportPanel`（整单模板 / 解析预览 / 填入工作台），这里只做「入口 + 弹窗 + 关闭」。
 *
 * 口径（2026-10-23 用户拍板，R-D）：**导入结果直接填入报价工作台**——
 * 不再「只算不落库」；算价/落库仍走工作台既有链路（本弹窗不写任何报价单）。
 */
import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import type { OrderImportRow } from "@contracts/export-quote";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { BulkImportPanel } from "./bulk-import-panel";

export function BulkImportEntry({
  onFillRows,
}: {
  onFillRows: (rows: OrderImportRow[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const fillRows = (rows: OrderImportRow[]) => {
    onFillRows(rows);
    // 填入后关闭弹窗，用户回到工作台核对（行草稿已在父级就位）
    setOpen(false);
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
              一张整单表导入订单里的 N 个产品：下载整单模板 →
              上传预览（行级校验）→ 填入工作台后核对并保存。导入本身不写报价单。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[72vh] overflow-y-auto pr-1">
            <BulkImportPanel onFillRows={fillRows} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
