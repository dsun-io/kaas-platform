"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { Pencil, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PricingCell, PricingMatrix } from "@contracts/export-quote";

interface Props {
  matrix: PricingMatrix | undefined;
  loading: boolean;
  /**
   * 打开「配置成本 / 改价」弹窗。
   *
   * 同一入口两种语义，由调用方按 item_id 判：没有 item_id = 尚未配置（POST 建版本），
   * 有 = 客户已配置（PATCH 改价）。
   */
  onEdit: (cell: PricingCell) => void;
  /** 停用自定义成本，回退到产品定义的兜底值 */
  onReset: (cell: PricingCell) => void;
}

/**
 * 定价矩阵：一行 = 一个定价键组合（如「边丝径 2.0 × 普锌40g/㎡」）。
 *
 * 之所以做成矩阵而不是「已有数据列表」：
 * 成本是算价的输入，业务要能一眼看出**哪一格还没配**。列表式界面里
 * 「没配的组合」根本不会出现，于是没人发现它在用兜底值 —— 矩阵不会漏。
 *
 * X8（U-P1D 审计）：矩阵**只做展示**。旧实现在每个单元格里塞 Input 原地改价，
 * 后果是：① 表格每行一个受控输入框，几十行时输入明显卡；② 金额/单位/生效期/备注/状态
 * 只有一个金额能改，另外四项还得另开弹窗 —— 同一件事两套入口。
 * 现在统一为「选中行 → 弹窗」：矩阵保持完整可读，改价只有一条路径（PricingEditDialog）。
 */
