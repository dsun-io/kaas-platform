"use client";

/**
 * 「导入已有数据」—— **历史订单批量导入**（C29）。
 *
 * 流程（docs/IMPORT_ORDERS_PLAN_2026-10-23.md §3/§4）：
 *   选客户（必选）+ 选 CSV → **自动调预览**（后端解析 + 逐行校验，零写入）
 *   → 渲染预览表：列取后端返回的 columns，错误行标红并逐条列出原因
 *   → 只有 summary.error === 0 且至少一行可导入时，「确认导入」才可点
 *   → 提交成功：toast 带上 created 数 + 刷新订单查询 + 关闭
 *   → 失败（422 有错行 / 409 撞单号）：**原样展示后端原因**，弹窗保持打开，不假装成功
 *
 * 为什么导入必须选客户：导入的是历史订单（没有报价/询盘父对象），它们唯一的归属
 * 就是业务客户；不选客户导进来，这些单据在客户页的「往来记录」树里无处可挂。
 *
 * 为什么"先预览再提交"是硬流程：导入一次可能几十行，错了要整批回滚；
 * 预览让用户在**写库之前**看到逐行结果，避免"导完才发现第 7 行日期写错"。
 *
 * 当前只接了**订单**（单证导入依赖订单/类型/文件三要素，设计 §6 明确不在本轮）。
 * 其它资源若将来要接，需要各自的 hook 与列说明；这里的 resource 只用于文案。
 */
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingBlock } from "@/components/shared/loading-block";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import {
  describeImportOrderFailure,
  parseImportOrderFailure,
  useCommitImportOrders,
  usePreviewImportOrders,
  type ImportOrderFailure,
  type ImportOrderPreviewResponse,
  type ImportOrdersInput,
} from "@/app/(app)/orders/hooks/use-import-orders";

/** 订单 CSV 的期望列（与内核 / 设计 §2 一致；仅用于给用户看"要什么列"）。 */
const ORDERS_COLUMNS_HINT =
  "order_no, order_date, status, currency, total_amount, notes";

interface ImportExistingDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入哪类数据（当前只有「订单」真实可用）；仅用于文案 */
  resource?: string;
  /** 期望的 CSV 列说明（不传用订单列） */
  columnsHint?: string;
}

