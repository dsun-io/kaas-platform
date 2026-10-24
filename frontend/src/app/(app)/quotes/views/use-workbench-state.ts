"use client";

/**
 * 报价工作台 · 状态层（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * 只负责「数据」：表单状态、参考数据查询、派生金额/体积、税务档案联动。
 * 提交动作在 `use-workbench-actions.ts`；UI 在各 `workbench-*` 组件里。
 *
 * 三条口径（与拆分前逐字一致，改动前请先读 view 顶部注释）：
 *  1. 共享参数整单一份（币种/汇率/日期/税率/整批费用），行内参数才放行里；
 *  2. 行小计 = 卷数 × 单卷外币价，汇总 = Σ 行小计（与单证 TOTAL 同源）；
 *  3. 试算不落库、草稿不落账。
 */
import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizeApiError } from "@/lib/api/api-error";
import { useAuth } from "@/lib/auth/auth-context";
import apiClient from "@/lib/api/client";
import { useLatestFxRate } from "@/lib/fx/use-latest-fx";
import { getAvailableTemplates } from "@/lib/trade-doc/render";
import { useCustomerName } from "@/lib/workstation/use-upstream";
import type { CustomerPickerValue } from "@/components/customer-picker";
import type { ProductTaxRate, TaxArchive } from "@contracts/export-quote";

import {
  useExportProducts,
  useExportTermsTemplate,
} from "../hooks/use-export-quote-import";
import type { QuoteView } from "../hooks/use-export-quote-calc";
import { newLineDraft, type LineDraft } from "../components/quote-line-card";
import { resetNameOnCustomerChange } from "../lib/product-name-selection";
import type { DocTypeOption } from "../components/quote-summary-card";
import {
  useCreateQuoteOrder,
  useReplaceQuoteItems,
  useUpdateQuoteOrder,
} from "../hooks/use-quote-orders";
import {
  applySpaceDeduction,
  summarizeLines,
  type BuiltLineItem,
  type QuoteSummary,
} from "../lib/line-to-item";
import { allocateInsurance, buildTermsPerLine } from "../lib/terms-amortize";
import type { SharedQuoteParams } from "../lib/build-request";
import {
  DEFAULT_DOC_PICK,
  POLICY_DEFAULTS,
  rateToPct,
  todayISO,
  type InquiryOption,
  type ProductTaxMap,
  type SavedQuoteDoc,
  type WorkbenchNotice,
} from "./workbench-shared";

type QuoteMutations = {
  create: ReturnType<typeof useCreateQuoteOrder>;
  update: ReturnType<typeof useUpdateQuoteOrder>;
  replaceItems: ReturnType<typeof useReplaceQuoteItems>;
};

type CreateInquiryMutation = ReturnType<
  typeof useMutation<{ id: number; inquiry_no?: string | null }, Error, void>
>;

/** 工作台状态层对外暴露的完整形状（供各 `workbench-*` 组件消费）。 */
export interface WorkbenchState {
  // ── 产品行 ────────────────────────────────────────────────────────────
  lines: LineDraft[];
  setLines: Dispatch<SetStateAction<LineDraft[]>>;
  /** 结果视图不再由用户选择：内部账号看内部视图，其余账号看客户视图 */
  view: QuoteView;

  // ── 客户 / 询盘 / 参数卡开合 ───────────────────────────────────────────
  customer: CustomerPickerValue | null;
  setCustomer: (next: CustomerPickerValue | null) => void;
  customerError: string | null;
  setCustomerError: (v: string | null) => void;
  paramsOpen: boolean;
  setParamsOpen: Dispatch<SetStateAction<boolean>>;
  /** 建单时定下的客户：报价单的客户在创建那一刻确定，事后改客户不生效 */
  createdCustomerId: string | null;
  setCreatedCustomerId: (v: string | null) => void;
  inquiryId: string;
  setInquiryId: (v: string) => void;
  inquiries: InquiryOption[];
  selectedInquiry: InquiryOption | undefined;
  createInquiry: CreateInquiryMutation;
  customerName: string;
  customerLabel: string;

  // ── 整单共享参数 ───────────────────────────────────────────────────────
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
  quoteCurrency: string;
  setQuoteCurrency: (v: string) => void;
  fxRate: string;
  /** 手改汇率：标记 touched，之后不再被自动汇率覆盖 */
  onFxRateChange: (v: string) => void;
  quoteDate: string;
  setQuoteDate: (v: string) => void;
  validityDays: string;
  setValidityDays: (v: string) => void;

