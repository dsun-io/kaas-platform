"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Pencil, RotateCcw, Save } from "lucide-react";
import type {
  PricingCell,
  PricingMatrix,
  SavePricingCell,
} from "@contracts/export-quote";

interface Props {
  matrix: PricingMatrix | undefined;
  loading: boolean;
  /** 正在保存的格（定价键），用于只让那一行转圈 */
  savingKey: string | null;
  onSave: (payload: SavePricingCell, key: string) => void;
  onReset: (cell: PricingCell) => void;
  /** C36 #11：打开「改价」弹窗（PATCH /pricing-data/{item_id}） */
  onEdit?: (cell: PricingCell) => void;
  /** 无需写库的提示（如值未变化） */
  onNotice?: (msg: string) => void;
}

/**
 * 定价矩阵：一行 = 一个定价键组合（如「边丝径 2.0 × 普锌40g/㎡」）。
 *
 * 之所以做成矩阵而不是「已有数据列表」：
 * 成本是算价的输入，业务要能一眼看出**哪一格还没配**。列表式界面里
 * 「没配的组合」根本不会出现，于是没人发现它在用兜底值 —— 矩阵不会漏。
 */
export function PricingDataTable({
  matrix,
  loading,
  savingKey,
  onSave,
  onReset,
  onEdit,
  onNotice,
}: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-2 py-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-md" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!matrix || matrix.rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-sm text-muted-foreground">
            该产品未声明「定价键」，无法按规格组合配置成本。
          </p>
        </CardContent>
      </Card>
    );
  }

  const dims = matrix.dims;
  const configuredCount = matrix.rows.filter((r) => r.configured).length;
  const unitLabel = matrix.cost_unit
    ? matrix.cost_unit.replace(/^CNY\//, "元/")
    : "元/kg";

  function valueOf(cell: PricingCell) {
    return draft[cell.key] ?? (cell.amount == null ? "" : String(cell.amount));
  }

  /**
   * 只要填了一个正数就允许保存。
   *
   * 这里**故意不按「是否改动过」来置灰**：置灰的保存按钮在用户眼里就是
   * 「点了没反应 / 存不上」—— 上一版就是这么被当成 bug 的。
   * 值确实没变的情况改由 onClick 里提前拦下并给出文字提示，
   * 既不写无意义的版本，也不会让人对着死按钮发慌。
   */
  function canSave(cell: PricingCell) {
    const raw = valueOf(cell).trim();
    if (raw === "") return false;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0;
  }

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
                    {d.unit ? `（${d.unit}）` : ""}
                  </th>
                ))}
                <th scope="col" className="py-2 pr-4 text-right">
                  成本（{unitLabel}）
                </th>
                <th scope="col" className="py-2 pr-4">
                  来源
                </th>
                <th scope="col" className="py-2 pr-4">
                  生效日期
                </th>
                <th scope="col" className="py-2">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((cell) => {
                const saving = savingKey === cell.key;
                return (
                  <tr key={cell.key} className="border-b last:border-0">
                    {dims.map((d, i) => (
                      <td key={d.field} className="py-2 pr-4">
                        {cell.labels[i] ?? String(cell.values[d.field] ?? "—")}
                      </td>
                    ))}
                    <td className="py-2 pr-3 text-right">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        className="h-8 w-28 text-right"
                        value={valueOf(cell)}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [cell.key]: e.target.value,
                          }))
                        }
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          cell.configured
                            ? "bg-success-muted text-success-muted-foreground"
                            : "bg-warning-muted text-warning-muted-foreground"
                        }`}
                      >
                        {cell.configured ? "客户配置" : "产品兜底"}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {cell.effective_from?.split("T")[0] ?? "—"}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canSave(cell) || saving}
                          onClick={() => {
                            const num = Number(valueOf(cell));
                            // 值没变就不写新版本：成本历史是审计线索，
                            // 塞满重复条目等于没有历史。
                            if (
                              cell.configured &&
                              cell.amount != null &&
                              num === cell.amount
                            ) {
                              onNotice?.("成本未变化，未写入新版本。");
                              return;
                            }
                            onSave(
                              {
                                product_key: matrix.product_key,
                                values: cell.values,
                                amount: num,
                                unit: cell.unit || "kg",
                              },
                              cell.key,
                            );
                          }}
                          className="gap-1"
                        >
                          {saving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Save className="size-3" />
                          )}
                          保存
                        </Button>
                        {cell.configured && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="修改这一格的成本（金额/单位/生效期/备注/状态）"
                            disabled={saving || cell.item_id == null}
                            onClick={() => onEdit?.(cell)}
                            className="gap-1"
                          >
                            <Pencil className="size-3" />
                            编辑
                          </Button>
                        )}
                        {cell.configured && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="停用自定义成本，回退到产品定义的兜底值"
                            disabled={saving}
                            onClick={() => onReset(cell)}
                            className="gap-1 text-muted-foreground"
                          >
                            <RotateCcw className="size-3" />
                            恢复兜底
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
          <p className="text-sm text-muted-foreground">
            本空间还没有客户配置过定价数据。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-4">
                    客户
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    已配置
                  </th>
                  <th scope="col" className="py-2">
                    已配置明细（{unitLabel}）
                  </th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr
                    key={c.customer_id}
                    className="border-b last:border-0 align-top"
                  >
                    <td className="py-2 pr-4">{c.customer_id}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          c.configured_count === total
                            ? "bg-success-muted text-success-muted-foreground"
                            : "bg-warning-muted text-warning-muted-foreground"
                        }`}
                      >
                        {c.configured_count} / {total}
                      </span>
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {c.rows
                        .filter((r) => r.configured)
                        .map((r) => `${r.labels.join(" · ")} = ${r.amount}`)
                        .join("；") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
