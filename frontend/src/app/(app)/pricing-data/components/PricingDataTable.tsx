"use client";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Pencil, Trash2 } from "lucide-react";
import { categoryLabel } from "@contracts/categories";
import type { PricingEntry } from "../hooks/use-pricing-data";

interface Props {
  entries: PricingEntry[];
  loading: boolean;
  onEdit: (entry: PricingEntry) => void;
  onDelete: (id: number) => void;
  editingId: number | null;
}

function specSummary(spec: Record<string, unknown> | null) {
  if (!spec) return "—";
  const parts: string[] = [];
  if (spec.product_type) parts.push(spec.product_type as string);
  if (spec.wire_diameter) parts.push(`${spec.wire_diameter}丝径`);
  if (spec.height) parts.push(`${spec.height}m高`);
  if (spec.mesh_width) parts.push(`${spec.mesh_width}cm网宽`);
  if (spec.mesh_spec) parts.push(`${spec.mesh_spec}网孔`);
  if (spec.roll_length) parts.push(`${spec.roll_length}m长`);
  return parts.join(" | ") || "—";
}

export function PricingDataTable({
  entries,
  loading,
  onEdit,
  onDelete,
  editingId,
}: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">已有数据</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中...</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无数据，点击「新增」录入第一条规格与成本
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">品类</th>
                  <th className="py-2 pr-4">规格</th>
                  <th className="py-2 pr-4 text-right">成本</th>
                  <th className="py-2 pr-4">单位</th>
                  <th className="py-2 pr-4">生效日期</th>
                  <th className="py-2 pr-4">状态</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      {categoryLabel(entry.product_category)}
                    </td>
                    <td className="py-2 pr-4">
                      {specSummary(entry.product_spec)}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {entry.amount.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">{entry.unit}</td>
                    <td className="py-2 pr-4">
                      {entry.effective_from?.split("T")[0] ?? "—"}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          entry.status === "active"
                            ? "bg-green-100 text-green-700"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {entry.status}
                      </span>
                    </td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => onEdit(entry)}
                          disabled={editingId != null}
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-destructive hover:text-destructive"
                          onClick={() => onDelete(entry.id)}
                          disabled={editingId != null}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