  // ── 贸易术语 / 整批费用 ────────────────────────────────────────────────
  quoteAs: string;
  setQuoteAs: (v: string) => void;
  effectiveQuoteAs: string;
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
  termsTemplate: ReturnType<typeof useExportTermsTemplate>["data"];
  termsQuery: {
    isError: boolean;
    error?: unknown;
    /** 模板加载失败时页内 ErrorState 的重试入口 */
    refetch: () => unknown;
  };

  // ── 税务档案（TAX-00：单下拉，选中自动填四税率）────────────────────────
  taxArchives: TaxArchive[];
  taxArchiveId: string;
  setTaxArchiveId: (v: string) => void;
  applyTaxArchive: (a: TaxArchive) => void;
  clearTaxArchive: () => void;
  selectedTaxArchive: TaxArchive | undefined;

  // ── 派生数据 ──────────────────────────────────────────────────────────
  shared: SharedQuoteParams;
  computed: BuiltLineItem[];
  summary: QuoteSummary;
  profitAmountHint: string;
  effectiveVolume: number | null;
  missing: { index: number; keys: string[] }[];
  termsByLine: ReturnType<typeof buildTermsPerLine> | null;
  productTaxMap: ProductTaxMap;
  productOptions: ReturnType<typeof useExportProducts>;
  calcSignal: number;
  setCalcSignal: Dispatch<SetStateAction<number>>;

  // ── 报价单 / 单证 ─────────────────────────────────────────────────────
  quoteOrderId: number | null;
  setQuoteOrderId: (v: number | null) => void;
  savedDoc: SavedQuoteDoc | null;
  setSavedDoc: (v: SavedQuoteDoc | null) => void;
  notice: WorkbenchNotice | null;
  setNotice: (v: WorkbenchNotice | null) => void;
  docPick: string[];
  setDocPick: (v: string[]) => void;
  docTypes: DocTypeOption[];
  generating: boolean;
  setGenerating: Dispatch<SetStateAction<boolean>>;
  /** 建单/改单/行项替换中（按钮禁用口径） */
  saving: boolean;

  // ── 动作层需要但界面不直接用的内部件 ───────────────────────────────────
  mutations: QuoteMutations;
  queryClient: ReturnType<typeof useQueryClient>;
}

