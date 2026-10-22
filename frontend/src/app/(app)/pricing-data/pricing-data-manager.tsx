"use client";

import { useEffect, useState } from "react";
import { useRole } from "@/hooks/use-role";
import { useExportProducts } from "../quotations/v2-quote/hooks/use-export-quote-import";
import {
  useDeactivatePricingCell,
  usePricingMatrix,
  useSavePricingCell,
  useUpdatePricingCell,
} from "./hooks/use-pricing-data";
import { AddOptionPanel } from "./components/AddOptionPanel";
import {
  PricingEditDialog,
  type PricingCellUpdate,
} from "./components/PricingEditDialog";
import { EmptyState, ErrorState, PageHeader } from "@/components/shared";
import { LoadingBlock } from "@/components/shared/loading-block";
import {
  PricingAllCustomersTable,
  PricingDataTable,
} from "./components/PricingDataTable";
import type { PricingCell, SavePricingCell } from "@contracts/export-quote";
import { normalizeApiError } from "@/lib/api/api-error";

/**
 * 定价数据（成本价表）—— 算价的输入数据。
 *
 * 一个产品一张矩阵：行 = 产品的「定价键」组合（牛栏网 = 边丝径 × 镀锌量），
 * 列 = 成本、来源、生效日期。矩阵是**完整**的，没配过的组合也在表里，
 * 显示为「产品兜底」—— 这样业务一眼能看出还差哪几格没配。
 *
 * `embedded`：作为工位内部视图嵌入时，外层容器已有标题，这里不再重复渲染。
 */
