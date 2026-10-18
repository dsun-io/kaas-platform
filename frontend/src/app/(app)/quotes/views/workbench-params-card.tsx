"use client";

/**
 * 报价工作台 · 整单参数卡（从 quote-workbench-view 拆出）。
 *
 * 与 product-quote-view 的巨石拆分同口径：**只搬 JSX**，state 与业务逻辑
 * （档案套用/利润换算/结果视图清结果）全留在父组件。props 用原 state/setter
 * 同名（setCustomer/setInputVatRatePct…）—— JSX 搬移零改名，typecheck 兜漏。
 *
 * 业务口径（逐字保留）：客户必选（报价是所有单据的唯一根入口）、税务档案
 * 两层配套、利润金额/利润率双输入互为覆盖、整批费用按件数比例分摊。
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
import { cn } from "@/lib/utils";
import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
// 术语选项的显示格式与运费面板共用一处实现（`代码 · 中文（English）`）——
// 两个下拉如果各写一份拼接逻辑，迟早会出现同一档位两种写法。
import { termOptionLabel } from "../../quotations/v2-quote/components/freight-panel";
import type {
  ExportTermsTemplate,
  QuoteProfile,
} from "@contracts/export-quote";
import type { QuoteView } from "../../quotations/v2-quote/hooks/use-export-quote-calc";
import type { LineDraft } from "../components/quote-line-card";

type StampBaseValue = "" | "profit" | "cost" | "base_quote";
type ProfitMode = "fixed" | "ratio";

interface RateSetOption {
  code: string;
  name?: string | null;
}

export interface WorkbenchParamsCardProps {
  customer: CustomerPickerValue | null;
  setCustomer: (next: CustomerPickerValue | null) => void;
  customerError: string | null;
  setCustomerError: (v: string | null) => void;
  inquiryId: string;
  setInquiryId: (v: string) => void;
  taxPick: string;
  setTaxPick: (v: string) => void;
  setNotice: (n: { tone: "info" | "error"; text: string } | null) => void;
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
  stampRatePct: string;
  setStampRatePct: (v: string) => void;
  stampBase: StampBaseValue;
  setStampBase: (v: StampBaseValue) => void;
  profitValue: string;
  setProfitValue: (v: string) => void;
  profitMode: ProfitMode;
  setProfitMode: (v: ProfitMode) => void;
  quoteCurrency: string;
  setQuoteCurrency: (v: string) => void;
  fxRate: string;
  setFxRate: (v: string) => void;
  quoteDate: string;
  setQuoteDate: (v: string) => void;
  validityDays: string;
  setValidityDays: (v: string) => void;
  termsEnabled: boolean;
  setTermsEnabled: (v: boolean) => void;
  termsTemplate: ExportTermsTemplate | null | undefined;
  termsQuery: { isError: boolean };
  effectiveQuoteAs: string;
  setQuoteAs: (v: string) => void;
  feeInputs: Record<string, string>;
  setFeeInputs: (
    fn: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  view: QuoteView;
  setView: (v: QuoteView) => void;
  setLines: (fn: (prev: LineDraft[]) => LineDraft[]) => void;
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
    setNotice,
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
    stampRatePct,
    setStampRatePct,
    stampBase,
    setStampBase,
    profitValue,
    setProfitValue,
    profitMode,
    setProfitMode,
    quoteCurrency,
    setQuoteCurrency,
    fxRate,
    setFxRate,
    quoteDate,
    setQuoteDate,
    validityDays,
    setValidityDays,
    termsEnabled,
    setTermsEnabled,
    termsTemplate,
    termsQuery,
    effectiveQuoteAs,
    setQuoteAs,
    feeInputs,
    setFeeInputs,
    view,
    setView,
    setLines,
  } = props;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">整单参数</CardTitle>
        <CardDescription>
          这些参数整单只有一份（所有产品行共用）——
          币种、汇率、税率、报价日期与整批费用。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
              一个询盘一张报价单；改价重报可再存一张
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">税务档案</Label>
            <select
              value={taxPick}
              onChange={(e) => {
                const v = e.target.value;
                setTaxPick(v);
                setNotice(null);
                if (v.startsWith("profile:")) {
                  const p = profiles.find((x) => `profile:${x.id}` === v);
                  if (p) applyProfile(p);
                  return;
                }
                // 切回法定档案 = 不再套用客户档案 → 税率项回到默认。
                // 不这么做的话，用户以为"取消套用了"，实际还在用档案里的数字。
                setRateSetCode(
                  v.startsWith("rate:") ? v.slice("rate:".length) : "",
                );
                clearProfileTax();
              }}
              className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">（未指定，按报价当期生效的一份）</option>
              {profiles.length > 0 && (
                <optgroup label="客户税率档案（按客户 + 第 1 行产品）">
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
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">客户税率档案名称</Label>
            <div className="flex gap-1.5">
              <Input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="按客户+产品存的常用税率组合名"
                className="h-8 text-xs"
                maxLength={60}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 text-xs"
                disabled={saveProfile.isPending || !firstProductKey}
                onClick={onSaveProfile}
              >
                存为档案
              </Button>
            </div>
            {taxPick.startsWith("profile:") && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline"
                onClick={() => {
                  const p = profiles.find((x) => `profile:${x.id}` === taxPick);
                  if (p) void onDeleteProfile(p);
                }}
              >
                移除该档案
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="供应商开票的税点（如 10%）。用于换算含税采购价、进项税额，以及「可退进项税额 = 进项税额 × 退税率 ÷ 票税点」"
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
              title="按产品 HS 编码确定的出口退税率。可退进项增值税税额 = 进项税额 × (退税率 ÷ 票税点)，未填时按全额可退估算（报价会偏高）"
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
            <p className="text-[11px] text-muted-foreground">
              {rebateRatePct === ""
                ? "⚠ 未填：按进项税额全额可退估算，报价可能偏低"
                : "按 HS 核实"}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="让出可退进项增值税额的比例（100% = 全部让利给客户换竞争力，0% = 自留对冲风险）。让利额 = 可退进项税额 × 让利比例"
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
              title="销项增值税税率（出口零税率填 0）。计税基数是售价不是成本：销项税额 = 不含税售价 × 销项税率"
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
              title="印花税率。margin_on_price 售价加成模式下已并入「综合税费系数」（0.03），此处不再单独计征"
            >
              印花税率（%）
            </Label>
            <Input
              type="number"
              step="0.01"
              placeholder="留空 = 用档案法定值"
              value={stampRatePct}
              onChange={(e) => setStampRatePct(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">印花税计税基数</Label>
            <select
              value={stampBase}
              onChange={(e) => setStampBase(e.target.value as StampBaseValue)}
              className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">跟随档案（现为加工利润）</option>
              <option value="profit">加工利润</option>
              <option value="cost">税前成本</option>
              <option value="base_quote">基础报价</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-xs"
              title="整单默认加工利润。多产品报价时各行可单独覆盖；留空则所有行用此值。固定额模式 = 元/kg，利润率模式 = 税前成本 × 利润率"
            >
              整单默认加工利润
            </Label>
            <div className="flex gap-1.5">
              <Input
                type="number"
                step="0.01"
                value={profitValue}
                onChange={(e) => {
                  setProfitValue(e.target.value);
                  setProfitMode("fixed");
                }}
                className="h-8 text-xs"
              />
              <Input
                type="number"
                step="0.1"
                placeholder="利润率%"
                value={profitMode === "ratio" ? profitValue : ""}
                onChange={(e) => {
                  setProfitValue(e.target.value);
                  setProfitMode("ratio");
                }}
                className="h-8 text-xs"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              左侧填金额、右侧填利润率，改哪个用哪个；逐行可覆盖
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">报价币种</Label>
            <select
              value={quoteCurrency}
              onChange={(e) => setQuoteCurrency(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "CNY"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">汇率（1 CNY = ? {quoteCurrency}）</Label>
            <Input
              type="number"
              step="0.0001"
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
              className="h-8 text-xs"
            />
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

        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={termsEnabled}
              onChange={(e) => setTermsEnabled(e.target.checked)}
            />
            启用出口费用（FOB / CFR / CIF / DAP / DDP）—— 不启用则按**出厂价 EXW**报价
          </label>
          {termsEnabled && termsTemplate && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">对外报价条款</Label>
                  <select
                    value={effectiveQuoteAs}
                    onChange={(e) => setQuoteAs(e.target.value)}
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {termsTemplate.ladder.map((r) => (
                      <option key={r.code} value={r.code}>
                        {termOptionLabel(r)}
                      </option>
                    ))}
                  </select>
                </div>
                {Object.entries(termsTemplate.items ?? {}).map(([key, fee]) => (
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
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                整批费用按**件数比例**分摊到每个产品行；摊到单卷后各行一致，逐行累加等于整批金额。
              </p>
            </>
          )}
          {termsEnabled && termsQuery.isError && (
            <p className="text-xs text-destructive">
              费用结构加载失败，请刷新重试
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="space-y-1.5">
            <Label className="text-xs">结果视图</Label>
            <div className="flex gap-2">
              {(
                [
                  ["customer", "客户视图"],
                  ["internal", "内部核算"],
                ] as [QuoteView, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setView(k);
                    setLines((prev) =>
                      prev.map((l) => ({ ...l, result: null, built: null })),
                    );
                  }}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs transition-colors",
                    view === k
                      ? "border-primary bg-primary/10 font-medium text-foreground"
                      : "border-input text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            客户视图不含成本、利润与税额；内部核算需要管理员权限。
            切换视图后行结果需重新计算。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
