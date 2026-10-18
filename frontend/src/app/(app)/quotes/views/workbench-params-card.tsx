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
  TaxArchive,
} from "@contracts/export-quote";

const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "CNY"] as const;

// 全球主流船公司（用户口径：直接写死，中文名-英文缩写）
const CARRIERS = [
  "马士基-MSK",
  "地中海航运-MSC",
  "达飞轮船-CMA CGM",
  "中远海运-COSCO",
  "赫伯罗特-HPL",
  "长荣海运-EMC",
  "阳明海运-YML",
  "现代商船-HMM",
  "海洋网联-ONE",
  "东方海外-OOCL",
  "以星航运-ZIM",
  "万海航运-WHL",
  "太平船务-PIL",
  "宏海箱运-RCL",
  "高丽海运-KMTC",
  "兴亚海运-HEUNG-A",
];

export interface WorkbenchParamsCardProps {
  customer: CustomerPickerValue | null;
  setCustomer: (next: CustomerPickerValue | null) => void;
  customerError: string | null;
  setCustomerError: (v: string | null) => void;
  inquiryId: string;
  setInquiryId: (v: string) => void;
  /** 当前客户名下的询盘（下拉自动带出询盘编号，而不是让人手填数字 ID） */
  inquiries?: {
    id: number;
    inquiry_no?: string | null;
    product_name_raw?: string | null;
    status?: string | null;
  }[];
  /** 报价页直接新建询盘（不存在时自动给该客户创建） */
  onCreateInquiry?: () => void;
  creatingInquiry?: boolean;
  /** 团队税务档案（TAX-00 新口径：单下拉，选中后自动填税率） */
  taxArchives?: TaxArchive[];
  taxArchiveId: string;
  setTaxArchiveId: (v: string) => void;
  applyTaxArchive: (a: TaxArchive) => void;
  clearTaxArchive: () => void;
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
  /** 船公司（CFR/CIF/DAP/DDP 时使用；值「中文名-英文缩写」） */
  carrier: string;
  setCarrier: (v: string) => void;
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
    inquiries = [],
    onCreateInquiry,
    creatingInquiry = false,
    taxArchives = [],
    taxArchiveId,
    setTaxArchiveId,
    applyTaxArchive,
    clearTaxArchive,
    giveRatioPct,
    setGiveRatioPct,
    outputVatRatePct,
    setOutputVatRatePct,
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
    carrier,
    setCarrier,
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

  const selectedArchive = taxArchives.find(
    (a) => String(a.id) === taxArchiveId,
  );
  const samePct = (input: string, rate: number | undefined) =>
    rate == null ? input.trim() === "" : Number(input) === Number(rate * 100);
  const archiveModified = Boolean(
    selectedArchive &&
      !(
        samePct(outputVatRatePct, selectedArchive.tax_values.output_vat_rate) &&
        samePct(miscTaxPct, selectedArchive.tax_values.misc_fee_rate)
      ),
  );

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
            <div className="flex items-center justify-between">
              <Label className="text-xs">询盘编号</Label>
              {customer && onCreateInquiry && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  disabled={creatingInquiry}
                  onClick={onCreateInquiry}
                >
                  {creatingInquiry ? "创建中…" : "+ 新建询盘"}
                </Button>
              )}
            </div>
            <select
              value={inquiryId}
              onChange={(e) => setInquiryId(e.target.value)}
              disabled={!customer}
              className="h-8 w-full rounded-lg border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <option value="">
                {customer ? "（不关联询盘）" : "请先选客户"}
              </option>
              {inquiries.map((inq) => (
                <option key={inq.id} value={String(inq.id)}>
                  {inq.inquiry_no ?? `询盘 #${inq.id}`}
                  {inq.product_name_raw ? ` · ${inq.product_name_raw}` : ""}
                </option>
              ))}
              {inquiryId &&
                !inquiries.some((inq) => String(inq.id) === inquiryId) && (
                  <option value={inquiryId}>询盘 #{inquiryId}</option>
                )}
            </select>
            <p className="text-[11px] text-muted-foreground">
              编号由系统自动生成；从客户询盘页「为此询盘报价」进入时自动带入，
              也可在这里选择该客户名下的询盘。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">税务档案</Label>
            <select
              value={taxArchiveId}
              onChange={(e) => {
                const v = e.target.value;
                setTaxArchiveId(v);
                const archive = taxArchives.find((a) => String(a.id) === v);
                if (archive) applyTaxArchive(archive);
                else clearTaxArchive();
              }}
              className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">自定义（不套用档案）</option>
              {taxArchives.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.name}
                  {a.code ? `（${a.code}）` : ""}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 text-[11px]">
              {selectedArchive ? (
                <span
                  className={
                    archiveModified
                      ? "text-amber-700"
                      : "text-muted-foreground"
                  }
                >
                  {archiveModified
                    ? "本单已修改（档案本身未变）"
                    : `已套用：${selectedArchive.name}`}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  未选择档案，税率按当前填写的值
                </span>
              )}
              {archiveModified && selectedArchive && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => applyTaxArchive(selectedArchive)}
                >
                  恢复档案值
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 利润 / 杂税 / 让利（进项税、退税率按产品在税务管理里维护） */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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

          {["CFR", "CIF", "DAP", "DDP"].includes(quoteAs) && (
            <div className="space-y-1.5">
              <Label className="text-xs">船公司</Label>
              <select
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">请选择船公司</option>
                {CARRIERS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}

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