export function PricingDataManager({
  embedded = false,
}: { embedded?: boolean } = {}) {
  const {
    data: productsData,
    isLoading: loadingProducts,
    isError: productsFailed,
    error: productsError,
    refetch: refetchProducts,
  } = useExportProducts();
  const products = productsData?.products ?? [];

  // 跨客户查看是内部视图：只有租户管理员才看得到这个开关。
  // 给客户展示一个点了就 403 的选项，等于请人去撞墙。
  const { isTenantAdmin } = useRole();

  const [productKey, setProductKey] = useState("");
  // 默认落在第一个产品上；产品列表加载完后自动选中，省一次点击
  useEffect(() => {
    const first = products[0];
    if (!productKey && first) setProductKey(first.key);
  }, [productKey, products]);

  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const [addingOption, setAddingOption] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // C36 #11：改价弹窗（PATCH /pricing-data/{item_id}）
  const [editCell, setEditCell] = useState<PricingCell | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // 权限降级（如登录态刷新）后不能继续停在 cross-customer 视图上
  useEffect(() => {
    if (!isTenantAdmin && showAllCustomers) setShowAllCustomers(false);
  }, [isTenantAdmin, showAllCustomers]);

  const scope = showAllCustomers && isTenantAdmin ? "all" : "own";
  const {
    data: matrix,
    isLoading,
    error,
    isError: matrixFailed,
    refetch: refetchMatrix,
  } = usePricingMatrix(productKey, scope);
  const saveCell = useSavePricingCell(productKey);
  const deactivateCell = useDeactivatePricingCell(productKey);
  const updateCell = useUpdatePricingCell(productKey);

  const forbidden =
    showAllCustomers &&
    !!error &&
    (error as { response?: { status?: number } })?.response?.status === 403;

  async function handleAddOption(payload: SavePricingCell) {
    setAddingOption(true);
    setNotice(null);
    try {
      await saveCell.mutateAsync(payload);
      setNotice(
        `已新增档位，成本 ${payload.amount} 元/${payload.unit}。` +
          "报价页的规格下拉已同步。",
      );
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "新增失败";
      setNotice(typeof msg === "string" ? msg : "新增失败");
    } finally {
      setAddingOption(false);
    }
  }

  /**
   * 弹窗提交（X8）：未配置行 → POST 建版本（配置成本）；已配置行 → PATCH 改价。
   *
   * 两种失败都**留在弹窗里**显示原因（422/404 的 detail 是给人看的），
   * 用户可以改完再点保存 —— 失败不关窗、不把原因丢进页面顶部提示。
   */
  async function handleDialogSubmit(values: PricingCellUpdate) {
    if (!editCell) return;
    setEditError(null);
    try {
      if (editCell.item_id == null) {
        await saveCell.mutateAsync({
          product_key: matrix?.product_key ?? productKey,
          values: editCell.values,
          amount: values.amount,
          unit: values.unit,
        });
        setNotice(
          `已配置成本：${editCell.labels.join(" · ")} → ${values.amount} ${values.unit}（从下一张报价单起生效）。`,
        );
      } else {
        await updateCell.mutateAsync({ itemId: editCell.item_id, ...values });
        setNotice(
          `已改价：${editCell.labels.join(" · ")} → ${values.amount} ${values.unit}（从下一张报价单起生效）。`,
        );
      }
      setEditCell(null);
    } catch (err: unknown) {
      // 422/404 的原因是给人看的（amount must be > 0 / unit 不合法 / 行不存在），原样透出
      setEditError(normalizeApiError(err).message);
    }
  }

  async function handleReset(cell: PricingCell) {
    if (cell.item_id == null) return;
    setNotice(null);
    try {
      await deactivateCell.mutateAsync(cell.item_id);
      setNotice("已停用自定义成本，该组合回退到产品定义的兜底值。");
    } catch {
      setNotice("停用失败");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!embedded && (
          <PageHeader
            title="定价数据"
            description="每个客户的成本价表，是报价计算的输入"
          />
        )}
        {isTenantAdmin && (
          <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4"
              checked={showAllCustomers}
              onChange={(e) => setShowAllCustomers(e.target.checked)}
            />
            查看所有客户（管理员）
          </label>
        )}
      </div>

      {loadingProducts ? (
        // B3：加载态用共享 LoadingBlock（不再是「加载产品…」纯文本）
        <LoadingBlock rows={3} />
      ) : productsFailed ? (
        <ErrorState
          title="产品列表读取失败"
          message={normalizeApiError(productsError).message}
          onRetry={() => void refetchProducts()}
        />
      ) : products.length === 0 ? (
        <EmptyState
          title="还没有可用的产品"
          description="先到产品工位添加产品，再来配置定价数据。"
          className="border-0 py-8"
        />
      ) : (
        <>
          {products.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {products.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setProductKey(p.key)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    p.key === productKey
                      ? "bg-primary text-primary-foreground"
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          {notice && (
            <p className="text-sm text-muted-foreground rounded-lg bg-muted px-3 py-2">
              {notice}
            </p>
          )}

          {isLoading ? (
            <LoadingBlock rows={4} />
          ) : forbidden ? (
            // 403 是**权限**不是"没数据"：显式说明，且不提供无意义的重试
            <ErrorState
              title="无权查看所有客户的定价数据"
              message="只有空间管理员可以查看所有客户的定价数据。"
            />
          ) : matrixFailed ? (
            // B3：读取失败 ≠ 未配置 —— 不能说成「该产品未声明定价键」
            <ErrorState
              title="定价数据读取失败"
              message={normalizeApiError(error).message}
              onRetry={() => void refetchMatrix()}
            />
          ) : scope === "all" ? (
            <PricingAllCustomersTable matrix={matrix} />
          ) : (
            <>
              <AddOptionPanel
                matrix={matrix}
                busy={addingOption}
                onSave={handleAddOption}
              />
              <PricingDataTable
                matrix={matrix}
                loading={isLoading}
                onReset={handleReset}
                onEdit={(cell) => {
                  setEditError(null);
                  setEditCell(cell);
                }}
              />
              <PricingEditDialog
                open={editCell !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    setEditCell(null);
                    setEditError(null);
                  }
                }}
                cell={editCell}
                pending={updateCell.isPending || saveCell.isPending}
                error={editError}
                onSubmit={handleDialogSubmit}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
