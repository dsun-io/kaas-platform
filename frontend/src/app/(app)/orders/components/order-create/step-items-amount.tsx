"use client";

/**
 * 第 3 步：货物与金额 —— 货物明细（可拖拽排序、行金额可直改）+ 运费/保险/其他，
 * 订单总额自动汇总（只读）。
 */
import { Plus, Trash2 } from "lucide-react";

import { SortableGrip, SortableList } from "@/components/shared/sortable-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  COMMON_QTY_UNITS,
  draftOrderTotal,
  itemDraftAmount,
  recalcItemAmount,
} from "@/lib/orders/order-create";
import { formatOrderMoney } from "@/lib/orders/order-detail";

import { orderItemId } from "./draft-ids";
import { useWizard } from "./wizard-context";

export function StepItemsAmount() {
  const {
    items,
    setItems,
    updateItem,
    removeItem,
    addItem,
    applyItems,
    freight,
    setFreight,
    insurance,
    setInsurance,
    other,
    setOther,
    syncPlanTotal,
    goodsAmount,
    total,
    info,
  } = useWizard();
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="w-8 p-2">
                <span className="sr-only">拖动排序</span>
              </th>
              <th scope="col" className="p-2">
                产品名称 *
              </th>
              <th scope="col" className="p-2">
                规格说明
              </th>
              <th scope="col" className="p-2">
                数量
              </th>
              <th scope="col" className="p-2">
                单位
              </th>
              <th scope="col" className="p-2">
                单价
              </th>
              <th scope="col" className="p-2">
                金额
              </th>
              <th scope="col" className="p-2" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="p-3 text-center text-xs text-muted-foreground"
                >
                  暂不填明细也可以继续（历史订单）——
                  需要时点下面「添加货物行」。
                </td>
              </tr>
            )}
            {/*
                  货物行排序：拖拽（2026-10-22）。
                  订单明细落库时按数组顺序写 `sort_order`，所以本地重排即"顺序已定"，
                  不需要额外接口。`containerAs="fragment"` + `itemAs="tr"`
                  是为了让行正好落在上面这个 `<tbody>` 里（包 div 会破坏表格布局）。
                */}
            <SortableList
              items={items}
              onReorder={setItems}
              // 明细草稿的主键叫 `key`（不是 `id`）——不改数据模型，交给调用方取
              getItemId={orderItemId}
              containerAs="fragment"
              itemAs="tr"
              itemClassName="border-b last:border-0"
              renderItem={(item, index) => (
                <>
                  <td className="p-1.5 align-middle">
                    <SortableGrip label={`拖动排序 第 ${index + 1} 行`} />
                  </td>
                  <td className="p-1.5">
                    <Input
                      aria-label={`第 ${index + 1} 行产品名称`}
                      className="h-8 text-xs"
                      value={item.product_name}
                      placeholder="如 勾花网 / Chain Link Fence"
                      onChange={(e) =>
                        updateItem(item.key, {
                          product_name: e.target.value,
                        })
                      }
                    />
                  </td>
                  <td className="p-1.5">
                    <Input
                      aria-label={`第 ${index + 1} 行规格`}
                      className="h-8 text-xs"
                      value={item.spec_text}
                      placeholder="如 2.5mm 热镀锌"
                      onChange={(e) =>
                        updateItem(item.key, { spec_text: e.target.value })
                      }
                    />
                  </td>
                  <td className="p-1.5">
                    <Input
                      aria-label={`第 ${index + 1} 行数量`}
                      className="h-8 w-20 text-xs"
                      inputMode="decimal"
                      value={item.qty}
                      onChange={(e) =>
                        applyItems(
                          items.map((row) =>
                            row.key === item.key
                              ? recalcItemAmount({
                                  ...row,
                                  qty: e.target.value,
                                })
                              : row,
                          ),
                        )
                      }
                    />
                  </td>
                  <td className="p-1.5">
                    <Input
                      aria-label={`第 ${index + 1} 行单位`}
                      className="h-8 w-20 text-xs"
                      list="order-qty-units"
                      value={item.qty_unit}
                      onChange={(e) =>
                        updateItem(item.key, { qty_unit: e.target.value })
                      }
                    />
                  </td>
                  <td className="p-1.5">
                    <Input
                      aria-label={`第 ${index + 1} 行单价`}
                      className="h-8 w-24 text-xs"
                      inputMode="decimal"
                      value={item.unit_price}
                      onChange={(e) =>
                        applyItems(
                          items.map((row) =>
                            row.key === item.key
                              ? recalcItemAmount({
                                  ...row,
                                  unit_price: e.target.value,
                                })
                              : row,
                          ),
                        )
                      }
                    />
                  </td>
                  <td className="p-1.5">
                    <Input
                      aria-label={`第 ${index + 1} 行金额`}
                      className="h-8 w-24 text-xs"
                      inputMode="decimal"
                      value={item.line_amount}
                      placeholder={itemDraftAmount(item).toFixed(2)}
                      onChange={(e) =>
                        updateItem(item.key, {
                          line_amount: e.target.value,
                          amount_touched: true,
                        })
                      }
                    />
                  </td>
                  <td className="p-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`删除第 ${index + 1} 行`}
                      onClick={() => removeItem(item.key)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </>
              )}
            />
          </tbody>
        </table>
      </div>
      <datalist id="order-qty-units">
        {COMMON_QTY_UNITS.map((unit) => (
          <option key={unit} value={unit} />
        ))}
      </datalist>
      <Button type="button" size="sm" variant="outline" onClick={addItem}>
        <Plus className="mr-1 h-4 w-4" />
        添加货物行
      </Button>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs font-medium">运费</span>
          <Input
            aria-label="运费"
            inputMode="decimal"
            value={freight}
            placeholder="0.00"
            onChange={(e) => {
              const value = e.target.value;
              setFreight(value);
              syncPlanTotal(
                draftOrderTotal({
                  items,
                  freight: value,
                  insurance,
                  other,
                }),
              );
            }}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">保险费</span>
          <Input
            aria-label="保险费"
            inputMode="decimal"
            value={insurance}
            placeholder="0.00"
            onChange={(e) => {
              const value = e.target.value;
              setInsurance(value);
              syncPlanTotal(
                draftOrderTotal({
                  items,
                  freight,
                  insurance: value,
                  other,
                }),
              );
            }}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">其他费用</span>
          <Input
            aria-label="其他费用"
            inputMode="decimal"
            value={other}
            placeholder="佣金、包装附加等"
            onChange={(e) => {
              const value = e.target.value;
              setOther(value);
              syncPlanTotal(
                draftOrderTotal({
                  items,
                  freight,
                  insurance,
                  other: value,
                }),
              );
            }}
          />
        </label>
      </div>

      <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">货物金额</dt>
          <dd className="tabular-nums">
            {formatOrderMoney(goodsAmount, info.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">运费</dt>
          <dd className="tabular-nums">
            {formatOrderMoney(Number(freight || 0), info.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">保险费</dt>
          <dd className="tabular-nums">
            {formatOrderMoney(Number(insurance || 0), info.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">其他费用</dt>
          <dd className="tabular-nums">
            {formatOrderMoney(Number(other || 0), info.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 sm:col-span-2">
          <dt className="font-medium">订单总额</dt>
          <dd className="font-semibold tabular-nums">
            {formatOrderMoney(total, info.currency)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
