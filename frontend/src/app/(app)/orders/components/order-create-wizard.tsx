"use client";

/**
 * 手工新建订单 · 五步向导（§6 + §13.3）—— **只做编排**。
 *
 * 步骤：
 * 1. 客户与来源：业务客户必选；关联报价可选（选中后带出币种/条款/货物行）；
 * 2. 订单信息：日期 / 币种 / 贸易条款 / 装卸港 / 唛头 / 原产国 / 备注；
 * 3. 货物与金额：明细行（可拖拽排序）+ 运费/保险/其他，总额自动；
 * 4. 收款计划：模板/自定义，比例↔金额联动，比例合计 > 100% 前端拦；
 * 5. 附件上传：合同 / PO / 信用证 + 导入已有单证（建单成功后逐个上传）。
 *
 * U-P1D2 拆分（行为/字段/aria/交互全部不变）：
 * · 数据与动作 → `order-create/use-order-create-wizard.ts`（返回值即 WizardApi，
 *   经 context 提供给步骤组件，避免 40+ props 逐层透传）；
 * · 每步 UI → `order-create/step-*.tsx`；步骤条 → `order-create/wizard-stepper.tsx`；
 * · 共享类型/步骤定义 → `order-create/types.ts`。
 */
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OrderOption } from "@/lib/workstation/use-upstream";

import { StepAttachments } from "./order-create/step-attachments";
import { StepCustomerSource } from "./order-create/step-customer-source";
import { StepItemsAmount } from "./order-create/step-items-amount";
import { StepOrderInfo } from "./order-create/step-order-info";
import { StepPaymentPlan } from "./order-create/step-payment-plan";
import { WIZARD_STEPS } from "./order-create/types";
import { useOrderCreateWizard } from "./order-create/use-order-create-wizard";
import { WizardContext } from "./order-create/wizard-context";
import { WizardStepper } from "./order-create/wizard-stepper";

export function OrderCreateWizard({
  onCreated,
}: {
  onCreated?: (order: OrderOption) => void;
}) {
  const wizard = useOrderCreateWizard({ onCreated });

  return (
    <WizardContext.Provider value={wizard}>
      <div className="space-y-4">
        <WizardStepper
          steps={WIZARD_STEPS}
          step={wizard.step}
          maxStep={wizard.maxStep}
          onGoTo={wizard.goTo}
        />

        {wizard.step === 0 && <StepCustomerSource />}
        {wizard.step === 1 && <StepOrderInfo />}
        {wizard.step === 2 && <StepItemsAmount />}
        {wizard.step === 3 && <StepPaymentPlan />}
        {wizard.step === 4 && <StepAttachments />}

        {wizard.error && (
          <p
            role="alert"
            className="flex items-center gap-1 text-xs text-destructive"
          >
            <AlertTriangle className="size-3.5" />
            {wizard.error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={wizard.step === 0 || wizard.creating}
            onClick={() => wizard.goTo(wizard.step - 1)}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            上一步
          </Button>
          {wizard.step < WIZARD_STEPS.length - 1 ? (
            <Button type="button" size="sm" onClick={wizard.goNext}>
              下一步
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={wizard.creating}
              onClick={() => void wizard.submit()}
            >
              <FilePlus2 className="mr-1 h-4 w-4" />
              {wizard.creating
                ? "建单中…"
                : `创建订单${wizard.attachmentCount > 0 ? `（${wizard.attachmentCount} 个附件）` : ""}`}
            </Button>
          )}
          {wizard.quoteIdNum && (
            <span className="text-xs text-muted-foreground">
              已关联报价 #{wizard.quoteIdNum}
            </span>
          )}
        </div>
      </div>
    </WizardContext.Provider>
  );
}
