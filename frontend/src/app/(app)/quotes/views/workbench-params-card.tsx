"use client";

/**
 * 报价工作台 · 整单参数卡（2026-10-18 优化版）
 *
 * 口径（用户确认）：
 *  - 税务档案只保留一个下拉 + 紧凑「存为档案」；
 *  - 利润只留利润率（%），金额由父组件算好后以小字只读回显；
 *  - 印花税 → 杂税（单一百分比 = 综合税费系数）；
 *  - 条款直选（默认 EXW），按所选条款只显示对应费用项；
 *  - 币种并入汇率控件：`1 [USD] = [7.1000] CNY`；
 *  - 报价日期默认今天、有效期默认 30 天；
 *  - 海运费有效期：一个日期范围控件（整单级）。
 */
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
import { termOptionLabel } from "../../quotations/v2-quote/components/freight-panel";
import { requiredFeeKeysFor } from "../lib/terms-amortize";
import type {
  ExportTermsTemplate,
  QuoteProfile,
} from "@contracts/export-quote";

interface RateSetOption {
  code: string;
  name?: string | null;
}

const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "CNY"] as const;

export interface WorkbenchParamsCardProps {
  customer: CustomerPickerValue | null;
  setCustomer: (next: CustomerPickerValue | null) => void;
  customerError: string | null;
  setCustomerError: (v: string | null) => void;
  inquiryId: string;
  setInquiryId: (v: string) => void;
  taxPick: string;
  setTaxPick: (v: string) => void;
  profiles: QuoteProfile[];
  rateSets: { data?: { rate_sets?: RateSetOption[] } };
  profileName: string;
  setProfileName: (v: string) => void;
  onSaveProfile: () => void;
  onDeleteProfile: (p: QuoteProfile) => void;
  saveProfile: { isPending: boolean };
  firstProductKey: string;
  applyProfile: (p: QuoteProfile) => void;
  clearProfileTax: () => void;
  setRateSetCode: (v: string) => void;
  inputVatRatePct: string;
  setInputVatRatePct: (v: string) => void;
  giveRatioPct: string;
  setGiveRatioPct: (v: string) => void;
  outputVatRatePct: string;
  setOutputVatRatePct: (v: string) => void;
  rebateRatePct: string;
  setRebateRatePct: (v: string) => void;
  miscTaxPct: string;
  setMiscTaxPct: (v: string) => void;
  profitPct: string;
  setProfitPct: (v: string) => void;
  /** 利润率对应金额（元/kg，只读小字；空 = 计算后显示） */
  profitAmountHint?: string;
  quoteCurrency: string;
  setQuoteCurrency: (v: string) => void;
  fxRate: string;
  setFxRate: (v: string) => void;
  quoteDate: string;
  setQuoteDate: (v: string) => void;
  validityDays: string;
  setValidityDays: (v: string) => void;
  termsTemplate: ExportTermsTemplate | null | undefined;
  termsQuery: { isError: boolean };
  quoteAs: string;
  setQuoteAs: (v: string) => void;
  feeInputs: Record<string, string>;
  setFeeInputs: (
    fn: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  freightFrom: string;
  setFreightFrom: (v: string) => void;
  freightTo: string;
  setFreightTo: (v: string) => void;
}

export function WorkbenchParamsCard(props: WorkbenchParamsCardProps) {
  const {
    customer,
    setCustomer,
    customerError,
    setCustomerError,
    inquiryId,
    setInquiryId,
    taxPick,
    setTaxPick,
    profiles,
    rateSets,
    profileName,
    setProfileName,
    onSaveProfile,
    onDeleteProfile,
    saveProfile,
    firstProductKey,
    applyProfile,
    clearProfileTax,
    setRateSetCode,
    inputVatRatePct,
    setInputVatRatePct,
    giveRatioPct,
    setGiveRatioPct,
    outputVatRatePct,
    setOutputVatRatePct,
    rebateRatePct,
    setRebateRatePct,
    miscTaxPct,
    setMiscTaxPct,
    profitPct,
    setProfitPct,
    profitAmountHint,
    quoteCurrency,
    setQuoteCurrency,
    fxRate,
    setFxRate,
    quoteDate,
    setQuoteDate,
    validityDays,
    setValidityDays,
    termsTemplate,
    termsQuery,
    quoteAs,
    setQuoteAs,
    feeInputs,
    setFeeInputs,
    freightFrom,
    setFreightFrom,
    freightTo,
    setFreightTo,
  } = props;

  const feeKeys = termsTemplate
    ? requiredFeeKeysFor(termsTemplate, quoteAs)
    : [];
  const showFreightValidity = feeKeys.includes("ocean_freight");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">整单参数</CardTitle>
        <CardDescription>
          客户、税务档案、利润/杂税、对外报价条款与汇率；这些参数整单只有一份。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 客户 / 询盘 / 税务档案 */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <CustomerPicker
            value={customer}
            onChange={(next) => {
              setCustomer(next);
              setCustomerError(null);
            }}
            required
            label="客户"
            error={customerError}
            hint="报价单要挂客户才能计入台账，也才会出现在客户页的「往来记录」"
          />

          <div className="space-y-1.5">
            <Label className="text-xs">询盘编号</Label>
            <Input
              value={inquiryId}
              onChange={(e) => setInquiryId(e.target.value)}
              placeholder="留空 = 不属于某个询盘"
              className="h-8 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              从询盘跳转时自动带入编号；一般无需手填
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">税务档案</Label>
            <select
              value={taxPick}
              onChange={(e) => {
                const v = e.target.value;
                setTaxPick(v);
                if (v.startsWith("profile:")) {
                  const p = profiles.find((x) => `profile:${x.id}` === v);
                  if (p) applyProfile(p);
                  return;
                }
                setRateSetCode(
                  v.startsWith("rate:") ? v.slice("rate:".length) : "",
                );
                clearProfileTax();
              }}
              className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">（未指定，按报价当期生效的一份）</option>
              {profiles.length > 0 && (
                <optgroup label="客户税率档案">
                  {profiles.map((p) => (
                    <option key={`profile:${p.id}`} value={`profile:${p.id}`}>
                      {p.profile_name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="法定税务档案">
                {(rateSets.data?.rate_sets ?? []).map((r) => (
                  <option key={`rate:${r.code}`} value={`rate:${r.code}`}>
                    {r.name || r.code}
                  </option>
                ))}
              </optgroup>
            </select>
            <div className="flex items-center gap-1.5">
              <Input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="档案名（存为常用税率）"
                className="h-7 text-[11px]"
                maxLength={60}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs"
                disabled={saveProfile.isPending || !firstProductKey}
                onClick={onSaveProfile}
              >
                存为档案
              </Button>
              {taxPick.startsWith("profile:") && (
                <button
                  type="button"
                  className="shrink-0 text-[11px] text-muted-foreground underline"
                  onClick={() => {
                    const p = profiles.find(
                      (x) => `profile:${x.id}` === taxPick,
                    );
                    if (p) onDeleteProfile(p);
                  }}
                >
                  移除
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 税率 / 利润 / 杂税 */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="供应商开票的税点（如 10%），用于换算含税采购价与进项税额"
            >
              进项票税点（%）
            </Label>
            <Input
              type="number"
              step="0.1"
              value={inputVatRatePct}
              onChange={(e) => setInputVatRatePct(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="按 HS 编码确定的出口退税率；未填按全额可退估算"
            >
              出口退税率（%）
            </Label>
            <Input
              type="number"
              step="0.1"
              value={rebateRatePct}
              onChange={(e) => setRebateRatePct(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="让出可退进项增值税额的比例（100% = 全部让利）"
            >
              让利比例（%）
            </Label>
            <Input
              type="number"
              step="1"
              value={giveRatioPct}
              onChange={(e) => setGiveRatioPct(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="销项增值税税率（出口零税率填 0）"
            >
              销项税率（%）
            </Label>
            <Input
              type="number"
              step="0.1"
              value={outputVatRatePct}
              onChange={(e) => setOutputVatRatePct(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="杂税 = 除销项增值税外的杂七杂八税费总和（综合税费系数）；售价 = 成本 ÷ (1 − 利润率 − 杂税)"
            >
              杂税（%）
            </Label>
            <Input
              type="number"
              step="0.1"
              value={miscTaxPct}
              onChange={(e) => setMiscTaxPct(e.target.value)}
              placeholder="默认 3"
              className="h-8 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              综合税费系数，按售价计征
            </p>
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="整单默认利润率（%）。售价 = 成本 ÷ (1 − 利润率 − 杂税)"
            >
              利润率（%）
            </Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.1"
                value={profitPct}
                onChange={(e) => setProfitPct(e.target.value)}
                className="h-8 text-xs"
              />
              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                {profitAmountHint || "≈ 计算后显示"}
              </span>
            </div>
          </div>
        </div>

        {/* 条款 / 币种汇率 / 日期 */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5">
            <Label className="text-xs">对外报价条款</Label>
            <select
              value={quoteAs}
              onChange={(e) => setQuoteAs(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {termsTemplate?.ladder.map((r) => (
                <option key={r.code} value={r.code}>
                  {termOptionLabel(r)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">汇率（1 外币 = ? CNY）</Label>
            <div className="flex items-stretch gap-0 overflow-hidden rounded-lg border border-input">
              <span className="flex items-center bg-muted px-2 text-xs">1</span>
              <select
                value={quoteCurrency}
                onChange={(e) => setQuoteCurrency(e.target.value)}
                className="h-8 border-x border-input bg-background px-2 text-xs focus-visible:outline-none"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <span className="flex items-center px-2 text-xs">=</span>
              <Input
                type="number"
                step="any"
                value={quoteCurrency === "CNY" ? "1" : fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                disabled={quoteCurrency === "CNY"}
                placeholder="按报价当日汇率"
                className="h-8 rounded-none border-0 text-xs focus-visible:ring-0"
              />
              <span className="flex items-center bg-muted px-2 text-xs">CNY</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              切币种会自动带入最新汇率；手改后以手填为准
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">报价日期</Label>
            <Input
              type="date"
              value={quoteDate}
              onChange={(e) => setQuoteDate(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">报价有效期（天）</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={validityDays}
              onChange={(e) => setValidityDays(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>

        {/* 海运费有效期：一个范围控件（整单级） */}
        {showFreightValidity && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">海运费有效期</Label>
              <div className="flex items-center gap-1 rounded-lg border border-input px-2">
                <Input
                  type="date"
                  value={freightFrom}
                  onChange={(e) => setFreightFrom(e.target.value)}
                  className="h-8 border-0 px-1 text-xs focus-visible:ring-0"
                />
                <span className="text-xs text-muted-foreground">~</span>
                <Input
                  type="date"
                  value={freightTo}
                  onChange={(e) => setFreightTo(e.target.value)}
                  className="h-8 border-0 px-1 text-xs focus-visible:ring-0"
                />
              </div>
            </div>
          </div>
        )}

        {/* 条款费用项：只显示所选条款累计需要的项 */}
        {termsQuery.isError && (
          <p className="text-xs text-destructive">
            出口费用模板加载失败，刷新重试
          </p>
        )}
        {termsTemplate && feeKeys.length > 0 && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <p className="text-xs font-medium">
              {quoteAs} 费用项（国内费用人民币；国外费用美元，按订单汇率折算）
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {feeKeys.map((key) => {
                const fee = termsTemplate.items[key];
                if (!fee) return null;
                return (
                  <div key={key} className="space-y-1.5">
                    <Label className="text-xs">
                      {fee.name}
                      {fee.unit_hint ? `（${fee.unit_hint}）` : ""}
                    </Label>
                    <Input
                      type="number"
                      step="any"
                      value={feeInputs[key] ?? ""}
                      onChange={(e) =>
                        setFeeInputs((p) => ({
                          ...p,
                          [key]: e.target.value,
                        }))
                      }
                      className="h-8 text-xs"
                    />
                    {fee.note && (
                      <p className="text-[11px] text-muted-foreground">
                        {fee.note}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
