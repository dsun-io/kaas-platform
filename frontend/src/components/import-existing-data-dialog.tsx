"use client";

/**
 * 「导入已有数据」入口（**占位骨架**）。
 *
 * 为什么是占位、而且刻意不发任何请求：
 *   后端还没有批量导入接口。凭空猜一个 URL（比如 `POST /imports`）会把请求
 *   打到一个不存在、或将来语义完全不同的路由上 —— 那比"不做"更危险。
 *   所以这里把**交互与校验**先定型（选客户 + 选 CSV + 提交），
 *   提交只走一条 try/catch 分支给出明确告知；接口就绪后只需替换 handleSubmit 内部，
 *   上层页面（订单 / 单证列表）不需要任何改动。
 *
 * 为什么导入也**必须选客户**：
 *   导入的是历史订单/单证（没有报价这一环），它们唯一的归属就是业务客户；
 *   不选客户导进来，这些单据在客户页的「往来记录」树里就无处可挂。
 */
import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
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
import { Label } from "@/components/ui/label";

interface ImportExistingDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入哪类数据（订单 / 单证），只用于文案 */
  resourceLabel: string;
  /** 期望的 CSV 列说明（写清楚"要什么列"，否则用户导进来的文件无从校对） */
  columnsHint: string;
}

export function ImportExistingDataDialog({
  open,
  onOpenChange,
  resourceLabel,
  columnsHint,
}: ImportExistingDataDialogProps) {
  const [customer, setCustomer] = useState<CustomerPickerValue | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // 每次重新打开都清空：上一次选的客户/文件不该"粘"到下一次导入上，
  // 否则很容易把 A 客户的表导成 B 客户的单据。
  useEffect(() => {
    if (!open) return;
    setCustomer(null);
    setFile(null);
    setError(null);
    setPending(false);
  }, [open]);

  const submit = async () => {
    if (!customer) {
      setError("请选择数据所属的业务客户 —— 导入的数据必须能挂到客户上");
      return;
    }
    if (!file) {
      setError("请选择要导入的 CSV 文件");
      return;
    }
    setError(null);
    setPending(true);
    try {
      // ⚠️ 后端批量导入接口尚未提供。这里**刻意不请求任何 URL**（见文件头注释）。
      // 保留 try/catch：将来把真实请求接进来时，失败也不会把页面打崩。
      toast.info("导入功能即将上线", {
        description: `已记录：${resourceLabel} · 客户「${customer.name}」· ${file.name}。后端批量导入接口就绪后即可提交。`,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(
        `导入失败：${err instanceof Error ? err.message : "未知错误"}`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入已有数据（{resourceLabel}）</DialogTitle>
          <DialogDescription>
            用于把系统外已有的{resourceLabel}
            一次性录进来（历史订单/单据没有报价父对象，
            导入后会归到所选客户名下）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <CustomerPicker
            value={customer}
            onChange={(next) => {
              setCustomer(next);
              setError(null);
            }}
            required
            label="业务客户"
            hint="导入的每一行都会挂到这个客户上，不支持一张表混多个客户"
          />

          <div className="space-y-1.5">
            <Label className="text-xs">
              CSV 文件<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <p className="text-[11px] text-muted-foreground">
              期望列：{columnsHint}
            </p>
          </div>

          <p className="rounded-lg border border-dashed bg-muted/30 p-2 text-[11px] text-muted-foreground">
            注：批量导入接口尚未提供，本次提交不会写入任何数据。
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={pending}>
            <Upload className="mr-1 size-4" />
            {pending ? "提交中…" : "开始导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