export function PricingDataTable({ matrix, loading, onEdit, onReset }: Props) {
  // 选中行：连同产品 key 一起记，换产品后自然失效（用派生判断，不用 effect 清
  // ——effect 里 setState 会多一轮级联渲染，且旧 key 可能跨产品撞名如 "2.0"）。
  // 也不存 cell 对象：保存后 react-query 会刷新矩阵，金额/配置状态都变了，
  // 按 key 从最新 matrix 里取行才是对的。
  const [picked, setPicked] = useState<{
    productKey: string;
    key: string;
  } | null>(null);

  if (loading) {
    // B3：加载态 = LoadingBlock（共享），不再各组件手写骨架屏
    return (
      <Card>
        <CardContent className="py-6">
          <LoadingBlock rows={5} />
        </CardContent>
      </Card>
    );
  }

  if (!matrix || matrix.rows.length === 0) {
    // 空态 ≠ 失败：这里是真的"该产品没有定价键"，用 EmptyState 明确说清
    return (
      <Card>
        <CardContent className="py-4">
          <EmptyState
            title="该产品未声明「定价键」"
            description="没有定价键就无法按规格组合配置成本；请先到产品定义里补齐定价键。"
            className="border-0 py-6"
          />
        </CardContent>
      </Card>
    );
  }

  const dims = matrix.dims;
  const configuredCount = matrix.rows.filter((r) => r.configured).length;
  const unitLabel = matrix.cost_unit
    ? matrix.cost_unit.replace(/^CNY\//, "元/")
    : "元/kg";
  const selectedKey =
    picked != null && picked.productKey === matrix.product_key
      ? picked.key
      : null;
  const selected =
    selectedKey == null
      ? null
      : (matrix.rows.find((r) => r.key === selectedKey) ?? null);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-lg">成本价（定价数据）</CardTitle>
          <span className="text-xs text-muted-foreground">
            已配置 {configuredCount} / {matrix.rows.length} 行
            {configuredCount < matrix.rows.length &&
              "　·　未配置的行用产品定义的兜底成本"}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                {dims.map((d) => (
                  <th scope="col" key={d.field} className="py-2 pr-4">
                    {d.label}
                    {d.unit ? "（" + d.unit + "）" : ""}
                  </th>
                ))}
                <th scope="col" className="py-2 pr-4 text-right">
                  成本（{unitLabel}）
                </th>
                <th scope="col" className="py-2 pr-4">
                  来源
                </th>
                <th scope="col" className="py-2">
                  生效日期
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((cell) => {
                const isSelected = selectedKey === cell.key;
                return (
                  <tr
                    key={cell.key}
                    // 行选中用 aria-current（全局状态属性；不伪造 grid/aria-selected 语义）
                    aria-current={isSelected ? "true" : undefined}
                    tabIndex={0}
                    onClick={() =>
                      setPicked({
                        productKey: matrix.product_key,
                        key: cell.key,
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setPicked({
                          productKey: matrix.product_key,
                          key: cell.key,
                        });
                      }
                    }}
                    className={cn(
                      "border-b last:border-0 cursor-pointer transition-colors",
                      "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2",
                      "focus-visible:ring-inset focus-visible:ring-primary/30",
                      isSelected && "bg-muted/60",
                    )}
                  >
                    {dims.map((d, i) => (
                      <td key={d.field} className="py-2 pr-4">
                        {cell.labels[i] ?? String(cell.values[d.field] ?? "—")}
                      </td>
                    ))}
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {cell.amount == null ? (
                        <span className="text-muted-foreground">未配置</span>
                      ) : (
                        cell.amount
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={cn(
                          "text-xs px-1.5 py-0.5 rounded",
                          cell.configured
                            ? "bg-success-muted text-success-muted-foreground"
                            : "bg-warning-muted text-warning-muted-foreground",
                        )}
                      >
                        {cell.configured ? "客户配置" : "产品兜底"}
                      </span>
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {cell.effective_from?.split("T")[0] ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selected ? (
          <div
            role="group"
            aria-label="选中行的操作"
            className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2"
          >
            <span className="text-xs text-muted-foreground">
              已选中：
              <span className="text-foreground">
                {selected.labels.join(" · ")}
              </span>
              {" · "}
              {selected.configured
                ? "当前成本 " +
                  (selected.amount == null ? "—" : selected.amount) +
                  " " +
                  selected.unit
                : "尚未配置（用产品兜底）"}
            </span>
            <div className="ml-auto flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                title="修改这一行成本的金额/单位/生效期/备注/状态"
                onClick={() => onEdit(selected)}
              >
                <Pencil className="size-3" />
                {selected.configured ? "改价" : "配置成本"}
              </Button>
              {selected.configured && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-muted-foreground"
                  title="停用自定义成本，回退到产品定义的兜底值"
                  onClick={() => onReset(selected)}
                >
                  <RotateCcw className="size-3" />
                  恢复兜底
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                取消选择
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            点选一行（或聚焦后按 Enter / 空格）后配置成本 /
            改价：矩阵不再支持单元格原地编辑。
          </p>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          成本改动从下一张报价单开始生效；已发出的报价仍按当时的成本复现（历史不删）。
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * 管理员视角：租户下每个客户的配置情况。
 *
 * 只列出**已配置**的组合（未配置由「已配置 N/M」体现）。
 * 不在这里复用单客户矩阵渲染成「全是兜底价」—— 那会让人误以为
 * 「这个客户配了兜底价」，而事实是「没配」。少一层误解比省几行代码重要。
 */
export function PricingAllCustomersTable({
  matrix,
}: {
  matrix: PricingMatrix | undefined;
}) {
  if (!matrix) return null;
  const dims = matrix.dims;
  const customers = matrix.customers ?? [];
  const unitLabel = matrix.cost_unit
    ? matrix.cost_unit.replace(/^CNY\//, "元/")
    : "元/kg";
  const total = matrix.rows.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          各客户配置情况（{matrix.product_name}）
        </CardTitle>
      </CardHeader>
      <CardContent>
        {customers.length === 0 ? (
          <EmptyState
            title="还没有客户配置过定价数据"
            description="客户在报价/定价页保存过成本后，这里会按客户汇总显示。"
            className="border-0 py-6"
          />
        ) : (
          <div>
            <DataTable
              caption="各客户定价配置情况"
              tableClassName="text-sm"
              rows={customers}
              getRowKey={(c) => c.customer_id}
              columns={[
                {
                  key: "customer_id",
                  header: "客户",
                  className: "py-2 pr-4",
                  render: (c) => c.customer_id,
                },
                {
                  key: "configured",
                  header: "已配置",
                  className: "py-2 pr-4",
                  render: (c) => (
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        c.configured_count === total
                          ? "bg-success-muted text-success-muted-foreground"
                          : "bg-warning-muted text-warning-muted-foreground"
                      }`}
                    >
                      {c.configured_count} / {total}
                    </span>
                  ),
                },
                {
                  key: "rows",
                  header: `已配置明细（${unitLabel}）`,
                  className: "py-2 text-muted-foreground",
                  render: (c) =>
                    c.rows
                      .filter((r) => r.configured)
                      .map((r) => `${r.labels.join(" · ")} = ${r.amount}`)
                      .join("；") || "—",
                },
              ]}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              未配置的组合（共 {dims.length} 个维度决定 {total}{" "}
              种组合）在报价时取产品定义的兜底成本。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
