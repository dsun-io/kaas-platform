"use client";

/**
 * 多产品报价工作台 —— 「一个询盘 → 多个产品 → 一张报价单 → 整套单证」。
 *
 * 与旧的单产品视图的关键区别：
 *   旧：一次只算一个产品的一组规格，算完只是屏幕上的数字（**不落库**）。
 *   新：整单承载 N 个产品行；每行独立规格/数量/利润覆盖；汇总展示；
 *       一行动作即可**存成一张报价单**，并由它生成整套单证（PI / 报价单 / 合同…）。
 *
 * 三条不变的口径（改动前请先读）：
 *  1. **共享参数放顶部、行内参数放行内**。币种/汇率/日期/税率/整批费用整单只有一份，
 *     放进行里会诱导用户"每行各填一次"，从而真填出不一致的值。
 *  2. **行小计 = 卷数 × 单卷外币价**（精确相乘），汇总 = Σ 行小计；
 *     单证 TOTAL 行也是逐行求和 —— 三处同源，才不会出现"报价工位 12,345.67、
 *     单证 12,345.66"这种查不出来的差分（见 lib/line-to-item.ts）。
 *  3. **试算不落库、草稿不落账**：算价只在内存里；台账只在"签发报价单"时写一条
 *     （后端 draft→sent 时入账）。
 */
import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

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
import { handleApiError } from "@/lib/api/error-handler";
import { cn } from "@/lib/utils";
import { getAvailableTemplates } from "@/lib/trade-doc/render";
import { useCustomerOptions } from "@/lib/workstation/use-upstream";
import type { QuoteProfile } from "@contracts/export-quote";

import { useExportRateSets, useExportTermsTemplate } from "../../quotations/v2-quote/hooks/use-export-quote-import";
import type { QuoteView } from "../../quotations/v2-quote/hooks/use-export-quote-calc";
import {
  useDeleteQuoteProfile,
  useQuoteProfiles,
  useSaveQuoteProfile,
} from "../../quotations/v2-quote/hooks/use-quote-profiles";
import { QuoteLineCard, newLineDraft, type LineDraft } from "../components/quote-line-card";
import { QuoteSummaryCard } from "../components/quote-summary-card";
import {
  useCreateQuoteOrder,
  useReplaceQuoteItems,
  useUpdateQuoteOrder,
} from "../hooks/use-quote-orders";
import { applySpaceDeduction, summarizeLines, type BuiltLineItem } from "../lib/line-to-item";
import { buildTermsPerLine } from "../lib/terms-amortize";
import type { ProfitMode, SharedQuoteParams, StampBase } from "../lib/build-request";
import apiClient from "@/lib/api/client";

/** 上次用过的汇率，避免每次报价重复输入（仅作预填，仍需业务确认）。 */
const FX_KEY = "kaas:last-fx-rate";

/** 印花税计税基数。`""` = 用法定档案里的值。 */
type StampBaseValue = StampBase;

/** 报价政策的默认值 —— 与后端默认政策等价，因此本身不改变任何金额。 */
const POLICY_DEFAULTS = {
  inputVatRatePct: "10",
  giveRatioPct: "80",
  outputVatRatePct: "0",
  rebateRatePct: "",
  stampRatePct: "",
  stampBase: "" as StampBaseValue,
};

/** 默认生成哪几种单证：按业务顺序的前两张（报价单 + 形式发票）。 */
const DEFAULT_DOC_PICK = ["quotation", "pi"];

