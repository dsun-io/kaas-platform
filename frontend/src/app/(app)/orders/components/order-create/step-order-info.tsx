"use client";

/**
 * 第 2 步：订单信息（日期 / 币种 / 贸易术语 / 付款方式 / 装卸港 / 唛头 / 原产国 / 备注）。
 */
import { Input } from "@/components/ui/input";

import { useWizard } from "./wizard-context";

export function StepOrderInfo() {
  const { info, setInfoField } = useWizard();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1">
        <span className="text-xs font-medium">订单日期</span>
        <Input
          type="date"
          aria-label="订单日期"
          value={info.order_date}
          onChange={(e) => setInfoField("order_date", e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">交货日期</span>
        <Input
          type="date"
          aria-label="交货日期"
          value={info.delivery_date}
          onChange={(e) => setInfoField("delivery_date", e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">币种 *</span>
        <Input
          aria-label="币种"
          value={info.currency}
          placeholder="USD / EUR / CNY"
          maxLength={3}
          onChange={(e) =>
            setInfoField("currency", e.target.value.toUpperCase())
          }
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">贸易术语</span>
        <Input
          aria-label="贸易术语"
          value={info.incoterm}
          placeholder="如 FOB Tianjin / CIF Brisbane"
          onChange={(e) => setInfoField("incoterm", e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">付款方式</span>
        <Input
          aria-label="付款方式"
          value={info.payment_terms}
          placeholder="如 T/T 30% deposit, balance against B/L copy"
          onChange={(e) => setInfoField("payment_terms", e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">装运港</span>
        <Input
          aria-label="装运港"
          value={info.port_of_loading}
          placeholder="如 Xingang, Tianjin, China"
          onChange={(e) => setInfoField("port_of_loading", e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">目的港</span>
        <Input
          aria-label="目的港"
          value={info.port_of_destination}
          placeholder="如 Brisbane, Australia"
          onChange={(e) => setInfoField("port_of_destination", e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">唛头</span>
        <Input
          aria-label="唛头"
          value={info.shipping_marks}
          placeholder="无唛头填 N/M"
          onChange={(e) => setInfoField("shipping_marks", e.target.value)}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">原产国</span>
        <Input
          aria-label="原产国"
          value={info.country_of_origin}
          placeholder="如 China"
          onChange={(e) => setInfoField("country_of_origin", e.target.value)}
        />
      </label>
      <label className="space-y-1 sm:col-span-2">
        <span className="text-xs font-medium">备注</span>
        <Input
          aria-label="备注"
          value={info.notes}
          placeholder="如：2025 年线下签约的历史订单"
          onChange={(e) => setInfoField("notes", e.target.value)}
        />
      </label>
    </div>
  );
}
