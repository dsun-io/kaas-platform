"use client";

/**
 * 询盘多产品行编辑器（详情抽屉内）。
 *
 * 契约：PATCH /inquiries/{id} 的 `items`（内核会把第一行同步回旧标量字段，
 * 见 ws_crm_ext.py:571-582）。因此这里只维护 items，不重复维护标量字段。
 * 空行在提交时由 `buildInquiryUpdatePayload()` 丢弃（不会发 product_name_raw: "" 的垃圾行）。
 */
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  emptyInquiryItemDraftRow,
  type InquiryItemDraftRow,
} from "@/lib/inquiries/edit";

export function InquiryItemsEditor({
  rows,
  onChange,
  disabled = false,
}: {
  rows: InquiryItemDraftRow[];
  onChange: (rows: InquiryItemDraftRow[]) => void;
  disabled?: boolean;
}) {
  const patchRow = (id: string, patch: Partial<InquiryItemDraftRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          这条询盘还没有产品行。添加一行，把客户问的产品/规格/数量记下来 ——
          报价工位会按行算价。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>产品</TableHead>
                <TableHead>规格</TableHead>
                <TableHead>数量</TableHead>
                <TableHead>单位</TableHead>
                <TableHead>用途</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={row.id}>
                  <TableCell className="min-w-[9rem]">
                    <Input
                      aria-label={`第 ${index + 1} 行产品名称`}
                      value={row.product_name_raw}
                      disabled={disabled}
                      onChange={(e) =>
                        patchRow(row.id, { product_name_raw: e.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell className="min-w-[8rem]">
                    <Input
                      aria-label={`第 ${index + 1} 行规格`}
                      value={row.spec_text}
                      disabled={disabled}
                      onChange={(e) =>
                        patchRow(row.id, { spec_text: e.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell className="w-[7rem]">
                    <Input
                      aria-label={`第 ${index + 1} 行数量`}
                      inputMode="decimal"
                      value={row.quantity}
                      disabled={disabled}
                      onChange={(e) =>
                        patchRow(row.id, { quantity: e.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell className="w-[6rem]">
                    <Input
                      aria-label={`第 ${index + 1} 行单位`}
                      value={row.quantity_unit}
                      disabled={disabled}
                      onChange={(e) =>
                        patchRow(row.id, { quantity_unit: e.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell className="min-w-[7rem]">
                    <Input
                      aria-label={`第 ${index + 1} 行用途`}
                      value={row.application}
                      disabled={disabled}
                      onChange={(e) =>
                        patchRow(row.id, { application: e.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={`删除第 ${index + 1} 行产品`}
                      onClick={() =>
                        onChange(rows.filter((item) => item.id !== row.id))
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange([...rows, emptyInquiryItemDraftRow()])}
      >
        <Plus className="mr-1 size-4" />
        添加产品行
      </Button>
    </div>
  );
}