/** 预览单元格文本：缺值显示「—」（与表格其它列的约定一致，不伪造 0）。 */
function cellText(
  rowData: Record<string, unknown> | null,
  column: string,
): string {
  if (!rowData) return "—";
  const value = rowData[column];
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/** 一行数据的稳定 key：行序号在单次预览里唯一。 */
function rowKey(index: number): string {
  return "import-row-" + String(index);
}

export function ImportExistingDataDialog({
  open,
  onOpenChange,
  resource = "订单",
  columnsHint = ORDERS_COLUMNS_HINT,
}: ImportExistingDataDialogProps) {
  const [customer, setCustomer] = useState<CustomerPickerValue | null>(null);
  const [file, setFile] = useState<File | null>(null);
  /** 本地校验（还没发请求就能拦住的错：没选客户 / 没选文件） */
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportOrderPreviewResponse | null>(
    null,
  );
  const [previewing, setPreviewing] = useState(false);
  /** 预览失败的**可读原因**（后端 422/404 原文或本地兜底） */
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  /** 提交失败的结构化信息（422 逐行 / 409 撞号）；非空即「这次没导进去」 */
  const [commitFailure, setCommitFailure] = useState<ImportOrderFailure | null>(
    null,
  );

  const previewMutation = usePreviewImportOrders();
  const commitMutation = useCommitImportOrders();

  /**
   * 已经发起过预览的输入组合（客户|文件名|大小|修改时间）。
   *
   * 作用：客户/文件一变就自动重新预览，但**同一个组合只打一次请求**
   * （否则"预览失败 → 一直重试"会把接口打满）。
   */
  const requestedKey = useRef<string | null>(null);

  /**
   * 清空本次导入的全部状态。
   *
   * 在**关闭时**清（事件处理器里），而不是"打开时用 effect 清"：
   *   · 语义一样（重新打开必然先经历过关闭）；
   *   · 但 effect 里同步 setState 会触发级联渲染（eslint
   *     `react-hooks/set-state-in-effect`），且打开瞬间先渲染脏状态再清一次。
   * 不清的后果很具体：上一次选的客户/文件"粘"到下一次导入上，
   * 很容易把 A 客户的表导成 B 客户的单据。
   */
  const resetForm = () => {
    setCustomer(null);
    setFile(null);
    setFormError(null);
    setPreview(null);
    setPreviewFailure(null);
    setCommitFailure(null);
    setPreviewing(false);
    requestedKey.current = null;
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) resetForm();
    onOpenChange(next);
  };

  /** 调预览：一次请求，把结果或失败原因落到界面状态。 */
  const runPreview = useCallback(
    async (input: ImportOrdersInput) => {
      setPreviewing(true);
      setPreview(null);
      setPreviewFailure(null);
      setCommitFailure(null);
      try {
        const data = await previewMutation.mutateAsync(input);
        setPreview(data);
      } catch (error) {
        setPreviewFailure(
          describeImportOrderFailure(parseImportOrderFailure(error)),
        );
      } finally {
        setPreviewing(false);
      }
    },
    [previewMutation],
  );

  // 客户 + 文件都齐了就自动预览：用户不用再点一次"校验"，也不用猜"为什么没有表"。
  useEffect(() => {
    if (!open) return;
    if (!customer || !file) {
      requestedKey.current = null;
      return;
    }
    const key =
      customer.id +
      "|" +
      file.name +
      "|" +
      String(file.size) +
      "|" +
      String(file.lastModified);
    if (requestedKey.current === key) return;
    requestedKey.current = key;
    void runPreview({ file, customerId: customer.id });
  }, [open, customer, file, runPreview]);

  /** 重试预览（失败后用户可能刚换了个文件，或后端刚恢复）。 */
  const retryPreview = () => {
    if (!customer || !file) return;
    requestedKey.current = null;
    void runPreview({ file, customerId: customer.id });
  };

  const onSelectCustomer = (next: CustomerPickerValue | null) => {
    setCustomer(next);
    setFormError(null);
    setPreview(null);
    setPreviewFailure(null);
    setCommitFailure(null);
    requestedKey.current = null;
  };

  const onSelectFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    setFormError(null);
    setPreview(null);
    setPreviewFailure(null);
    setCommitFailure(null);
    requestedKey.current = null;
  };

  /**
   * 「确认导入」的禁用口径：**预览有错误行 / 没有可导入行 / 正在提交**时禁用。
   *
   * 为什么"还没选客户/还没预览"时**不**禁用而是让点击给出原因：禁用按钮不解释自己
   * （读屏也听不到），用户只会以为界面坏了。真正的写库闸门在下面 confirmImport 的
   * 逐项校验 + 后端全绿校验，双击也导不进去。
   */
  const commitDisabled =
    commitMutation.isPending ||
    (preview !== null &&
      (preview.summary.error > 0 || preview.summary.ok === 0));

  const confirmImport = () => {
    if (!customer) {
      setFormError("请选择数据所属的业务客户 —— 导入的数据必须能挂到客户上");
      return;
    }
    if (!file) {
      setFormError("请选择要导入的 CSV 文件");
      return;
    }
    if (!preview) {
      setFormError("请先完成预览校验：确认每一行都没问题后再导入");
      return;
    }
    if (preview.summary.error > 0) {
      setFormError(
        "还有 " +
          String(preview.summary.error) +
          " 行没通过校验，不能导入 —— 改好 CSV 后重新选择文件会自动重新校验",
      );
      return;
    }
    setFormError(null);
    setCommitFailure(null);
    // 用 mutate（带 per-call 回调）而不是 await mutateAsync：成功动作（toast/关闭）
    // 与 hook 的 invalidate 一起在 React Query 回调里完成，弹窗不会中途停留。
    commitMutation.mutate(
      { file, customerId: customer.id },
      {
        onSuccess: (result) => {
          toast.success("已导入 " + String(result.created) + " 笔" + resource);
          handleOpenChange(false);
        },
        onError: (error) => {
          // 不关弹窗、不弹成功：把后端拒绝的原因留在界面上（apiClient 已统一 toast，
          // 这里**不重复** toast，只做页内 role="alert"）。
          setCommitFailure(parseImportOrderFailure(error));
        },
      },
    );
  };

  const summary = preview?.summary ?? null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>导入已有数据（{resource}）</DialogTitle>
          <DialogDescription>
            把系统外已有的{resource}一次性录进来（历史单没有报价父对象，
            导入后归到所选客户名下，并保留 CSV 里的原始单号）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <CustomerPicker
            value={customer}
            onChange={onSelectCustomer}
            required
            label="业务客户"
            hint="导入的每一行都会挂到这个客户上，不支持一张表混多个客户"
          />

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="import-orders-file">
              CSV 文件<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Input
              id="import-orders-file"
              type="file"
              accept=".csv,text/csv"
              aria-label="CSV 文件"
              onChange={onSelectFile}
            />
            <p className="text-[11px] text-muted-foreground">
              期望列：{columnsHint}（UTF-8；Excel 导出的带 BOM 也可以）
            </p>
          </div>

          {/* 预览区：加载 → 失败（可重试）→ 结果表 → 未开始提示 */}
          {previewing ? (
            <div className="rounded-lg border p-3">
              <LoadingBlock rows={3} />
            </div>
          ) : previewFailure ? (
            <ErrorState message={previewFailure} onRetry={retryPreview} />
          ) : preview && summary ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span>
                  共 <strong>{summary.total}</strong> 行
                </span>
                <span className="text-success">
                  可导入 <strong>{summary.ok}</strong> 行
                </span>
                <span
                  className={cn(
                    summary.error > 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  错误 <strong>{summary.error}</strong> 行
                </span>
                <span className="text-muted-foreground">
                  客户：
                  {preview.customer.name ?? "#" + String(preview.customer.id)}
                </span>
              </div>

              {(preview.warnings ?? []).length > 0 && (
                <ul className="space-y-0.5 text-[11px] text-warning">
                  {(preview.warnings ?? []).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}

              {summary.existing_order_nos.length > 0 && (
                <p className="text-xs text-destructive">
                  以下单号系统里已存在（不能重复导入）：
                  {summary.existing_order_nos.join("、")}
                </p>
              )}

              {summary.total === 0 ? (
                <p className="rounded-lg border border-dashed bg-muted/30 p-2 text-xs text-muted-foreground">
                  文件里只有表头，没有数据行 —— 请确认导出的范围后重新选择文件。
                </p>
              ) : (
                <div className="max-h-[45vh] overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">行号</TableHead>
                        {preview.columns.map((column) => (
                          <TableHead key={column}>{column}</TableHead>
                        ))}
                        <TableHead className="min-w-[200px]">
                          校验结果
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rows.map((row) => (
                        <TableRow
                          key={rowKey(row.index)}
                          className={cn(!row.ok && "bg-destructive/5")}
                        >
                          <TableCell className="text-xs text-muted-foreground">
                            {row.index}
                          </TableCell>
                          {preview.columns.map((column) => (
                            <TableCell
                              key={column}
                              className={cn(
                                "text-xs",
                                !row.ok && "text-destructive",
                              )}
                            >
                              {cellText(row.data, column)}
                            </TableCell>
                          ))}
                          <TableCell className="whitespace-normal text-xs">
                            {row.errors.length > 0 ? (
                              <ul className="space-y-0.5 text-destructive">
                                {row.errors.map((error) => (
                                  <li key={error}>{error}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-muted-foreground">
                                通过
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {summary.error > 0 && (
                <p className="text-xs text-destructive">
                  有错误行时不能导入：请按上表逐行原因修正
                  CSV，保存后重新选择文件（会自动重新校验）。
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed bg-muted/30 p-2 text-xs text-muted-foreground">
              选好客户与 CSV
              后会自动做一次预览校验（不写库）：这里会逐行列出能否导入、
              以及每一行的具体原因。
            </p>
          )}

          {formError && (
            <p role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          )}

          {/* 提交失败（422 有错行 / 409 撞单号）：后端原因原样可见，弹窗不关 */}
          {commitFailure && (
            <div
              role="alert"
              className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
            >
              <p className="font-medium">
                {describeImportOrderFailure(commitFailure)}
              </p>
              {commitFailure.rows.length > 0 && (
                <ul className="space-y-0.5 pl-4">
                  {commitFailure.rows.map((row) => (
                    <li key={row.index} className="list-disc">
                      第 {row.index} 行：{row.errors.join("；")}
                    </li>
                  ))}
                </ul>
              )}
              {commitFailure.orderNos.length > 0 && (
                <p>重复单号：{commitFailure.orderNos.join("、")}</p>
              )}
              {commitFailure.status !== null && (
                <p className="text-[11px] opacity-80">
                  HTTP {commitFailure.status}
                  {commitFailure.code ? " · " + commitFailure.code : ""}
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button onClick={confirmImport} disabled={commitDisabled}>
            <Upload className="mr-1 size-4" />
            {commitMutation.isPending ? "导入中…" : "确认导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