export function useWorkbenchState(): WorkbenchState {
  // ── 行 ───────────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<LineDraft[]>(() => [newLineDraft()]);
  const { user: authUser } = useAuth();
  const view: QuoteView =
    authUser?.account_type === "internal" ? "internal" : "customer";

  // ── 整单共享参数 ─────────────────────────────────────────────────────────
  // 客户是**必选**的：报价是所有单据的唯一根入口，客户空着的话
  // 客户页的「往来记录」树就找不到这张报价，台账也统计不到。
  const [customer, setCustomerState] = useState<CustomerPickerValue | null>(
    null,
  );
  /**
   * 换客户（A 项 2026-10-24）：英文名是**按客户**选的 —— 手动选过的行保留（那是业务对
   * 那个客户的明确选择），其余行清空 nameEn，由行卡按新客户的历史偏好重新解析默认名。
   *
   * 只在这里（用户换客户）调用；草稿初始化/恢复不要走这个包装，否则会误清已解析的名。
   * 签名保持 (next) => void（UI 的 CustomerPicker 只传值）。
   */
  const setCustomer = (next: CustomerPickerValue | null) => {
    setCustomerState(next);
    setLines((prev) => resetNameOnCustomerChange(prev));
  };
  const [customerError, setCustomerError] = useState<string | null>(null);
  /** 整单参数默认收起：首屏优先产品行与右侧汇总；点「选择客户/调整参数」展开。 */
  const [paramsOpen, setParamsOpen] = useState(false);
  const [createdCustomerId, setCreatedCustomerId] = useState<string | null>(
    null,
  );
  const [inquiryId, setInquiryId] = useState("");
  const [quoteOrderId, setQuoteOrderId] = useState<number | null>(null);
  const [savedDoc, setSavedDoc] = useState<SavedQuoteDoc | null>(null);
  const [notice, setNotice] = useState<WorkbenchNotice | null>(null);
  const [docPick, setDocPick] = useState<string[]>(DEFAULT_DOC_PICK);
  const [generating, setGenerating] = useState(false);

  // 当前客户的询盘列表：报价页直接显示「询盘编号」并自动带出，不再让人手填数字 ID。
  const inquiriesQuery = useQuery({
    queryKey: ["customer-inquiries", customer?.id],
    enabled: !!customer?.id,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: InquiryOption[] }>(
        `/customers/${customer?.id}/inquiries`,
      );
      return data.items;
    },
  });
  const inquiries = inquiriesQuery.data ?? [];
  const selectedInquiry = inquiries.find((i) => String(i.id) === inquiryId);
  const queryClient = useQueryClient();

  // 报价页直接新增询盘：不存在的询盘由这里补建，建完自动选中（不再手填编号）。
  const createInquiry = useMutation<
    { id: number; inquiry_no?: string | null },
    Error,
    void
  >({
    mutationFn: async () => {
      if (!customer?.id) throw new Error("请先选择客户");
      const { data } = await apiClient.post<{
        id: number;
        inquiry_no?: string | null;
      }>(`/customers/${customer.id}/inquiries`, {
        channel: "quote",
        product_name_raw: lines.find((l) => l.productKey)?.productKey ?? null,
      });
      return data;
    },
    onSuccess: (data) => {
      setInquiryId(String(data.id));
      void queryClient.invalidateQueries({
        queryKey: ["customer-inquiries", customer?.id],
      });
    },
    // P0-B2/Q9：新建询盘失败原无 onError（点了没反应）⇒ 页内如实说明；
    // 拦截器已经 toast 过，这里不重复 toast。
    onError: (err) => {
      setNotice({
        tone: "error",
        text: `新建询盘失败：${normalizeApiError(err).message}`,
      });
    },
  });

  // 旧“法定税务档案”字段保留在算价请求里（历史兼容），新 UI 只选团队税务档案
  const rateSetCode = "";
  const [inputVatRatePct, setInputVatRatePct] = useState(
    POLICY_DEFAULTS.inputVatRatePct,
  );
  const [giveRatioPct, setGiveRatioPct] = useState(
    POLICY_DEFAULTS.giveRatioPct,
  );
  const [outputVatRatePct, setOutputVatRatePct] = useState(
    POLICY_DEFAULTS.outputVatRatePct,
  );
  const [rebateRatePct, setRebateRatePct] = useState(
    POLICY_DEFAULTS.rebateRatePct,
  );
  const [miscTaxPct, setMiscTaxPct] = useState(POLICY_DEFAULTS.miscTaxPct);
  const [profitPct, setProfitPct] = useState("5");
  const [quoteCurrency, setQuoteCurrency] = useState("USD");
  const [fxRate, setFxRate] = useState("");
  const [fxTouched, setFxTouched] = useState(false);
  const [quoteDate, setQuoteDate] = useState(todayISO);
  const [validityDays, setValidityDays] = useState("30");

  // ── 贸易术语（整批费用：整单填一次，按件数比例分摊给每行）──────────────────
  const [quoteAs, setQuoteAs] = useState("EXW");
  const [feeInputs, setFeeInputs] = useState<Record<string, string>>({});
  const [freightFrom, setFreightFrom] = useState("");
  const [freightTo, setFreightTo] = useState("");
  // 船公司（CFR/CIF/DAP/DDP 报价时必选；值格式「中文名-英文缩写」）
  const [carrier, setCarrier] = useState("");
  // 整单保险：先按 0 保险算一轮拿各行 EXW 货值，再按货值比例分摊第二轮
  const [insuranceByLine, setInsuranceByLine] = useState<number[] | null>(null);
  /** 整单报价信号：递增触发所有行重算 */
  const [calcSignal, setCalcSignal] = useState(0);
  const productOptions = useExportProducts();

  const termsQuery = useExportTermsTemplate();
  // 汇率：后端按需刷新（>6h 拉公开源；失败降级缓存）。
  // 方向 = 1 报价币 = ? CNY；切币种后必须重新取对应币种的汇率。
  const latestFx = useLatestFxRate(quoteCurrency, "CNY");
  const create = useCreateQuoteOrder();
  const update = useUpdateQuoteOrder();
  const replaceItems = useReplaceQuoteItems();

  // 深链：从询盘/客户页跳进来时带上客户与询盘，省掉重复选择。
  // 这里只知道 id：名字由 useCustomerName 补出来（保存时要写进 customer_name 快照）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const cid = p.get("customer_id");
    const iid = p.get("inquiry_id");
    if (cid) setCustomer({ id: cid, name: "" });
    if (iid) setInquiryId(iid);
  }, []);

  // 名字缺失（深链进来）时补一次详情；失败就退化成 #id，不阻断开单
  const resolvedCustomer = useCustomerName(
    customer && !customer.name ? customer.id : null,
  );
  const customerName = customer
    ? customer.name || resolvedCustomer.data || ""
    : "";
  const customerLabel = customer ? customerName || `#${customer.id}` : "";

  // 汇率自动带入：手改后不再自动覆盖；切币种视为重新开始（取新币种汇率）。
  useEffect(() => {
    setFxTouched(false);
  }, [quoteCurrency]);

  useEffect(() => {
    if (fxTouched) return;
    const rate = latestFx.data?.rate;
    if (rate && rate > 0) setFxRate(String(rate));
  }, [fxTouched, latestFx.data]);

  /** 手改汇率：标记 touched，之后不再被自动汇率覆盖。 */
  const onFxRateChange = (v: string) => {
    setFxTouched(true);
    setFxRate(v);
  };

  const termsTemplate = termsQuery.data;
  const effectiveQuoteAs = quoteAs || termsTemplate?.quote_as || "EXW";

  // 整批费用：整单填一次，按**件数比例**摊到每行；
  // 只下发所选条款累计需要的费用项（阶梯截断到 quoteAs）。
  const termsByLine = useMemo(() => {
    if (!termsTemplate) return null;
    const amounts: Record<string, number> = {};
    for (const key of Object.keys(termsTemplate.items ?? {})) {
      amounts[key] = Number(feeInputs[key]) || 0;
    }
    const { terms, amortized } = buildTermsPerLine(
      termsTemplate,
      amounts,
      lines.map((l) => Number(l.pieces) || 0),
      effectiveQuoteAs,
      insuranceByLine ? { insurance_of_exw: insuranceByLine } : undefined,
    );
    return { terms, amortized };
  }, [termsTemplate, feeInputs, lines, effectiveQuoteAs, insuranceByLine]);

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
      miscTaxPct,
      profitPct,
    }),
    [
      rateSetCode,
      fxRate,
      quoteCurrency,
      quoteDate,
      validityDays,
      inputVatRatePct,
      giveRatioPct,
      outputVatRatePct,
      rebateRatePct,
      miscTaxPct,
      profitPct,
    ],
  );

  const computed: BuiltLineItem[] = useMemo(
    () =>
      lines.map((l) => l.built).filter((b): b is BuiltLineItem => b !== null),
    [lines],
  );
  const summary = useMemo(() => summarizeLines(computed), [computed]);

  // 行参数变了就重新走一轮保险分摊（结果对象变化不触发）
  const lineInputKey = useMemo(
    () =>
      lines
        .map(
          (l) =>
            `${l.productKey}|${JSON.stringify(l.spec)}|${l.pieces}|${l.costOverride}|${l.profitPctOverride}`,
        )
        .join("||"),
    [lines],
  );
  useEffect(() => {
    setInsuranceByLine(null);
  }, [lineInputKey, effectiveQuoteAs]);

  // 整单保险：第一轮各行按 0 保险算完 → 汇总 EXW 货值 → 第二轮按货值比例分摊。
  // 保险费 = 整单 EXW × 1.1 ÷ 1000，最低 15 美元；只对含保险的条款生效。
  useEffect(() => {
    if (insuranceByLine) return;
    if (!["CIF", "DAP", "DDP"].includes(effectiveQuoteAs)) return;
    if (lines.length === 0) return;
    if (!lines.every((l) => l.result && l.built)) return;
    const exwTotals = lines.map((l) => {
      const meta = l.result?.meta;
      const orderName = meta?.orders?.[0]?.name;
      const totals = meta?.term_totals?.EXW;
      const entry = orderName ? totals?.[orderName] : undefined;
      return Number(entry?.total_excl_fx) || 0;
    });
    const totalExw = exwTotals.reduce((a, b) => a + b, 0);
    if (totalExw <= 0) return;
    const allocated = allocateInsurance(exwTotals);
    setInsuranceByLine(allocated);
    setCalcSignal((v) => v + 1);
  }, [lines, insuranceByLine, effectiveQuoteAs]);

  /** 利润率右侧的只读金额回显：取第一行内部分解里的「利润金额（元/kg）」。 */
  const profitAmountHint = (() => {
    const first = lines.find((l) => l.built?.costBreakdown)?.built;
    if (!first?.costBreakdown) return "";
    const perM2 = (
      first.costBreakdown as { currency_cny_per_m2?: Record<string, unknown> }
    ).currency_cny_per_m2;
    const amount = perM2?.profit_amount;
    return typeof amount === "number" && Number.isFinite(amount)
      ? `≈ ¥${amount.toFixed(4)}/kg`
      : "";
  })();

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

  // ── 团队税务档案（TAX-00：单下拉，选中自动填四税率）─────────────────────
  const taxArchivesQuery = useQuery({
    queryKey: ["tax-archives"],
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: TaxArchive[] }>(
        "/tax-archives",
      );
      return data.items;
    },
  });
  const taxArchives = taxArchivesQuery.data ?? [];
  // 产品税率：进项税/出口退税率按产品带出，不再从企业税档取
  const productTaxQuery = useQuery({
    queryKey: ["product-tax-rates"],
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: ProductTaxRate[] }>(
        "/product-tax-rates",
      );
      return data.items;
    },
  });
  const productTaxMap = useMemo(() => {
    const map: ProductTaxMap = {};
    for (const row of productTaxQuery.data ?? []) {
      map[row.product_key] = {
        input_vat_rate: row.input_vat_rate,
        rebate_rate: row.rebate_rate,
      };
    }
    return map;
  }, [productTaxQuery.data]);
  const [taxArchiveId, setTaxArchiveId] = useState("");
  const [taxArchiveTouched, setTaxArchiveTouched] = useState(false);

  const applyTaxArchive = (a: TaxArchive) => {
    setTaxArchiveTouched(true);
    setTaxArchiveId(String(a.id));
    // 企业税档只带销项税、杂税；进项税/退税率按产品从「产品税率」取
    setOutputVatRatePct(
      rateToPct(a.tax_values.output_vat_rate, POLICY_DEFAULTS.outputVatRatePct),
    );
    setMiscTaxPct(
      rateToPct(a.tax_values.misc_fee_rate, POLICY_DEFAULTS.miscTaxPct),
    );
  };

  const clearTaxArchive = () => {
    setTaxArchiveTouched(true);
    setTaxArchiveId("");
    setOutputVatRatePct(POLICY_DEFAULTS.outputVatRatePct);
    setMiscTaxPct(POLICY_DEFAULTS.miscTaxPct);
  };

  // 有档案时默认选最新一份并自动填税率；用户手动选“自定义”后不再强行套用
  useEffect(() => {
    if (taxArchiveTouched || taxArchiveId || taxArchives.length === 0) return;
    const first = taxArchives[0];
    if (!first) return;
    applyTaxArchive(first);
  }, [taxArchives, taxArchiveTouched, taxArchiveId]);

  const selectedTaxArchive = taxArchives.find(
    (a) => String(a.id) === taxArchiveId,
  );

  const docTypes = useMemo<DocTypeOption[]>(
    () =>
      getAvailableTemplates()
        .filter((t) =>
          [
            "quotation",
            "pi",
            "contract",
            "ci",
            "pl",
            "shipping_advice",
            "weight_list",
            "quality_cert",
            "co",
            "customs_declaration",
          ].includes(t.doc_type),
        )
        .map((t) => ({ value: t.doc_type, label: t.name_zh })),
    [],
  );

  return {
    lines,
    setLines,
    view,
    customer,
    setCustomer,
    customerError,
    setCustomerError,
    paramsOpen,
    setParamsOpen,
    createdCustomerId,
    setCreatedCustomerId,
    inquiryId,
    setInquiryId,
    inquiries: inquiries as InquiryOption[],
    selectedInquiry,
    createInquiry,
    customerName,
    customerLabel,
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
    quoteCurrency,
    setQuoteCurrency,
    fxRate,
    onFxRateChange,
    quoteDate,
    setQuoteDate,
    validityDays,
    setValidityDays,
    quoteAs,
    setQuoteAs,
    effectiveQuoteAs,
    carrier,
    setCarrier,
    feeInputs,
    setFeeInputs,
    freightFrom,
    setFreightFrom,
    freightTo,
    setFreightTo,
    termsTemplate,
    termsQuery,
    taxArchives,
    taxArchiveId,
    setTaxArchiveId,
    applyTaxArchive,
    clearTaxArchive,
    selectedTaxArchive,
    shared,
    computed,
    summary,
    profitAmountHint,
    effectiveVolume,
    missing,
    termsByLine,
    productTaxMap,
    productOptions,
    calcSignal,
    setCalcSignal,
    quoteOrderId,
    setQuoteOrderId,
    savedDoc,
    setSavedDoc,
    notice,
    setNotice,
    docPick,
    setDocPick,
    docTypes,
    generating,
    setGenerating,
    saving: create.isPending || update.isPending || replaceItems.isPending,
    mutations: { create, update, replaceItems },
    queryClient,
  };
}
