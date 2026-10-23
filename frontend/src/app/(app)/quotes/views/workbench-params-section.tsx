"use client";

/**
 * 报价工作台 · 客户/参数区（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * 一行摘要（客户 / 询盘 / 币种 / 条款 / 利润率）+「选择客户/调整参数」开关；
 * 展开后是整单参数卡（`WorkbenchParamsCard`）。整单参数整单只有一份，
 * 行内参数才放各行卡片里 —— 避免用户每行各填一次、真填出不一致的值。
 */
import { Button } from "@/components/ui/button";

import type { QuoteWorkbenchController } from "./use-quote-workbench";
import { WorkbenchParamsCard } from "./workbench-params-card";

export function WorkbenchParamsSection({
  wb,
}: {
  wb: QuoteWorkbenchController;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span>
            客户：
            <b className="font-medium text-foreground">
              {wb.customer?.name ?? "未选择"}
            </b>
          </span>
          <span>
            询盘：
            <b className="font-medium text-foreground">
              {wb.selectedInquiry?.inquiry_no ??
                (wb.inquiryId ? `#${wb.inquiryId}` : "未选择")}
            </b>
          </span>
          <span>
            币种：
            <b className="font-medium text-foreground">{wb.quoteCurrency}</b>
          </span>
          <span>
            条款：
            <b className="font-medium text-foreground">{wb.effectiveQuoteAs}</b>
          </span>
          <span>
            利润率：
            <b className="font-medium text-foreground">{wb.profitPct}%</b>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => wb.setParamsOpen((v) => !v)}
          >
            {wb.paramsOpen ? "收起参数" : wb.customer ? "调整参数" : "选择客户"}
          </Button>
        </div>
      </div>

      {wb.paramsOpen && (
        <WorkbenchParamsCard
          customer={wb.customer}
          setCustomer={wb.setCustomer}
          customerError={wb.customerError}
          setCustomerError={wb.setCustomerError}
          inquiryId={wb.inquiryId}
          setInquiryId={wb.setInquiryId}
          inquiries={wb.inquiries}
          onCreateInquiry={() => wb.createInquiry.mutate()}
          creatingInquiry={wb.createInquiry.isPending}
          taxArchives={wb.taxArchives}
          taxArchiveId={wb.taxArchiveId}
          setTaxArchiveId={wb.setTaxArchiveId}
          applyTaxArchive={wb.applyTaxArchive}
          clearTaxArchive={wb.clearTaxArchive}
          inputVatRatePct={wb.inputVatRatePct}
          setInputVatRatePct={wb.setInputVatRatePct}
          giveRatioPct={wb.giveRatioPct}
          setGiveRatioPct={wb.setGiveRatioPct}
          outputVatRatePct={wb.outputVatRatePct}
          setOutputVatRatePct={wb.setOutputVatRatePct}
          rebateRatePct={wb.rebateRatePct}
          setRebateRatePct={wb.setRebateRatePct}
          miscTaxPct={wb.miscTaxPct}
          setMiscTaxPct={wb.setMiscTaxPct}
          profitPct={wb.profitPct}
          setProfitPct={wb.setProfitPct}
          profitAmountHint={wb.profitAmountHint}
          quoteCurrency={wb.quoteCurrency}
          setQuoteCurrency={wb.setQuoteCurrency}
          fxRate={wb.fxRate}
          setFxRate={wb.onFxRateChange}
          quoteDate={wb.quoteDate}
          setQuoteDate={wb.setQuoteDate}
          validityDays={wb.validityDays}
          setValidityDays={wb.setValidityDays}
          termsTemplate={wb.termsTemplate}
          termsQuery={wb.termsQuery}
          quoteAs={wb.effectiveQuoteAs}
          setQuoteAs={wb.setQuoteAs}
          carrier={wb.carrier}
          setCarrier={wb.setCarrier}
          feeInputs={wb.feeInputs}
          setFeeInputs={wb.setFeeInputs}
          freightFrom={wb.freightFrom}
          setFreightFrom={wb.setFreightFrom}
          freightTo={wb.freightTo}
          setFreightTo={wb.setFreightTo}
        />
      )}
    </>
  );
}