export function QuoteWorkbenchView() {
  // ── 行 ───────────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<LineDraft[]>(() => [newLineDraft()]);
  const [view, setView] = useState<QuoteView>("customer");

  // ── 整单共享参数 ─────────────────────────────────────────────────────────
  const [customerId, setCustomerId] = useState("");
  const [inquiryId, setInquiryId] = useState("");
  const [rateSetCode, setRateSetCode] = useState("");
  const [inputVatRatePct, setInputVatRatePct] = useState(POLICY_DEFAULTS.inputVatRatePct);
  const [giveRatioPct, setGiveRatioPct] = useState(POLICY_DEFAULTS.giveRatioPct);
  const [outputVatRatePct, setOutputVatRatePct] = useState(POLICY_DEFAULTS.outputVatRatePct);
  const [rebateRatePct, setRebateRatePct] = useState(POLICY_DEFAULTS.rebateRatePct);
  const [stampRatePct, setStampRatePct] = useState(POLICY_DEFAULTS.stampRatePct);
  const [stampBase, setStampBase] = useState<StampBaseValue>(POLICY_DEFAULTS.stampBase);
  const [profitMode, setProfitMode] = useState<ProfitMode>("fixed");
  const [profitValue, setProfitValue] = useState("0.1");
  const [quoteCurrency, setQuoteCurrency] = useState("USD");
  const [fxRate, setFxRate] = useState("");
  const [quoteDate, setQuoteDate] = useState("");
  const [validityDays, setValidityDays] = useState("7");

  // ── 贸易术语（整批费用：整单填一次，按件数比例分摊给每行）──────────────────
  const [termsEnabled, setTermsEnabled] = useState(false);
  const [quoteAs, setQuoteAs] = useState("");
  const [feeInputs, setFeeInputs] = useState<Record<string, string>>({});

  // ── 报价单与单证 ─────────────────────────────────────────────────────────
  const [quoteOrderId, setQuoteOrderId] = useState<number | null>(null);
  const [savedDoc, setSavedDoc] = useState<{ id: number; quote_no: string; status: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [docPick, setDocPick] = useState<string[]>(DEFAULT_DOC_PICK);
  const [generating, setGenerating] = useState(false);

  const customers = useCustomerOptions();
  const rateSets = useExportRateSets();
  const termsQuery = useExportTermsTemplate();
  const create = useCreateQuoteOrder();
  const update = useUpdateQuoteOrder();
  const replaceItems = useReplaceQuoteItems();

  // 深链：从询盘/客户页跳进来时带上客户与询盘，省掉重复选择
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const cid = p.get("customer_id");
    const iid = p.get("inquiry_id");
    if (cid) setCustomerId(cid);
    if (iid) setInquiryId(iid);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(FX_KEY);
    if (saved) setFxRate(saved);
  }, []);

  const termsTemplate = termsQuery.data;
  const effectiveQuoteAs = quoteAs || termsTemplate?.quote_as || "CIF";

  // 整批费用：整单填一次，按**件数比例**摊到每行（分摊数学见 lib/terms-amortize.ts）
  const termsByLine = useMemo(() => {
    if (!termsEnabled || !termsTemplate) return null;
    const amounts: Record<string, number> = {};
    for (const key of Object.keys(termsTemplate.items ?? {})) {
      amounts[key] = Number(feeInputs[key]) || 0;
    }
    const { terms, amortized } = buildTermsPerLine(
      termsTemplate,
      amounts,
      lines.map((l) => Number(l.pieces) || 0),
    );
    return { terms, amortized };
  }, [termsEnabled, termsTemplate, feeInputs, lines]);

  const shared: SharedQuoteParams = useMemo(
    () => ({
      rateSetCode,
      fxRate,
      quoteCurrency,
      quoteDate,
      validityDays,
      inputVatRatePct,
      giveRatioPct,
      outputVatRatePct,
      rebateRatePct,
      stampRatePct,
      stampBase,
      profitMode,
      profitValue,
    }),
    [
      rateSetCode, fxRate, quoteCurrency, quoteDate, validityDays,
      inputVatRatePct, giveRatioPct, outputVatRatePct, rebateRatePct,
      stampRatePct, stampBase, profitMode, profitValue,
    ],
  );

  const computed: BuiltLineItem[] = useMemo(
    () => lines.map((l) => l.built).filter((b): b is BuiltLineItem => b !== null),
    [lines],
  );
  const summary = useMemo(() => summarizeLines(computed), [computed]);

  /**
   * 实际占用体积：按**产品定义声明的口径**扣减（牛栏网为每单扣 2.5 m³）。
   * 一张报价单里混用不同扣减口径的产品目前不存在；真出现时应拆单 ——
   * 把两套口径硬加在一起会把对外报运价的体积算错。
   */
  const effectiveVolume = useMemo(() => {
    const ded = lines.find((l) => l.built)?.spaceDeduction ?? null;
    return applySpaceDeduction(summary.totalBoxVolume, ded);
  }, [lines, summary.totalBoxVolume]);

  const missing = useMemo(
    () =>
      lines
        .map((l, i) => ({ index: i + 1, keys: l.built?.missing ?? [] }))
        .filter((m) => m.keys.length > 0),
    [lines],
  );

  // ── 客户税率档案（按「客户 + 产品」存，因此以第 1 行产品为准）──────────────
  const firstProductKey = lines[0]?.productKey || lines[0]?.result?.meta.product_key || "";
  const profilesQuery = useQuoteProfiles(firstProductKey || null);
  const saveProfile = useSaveQuoteProfile(firstProductKey);
  const deleteProfile = useDeleteQuoteProfile(firstProductKey);
  const profiles = profilesQuery.data?.profiles ?? [];
  const [taxPick, setTaxPick] = useState("");
  const [profileName, setProfileName] = useState("");

  const pctToRate = (text: string): number | undefined =>
    text === "" ? undefined : (Number(text) || 0) / 100;
  const rateToPct = (rate: number | undefined, fallback: string): string =>
    rate === undefined ? fallback : String(Math.round(rate * 100 * 1e6) / 1e6);

  const applyProfile = (p: QuoteProfile) => {
    const t = p.tax_overrides ?? {};
    setRateSetCode(p.rate_set_code);
    setInputVatRatePct(rateToPct(t.input_vat_rate, POLICY_DEFAULTS.inputVatRatePct));
    setOutputVatRatePct(rateToPct(t.output_vat_rate, POLICY_DEFAULTS.outputVatRatePct));
    setRebateRatePct(rateToPct(t.rebate_rate, POLICY_DEFAULTS.rebateRatePct));
    setStampRatePct(rateToPct(t.stamp_rate, POLICY_DEFAULTS.stampRatePct));
    setStampBase((t.stamp_base as StampBaseValue) ?? POLICY_DEFAULTS.stampBase);
  };

  const clearProfileTax = () => {
    setInputVatRatePct(POLICY_DEFAULTS.inputVatRatePct);
    setOutputVatRatePct(POLICY_DEFAULTS.outputVatRatePct);
    setRebateRatePct(POLICY_DEFAULTS.rebateRatePct);
    setStampRatePct(POLICY_DEFAULTS.stampRatePct);
    setStampBase(POLICY_DEFAULTS.stampBase);
  };

  const onSaveProfile = async () => {
    if (!profileName.trim() || !rateSetCode) {
      setNotice({ tone: "error", text: "请先填写档案名称并选定法定税务档案" });
      return;
    }
    try {
      const t = {
        ...(pctToRate(inputVatRatePct) !== undefined ? { input_vat_rate: pctToRate(inputVatRatePct) } : {}),
        ...(pctToRate(outputVatRatePct) !== undefined ? { output_vat_rate: pctToRate(outputVatRatePct) } : {}),
        ...(pctToRate(rebateRatePct) !== undefined ? { rebate_rate: pctToRate(rebateRatePct) } : {}),
        ...(pctToRate(stampRatePct) !== undefined ? { stamp_rate: pctToRate(stampRatePct) } : {}),
        ...(stampBase ? { stamp_base: stampBase } : {}),
      };
      const created = await saveProfile.mutateAsync({
        product_key: firstProductKey,
        profile_name: profileName.trim(),
        rate_set_code: rateSetCode,
        tax_overrides: t,
      });
      setProfileName("");
      setTaxPick(`profile:${created.id}`);
      setNotice({ tone: "info", text: `已保存档案「${created.profile_name}」（按客户 + 第 1 行产品存）` });
    } catch (err) {
      setNotice({ tone: "error", text: handleApiError(err as Parameters<typeof handleApiError>[0]) });
    }
  };

  const onDeleteProfile = async (p: QuoteProfile) => {
    try {
      await deleteProfile.mutateAsync(p.id);
      setTaxPick("");
      clearProfileTax();
      setNotice({ tone: "info", text: `已移除档案「${p.profile_name}」（历史报价不受影响）` });
    } catch (err) {
      setNotice({ tone: "error", text: handleApiError(err as Parameters<typeof handleApiError>[0]) });
    }
  };

  // ── 保存 / 签发 / 生成单证 ────────────────────────────────────────────────
  const headerPatch = () => ({
    customer_name: customers.data?.find((c) => String(c.id) === customerId)?.name ?? null,
    currency: quoteCurrency,
    valid_until: validUntil(),
    incoterm: termsEnabled ? effectiveQuoteAs : "EXW",
  });

  function validUntil(): string | null {
    const days = Number(validityDays) || 7;
    const base = quoteDate ? new Date(`${quoteDate}T00:00:00Z`) : new Date();
    if (Number.isNaN(base.getTime())) return null;
    const end = new Date(base.getTime() + days * 24 * 3600 * 1000);
    return end.toISOString().slice(0, 10);
  }

  const items = () =>
    computed.map((b, i) => ({
      ...b.item,
      sort_order: i,
      spec_snapshot: b.item.spec_snapshot,
    }));

  const onSave = async () => {
    if (computed.length === 0) {
      toast.error("请先计算至少一行");
      return;
    }
    setNotice(null);
    try {
      if (quoteOrderId === null) {
        const created = await create.mutateAsync({
          customer_id: customerId || null,
          customer_name: headerPatch().customer_name,
          inquiry_id: inquiryId ? Number(inquiryId) : null,
          currency: quoteCurrency,
          valid_until: validUntil(),
          incoterm: headerPatch().incoterm,
          // 可见范围默认 private（仅自己可见），与后端默认值一致
          owner_scope: "private",
          items: items(),
        });
        setQuoteOrderId(created.id);
        setSavedDoc({ id: created.id, quote_no: created.quote_no, status: created.status });
        setNotice({ tone: "info", text: `已保存为报价单 ${created.quote_no}` });
      } else {
        await update.mutateAsync({ id: quoteOrderId, patch: headerPatch() });
        const res = await replaceItems.mutateAsync({ id: quoteOrderId, items: items() });
        setSavedDoc({ id: quoteOrderId, quote_no: savedDoc?.quote_no ?? "", status: savedDoc?.status ?? "draft" });
        setNotice({
          tone: "info",
          text: `已保存（${res.items.length} 行，合计 ${res.total_amount ?? "—"}）`,
        });
      }
      window.localStorage.setItem(FX_KEY, fxRate);
    } catch (err) {
      setNotice({ tone: "error", text: handleApiError(err as Parameters<typeof handleApiError>[0]) });
    }
  };

  const onIssue = async () => {
    if (!quoteOrderId) return;
    setNotice(null);
    try {
      const updated = await update.mutateAsync({
        id: quoteOrderId,
        patch: { status: "sent" as const },
      });
      setSavedDoc({ id: updated.id, quote_no: updated.quote_no, status: updated.status });
      setNotice({ tone: "info", text: `${updated.quote_no} 已签发，并已向报价记录台账入账一条` });
    } catch (err) {
      setNotice({ tone: "error", text: handleApiError(err as Parameters<typeof handleApiError>[0]) });
    }
  };

  const onGenerateDocs = async () => {
    if (!quoteOrderId) {
      toast.error("请先保存报价单 —— 单证必须挂靠上游，才能继承货物与条款");
      return;
    }
    if (docPick.length === 0) {
      toast.error("请先选择要生成的单证类型");
      return;
    }
    setGenerating(true);
    setNotice(null);
    const created: string[] = [];
    const failed: string[] = [];
    for (const docType of docPick) {
      try {
        const { data } = await apiClient.post<{ doc_no: string }>("/trade-docs", {
          doc_type: docType,
          quote_order_id: quoteOrderId,
          currency: quoteCurrency,
        });
        created.push(data.doc_no);
      } catch {
        failed.push(docType);
      }
    }
    setGenerating(false);
    if (created.length > 0) {
      toast.success(`已生成 ${created.length} 张单证：${created.join("、")}`);
      setNotice({ tone: "info", text: `已生成：${created.join("、")}（到「单证」工位预览/签发）` });
    }
    if (failed.length > 0) {
      setNotice({ tone: "error", text: `以下类型生成失败：${failed.join("、")}` });
    }
  };

  const docTypes = useMemo(
    () =>
      getAvailableTemplates()
        .filter((t) => [
          "quotation", "pi", "contract", "ci", "pl", "shipping_advice",
          "weight_list", "quality_cert", "co", "customs_declaration",
        ].includes(t.doc_type))
        .map((t) => ({ value: t.doc_type, label: t.name_zh })),
    [],
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">整单参数</CardTitle>
          <CardDescription>
            这些参数整单只有一份（所有产品行共用）—— 币种、汇率、税率、报价日期与整批费用。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">客户</Label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">（未指定）</option>
                {(customers.data ?? []).map((c) => (
                  <option key={String(c.id)} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                报价单要挂客户才能计入台账
              </p>
            </div>

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
                  setRateSetCode(v.startsWith("rate:") ? v.slice("rate:".length) : "");
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
              <Label className="text-xs">档案名称</Label>
              <div className="flex gap-1.5">
                <Input
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="存为档案时的名字"
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
              <Label className="text-xs">进项票税点（%）</Label>
              <Input type="number" step="0.1" value={inputVatRatePct}
                onChange={(e) => setInputVatRatePct(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">出口退税率（%）</Label>
              <Input type="number" step="0.1" value={rebateRatePct}
                onChange={(e) => setRebateRatePct(e.target.value)} className="h-8 text-xs" />
              <p className="text-[11px] text-muted-foreground">
                {rebateRatePct === "" ? "⚠ 未填：按进项税额全额可退估算，报价可能偏低" : "按 HS 核实"}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">让利比例（%）</Label>
              <Input type="number" step="1" value={giveRatioPct}
                onChange={(e) => setGiveRatioPct(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">销项税率（%）</Label>
              <Input type="number" step="0.1" value={outputVatRatePct}
                onChange={(e) => setOutputVatRatePct(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">印花税率（%）</Label>
              <Input type="number" step="0.01" placeholder="留空 = 用档案法定值" value={stampRatePct}
                onChange={(e) => setStampRatePct(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">印花税计税基数</Label>
              <select value={stampBase}
                onChange={(e) => setStampBase(e.target.value as StampBaseValue)}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">跟随档案（现为加工利润）</option>
                <option value="profit">加工利润</option>
                <option value="cost">税前成本</option>
                <option value="base_quote">基础报价</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">整单默认加工利润（元/kg）</Label>
              <div className="flex gap-1.5">
                <Input type="number" step="0.01" value={profitValue}
                  onChange={(e) => { setProfitValue(e.target.value); setProfitMode("fixed"); }}
                  className="h-8 text-xs" />
                <Input type="number" step="0.1" placeholder="利润率%" value={profitMode === "ratio" ? profitValue : ""}
                  onChange={(e) => { setProfitValue(e.target.value); setProfitMode("ratio"); }}
                  className="h-8 text-xs" />
              </div>
              <p className="text-[11px] text-muted-foreground">
                左侧填金额、右侧填利润率，改哪个用哪个；逐行可覆盖
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">报价币种</Label>
              <select value={quoteCurrency} onChange={(e) => setQuoteCurrency(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "CNY"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">汇率（1 CNY = ? {quoteCurrency}）</Label>
              <Input type="number" step="0.0001" value={fxRate}
                onChange={(e) => setFxRate(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">报价日期</Label>
              <Input type="date" value={quoteDate}
                onChange={(e) => setQuoteDate(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">报价有效期（天）</Label>
              <Input type="number" min={1} max={365} value={validityDays}
                onChange={(e) => setValidityDays(e.target.value)} className="h-8 text-xs" />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={termsEnabled}
                onChange={(e) => setTermsEnabled(e.target.checked)} />
              启用出口费用（FOB / CFR / CIF）—— 不启用则按**出厂价 EXW**报价
            </label>
            {termsEnabled && termsTemplate && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">对外报价条款</Label>
                    <select value={effectiveQuoteAs} onChange={(e) => setQuoteAs(e.target.value)}
                      className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {termsTemplate.ladder.map((r) => (
                        <option key={r.code} value={r.code}>{r.label || r.code}</option>
                      ))}
                    </select>
                  </div>
                  {Object.entries(termsTemplate.items ?? {}).map(([key, fee]) => (
                    <div key={key} className="space-y-1.5">
                      <Label className="text-xs">{fee.name}{fee.unit_hint ? `（${fee.unit_hint}）` : ""}</Label>
                      <Input type="number" step="any" value={feeInputs[key] ?? ""}
                        onChange={(e) => setFeeInputs((p) => ({ ...p, [key]: e.target.value }))}
                        className="h-8 text-xs" />
                      {fee.note && <p className="text-[11px] text-muted-foreground">{fee.note}</p>}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  整批费用按**件数比例**分摊到每个产品行；摊到单卷后各行一致，逐行累加等于整批金额。
                </p>
              </>
            )}
            {termsEnabled && termsQuery.isError && (
              <p className="text-xs text-destructive">费用结构加载失败，请刷新重试</p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <div className="space-y-1.5">
              <Label className="text-xs">结果视图</Label>
              <div className="flex gap-2">
                {([["customer", "客户视图"], ["internal", "内部核算"]] as [QuoteView, string][]).map(
                  ([k, label]) => (
                    <button key={k} type="button"
                      onClick={() => { setView(k); setLines((prev) => prev.map((l) => ({ ...l, result: null, built: null }))); }}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-xs transition-colors",
                        view === k
                          ? "border-primary bg-primary/10 font-medium text-foreground"
                          : "border-input text-muted-foreground hover:text-foreground",
                      )}>
                      {label}
                    </button>
                  ),
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              客户视图不含成本、利润与税额；内部核算需要管理员权限。
              切换视图后行结果需重新计算。
            </p>
          </div>
        </CardContent>
      </Card>

      {lines.map((line, index) => (
        <QuoteLineCard
          key={line.id}
          index={index}
          line={line}
          shared={shared}
          view={view}
          terms={termsByLine?.terms[index] ?? null}
          lineCount={lines.length}
          onChange={(patch) =>
            setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, ...patch } : l)))
          }
          onRemove={() => setLines((prev) => prev.filter((l) => l.id !== line.id))}
        />
      ))}

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => setLines((prev) => [...prev, newLineDraft(prev[0]?.productKey ?? "")])}
      >
        <Plus className="mr-1.5 size-4" />
        再添加一个产品
      </Button>

      <QuoteSummaryCard
        summary={summary}
        currency={quoteCurrency}
        effectiveVolume={effectiveVolume}
        missing={missing}
        amortizedFees={termsByLine?.amortized ?? []}
        docTypes={docTypes}
        docPick={docPick}
        onDocPickChange={setDocPick}
        onGenerateDocs={onGenerateDocs}
        onSave={onSave}
        onIssue={onIssue}
        saving={create.isPending || update.isPending || replaceItems.isPending}
        issuing={update.isPending}
        generating={generating}
        saved={savedDoc}
        notice={notice}
      />
    </div>
  );
}
