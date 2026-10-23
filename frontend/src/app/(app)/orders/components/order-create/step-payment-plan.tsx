"use client";

/**
 * 第 4 步：收款计划 —— 30/70、50/50、100% 预付、自定义；比例变化自动算金额，
 * 改金额时反算比例只提示（不覆盖用户填的比例）；比例合计 > 100% 前端拦。
 */
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatOrderMoney } from "@/lib/orders/order-detail";
import {
  amountRatioHint,
  applyAmountChange,
  applyRatioChange,
  PAYMENT_PLAN_TEMPLATES,
  PLAN_SCHEDULE_TYPE_OPTIONS,
  sumPlanAmounts,
  sumPlanRatios,
} from "@/lib/orders/payment-plan";

import { useWizard } from "./wizard-context";

export function StepPaymentPlan() {
  const {
    plan,
    planTemplate,
    chooseTemplate,
    addPlanRow,
    updatePlanRow,
    removePlanRow,
    planValidation,
    total,
    info,
  } = useWizard();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {PAYMENT_PLAN_TEMPLATES.map((template) => (
          <Button
            key={template.id}
            type="button"
            size="sm"
            variant={planTemplate === template.id ? "secondary" : "outline"}
            onClick={() => chooseTemplate(template.id)}
          >
            {template.label}
          </Button>
        ))}
        <Button type="button" size="sm" variant="ghost" onClick={addPlanRow}>
          <Plus className="mr-1 h-4 w-4" />
          加一期
        </Button>
      </div>

      {plan.length === 0 && (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          还没有收款计划。选上面的模板一键生成，或点「加一期」手工填；
          也可以先不建计划，保存后在订单详情里补。
        </p>
      )}

      <div className="space-y-2">
        {plan.map((row, index) => {
          const hint = amountRatioHint(row, total);
          return (
            <div key={row.key} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">第 {index + 1} 期</span>
                <select
                  aria-label={`第 ${index + 1} 期类型`}
                  className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                  value={row.schedule_type}
                  onChange={(e) =>
                    updatePlanRow(row.key, {
                      schedule_type: e.target.value,
                    })
                  }
                >
                  {PLAN_SCHEDULE_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`删除第 ${index + 1} 期`}
                  onClick={() => removePlanRow(row.key)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    比例（%）
                  </span>
                  <Input
                    aria-label={`第 ${index + 1} 期比例`}
                    className="h-8 text-xs"
                    inputMode="decimal"
                    value={row.ratioPct}
                    placeholder="如 30"
                    onChange={(e) =>
                      updatePlanRow(
                        row.key,
                        applyRatioChange(row, e.target.value, total),
                      )
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    金额
                  </span>
                  <Input
                    aria-label={`第 ${index + 1} 期金额`}
                    className="h-8 text-xs"
                    inputMode="decimal"
                    value={row.amount}
                    placeholder="按比例自动算"
                    onChange={(e) =>
                      updatePlanRow(
                        row.key,
                        applyAmountChange(row, e.target.value),
                      )
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    到期日
                  </span>
                  <Input
                    aria-label={`第 ${index + 1} 期到期日`}
                    className="h-8 text-xs"
                    type="date"
                    value={row.due_date}
                    onChange={(e) =>
                      updatePlanRow(row.key, {
                        due_date: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    备注
                  </span>
                  <Input
                    aria-label={`第 ${index + 1} 期备注`}
                    className="h-8 text-xs"
                    value={row.notes}
                    onChange={(e) =>
                      updatePlanRow(row.key, { notes: e.target.value })
                    }
                  />
                </label>
              </div>
              {hint && <p className="text-[11px] text-warning">{hint}</p>}
            </div>
          );
        })}
      </div>

      <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">比例合计</dt>
          <dd className="tabular-nums">{sumPlanRatios(plan)}%</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">计划金额合计</dt>
          <dd className="tabular-nums">
            {formatOrderMoney(sumPlanAmounts(plan), info.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">订单总额</dt>
          <dd className="tabular-nums">
            {formatOrderMoney(total, info.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">差额</dt>
          <dd className="tabular-nums">
            {formatOrderMoney(sumPlanAmounts(plan) - total, info.currency)}
          </dd>
        </div>
      </dl>
      {planValidation.warnings.map((warning) => (
        <p key={warning} className="text-xs text-warning">
          {warning}
        </p>
      ))}
    </div>
  );
}
