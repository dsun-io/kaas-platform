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
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { handleApiError } from "@/lib/api/error-handler";
import { useLatestFxRate } from "@/lib/fx/use-latest-fx";
import { cn } from "@/lib/utils";
import { getAvailableTemplates } from "@/lib/trade-doc/render";
import { useCustomerName } from "@/lib/workstation/use-upstream";
import type { ProductTaxRate, TaxArchive } from "@contracts/export-quote";

import {
  useExportProducts,
  useExportTermsTemplate,
} from "../../quotations/v2-quote/hooks/use-export-quote-import";
import type { QuoteView } from "../../quotations/v2-quote/hooks/use-export-quote-calc";
import { WorkbenchParamsCard } from "./workbench-params-card";
import {
  QuoteLineCard,
  newLineDraft,
  type LineDraft,
} from "../components/quote-line-card";
import { QuoteSummaryCard } from "../components/quote-summary-card";
import {
  useCreateQuoteOrder,
  useReplaceQuoteItems,
  useUpdateQuoteOrder,
} from "../hooks/use-quote-orders";
import {
  applySpaceDeduction,
  summarizeLines,
  type BuiltLineItem,
} from "../lib/line-to-item";
import { buildTermsPerLine } from "../lib/terms-amortize";
import type { SharedQuoteParams } from "../lib/build-request";
import apiClient from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";

/** 上次用过的汇率，避免每次报价重复输入（仅作预填，仍需业务确认）。 */
const FX_KEY = "kaas:last-fx-rate";

/** 报价政策的默认值 —— 与后端默认政策等价，因此本身不改变任何金额。 */
const POLICY_DEFAULTS = {
  inputVatRatePct: "10",
  giveRatioPct: "80",
  outputVatRatePct: "0",
  rebateRatePct: "",
  miscTaxPct: "3",
};

/** 默认生成哪几种单证：按业务顺序的前两张（报价单 + 形式发票）。 */
const DEFAULT_DOC_PICK = ["quotation", "pi"];

/** 本地今天（YYYY-MM-DD）—— 报价日期默认值。 */
function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function QuoteWorkbenchView() {
  // ── 行 ───────────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<LineDraft[]>(() => [newLineDraft()]);
  // 结果视图不再由用户选择：内部账号看内部视图，其余账号看客户视图
  const { user: authUser } = useAuth();
  const view: QuoteView =
    authUser?.account_type === "internal" ? "internal" : "customer";

  // ── 整单共享参数 ─────────────────────────────────────────────────────────
  // 客户是**必选**的：报价是所有单据的唯一根入口，客户空着的话
  // 客户页的「往来记录」树就找不到这张报价，台账也统计不到。
  const [customer, setCustomer] = useState<CustomerPickerValue | null>(null);
  const [customerError, setCustomerError] = useState<string | null>(null);
  /** 建单时定下的客户：报价单的客户在创建那一刻确定，事后改客户不生效（见 onSave） */
  const [createdCustomerId, setCreatedCustomerId] = useState<string | null>(
    null,
  );
  const [inquiryId, setInquiryId] = useState("");
  // 当前客户的询盘列表：报价页直接显示「询盘编号」并自动带出，不再让人手填数字 ID。
  const inquiriesQuery = useQuery({
    queryKey: ["customer-inquiries", customer?.id],
    enabled: !!customer?.id,
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: {
          id: number;
          inquiry_no?: string | null;
          product_name_raw?: string | null;
          status?: string | null;
        }[];
      }>(`/customers/${customer?.id}/inquiries`);
      return data.items;
    },
  });
  const inquiries = inquiriesQuery.data ?? [];
  const queryClient = useQueryClient();
  // 报价页直接新增询盘：不存在的询盘由这里补建，建完自动选中（不再手填编号）。
  const createInquiry = useMutation({
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
  /** 整单报价信号：递增触发所有行重算 */
  const [calcSignal, setCalcSignal] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addPick, setAddPick] = useState("");
  const productOptions = useExportProducts();

  // ── 报价单与单证 ─────────────────────────────────────────────────────────
  const [quoteOrderId, setQuoteOrderId] = useState<number | null>(null);
  const [savedDoc, setSavedDoc] = useState<{
    id: number;
    quote_no: string;
    status: string;
  } | null>(null);
  const [notice, setNotice] = useState<{
    tone: "info" | "error";
    text: string;
  } | null>(null);
  const [docPick, setDocPick] = useState<string[]>(DEFAULT_DOC_PICK);
  const [generating, setGenerating] = useState(false);

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
    );
    return { terms, amortized };
  }, [termsTemplate, feeInputs, lines, effectiveQuoteAs]);

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
    const map: Record<
      string,
      { input_vat_rate?: number | null; rebate_rate?: number | null }
    > = {};
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

  const pctToRate = (text: string): number | undefined =>
    text === "" ? undefined : (Number(text) || 0) / 100;
  const rateToPct = (rate: number | undefined, fallback: string): string =>
    rate === undefined ? fallback : String(Math.round(rate * 100 * 1e6) / 1e6);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxArchives, taxArchiveTouched, taxArchiveId]);

  // ── 保存 / 签发 / 生成单证 ────────────────────────────────────────────────
  const selectedTaxArchive = taxArchives.find(
    (a) => String(a.id) === taxArchiveId,
  );
  const headerPatch = () => ({
    customer_name: customerName || null,
    currency: quoteCurrency,
    valid_until: validUntil(),
    // 用户直选的对外条款（默认 EXW），阶梯已按该档截断
    incoterm: effectiveQuoteAs,
    freight_valid_from: freightFrom || null,
    freight_valid_to: freightTo || null,
    carrier: carrier || null,
    // 税务档案只记录来源；实际税率仍是下面快照里的显式值
    tax_archive_id: selectedTaxArchive?.id ?? null,
    tax_archive_code: selectedTaxArchive?.code ?? null,
    tax_archive_name: selectedTaxArchive?.name ?? null,
    tax_snapshot: {
      output_vat_rate: pctToRate(outputVatRatePct),
      misc_fee_rate: pctToRate(miscTaxPct),
      // 进项税/退税率按产品不同，快照保留当时每个产品的取值
      product_taxes: productTaxMap,
    },
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
    // 客户必选：报价是"客户 → 报价 → 报价单/订单 → 单证"这棵树唯一的根入口。
    // 不选客户就落库，这张报价在客户页永远查不到，也无法计入台账。
    if (!customer) {
      setCustomerError(
        "请选择业务客户 —— 报价必须挂客户，否则客户页的「往来记录」里查不到这张报价",
      );
      toast.error("请先选择业务客户");
      return;
    }
    setCustomerError(null);
    setNotice(null);
    // 客户在创建那一刻写死（Patch 契约不含 customer_id）：改了要重新建单，
    // 否则"单据上的客户"与"客户树里的客户"会不一致。
    const customerChanged =
      createdCustomerId !== null && createdCustomerId !== customer.id;
    try {
      if (quoteOrderId === null) {
        const created = await create.mutateAsync({
          // 契约里 customer_id 是字符串（后端 BIGINT），与既有实现一致
          customer_id: customer.id,
          customer_name: customerName || null,
          inquiry_id: inquiryId ? Number(inquiryId) : null,
          currency: quoteCurrency,
          valid_until: validUntil(),
          incoterm: headerPatch().incoterm,
          // 可见范围默认 private（仅自己可见），与后端默认值一致
          owner_scope: "private",
          items: items(),
        });
        setQuoteOrderId(created.id);
        setCreatedCustomerId(customer.id);
        // 没选询盘时后端已自动给客户建一条，并把报价挂上去；这里同步到界面
        if (created.inquiry_id != null) {
          setInquiryId(String(created.inquiry_id));
          void queryClient.invalidateQueries({
            queryKey: ["customer-inquiries", customer.id],
          });
        }
        setSavedDoc({
          id: created.id,
          quote_no: created.quote_no,
          status: created.status,
        });
        setNotice({ tone: "info", text: `已保存为报价单 ${created.quote_no}` });
      } else {
        await update.mutateAsync({ id: quoteOrderId, patch: headerPatch() });
        const res = await replaceItems.mutateAsync({
          id: quoteOrderId,
          items: items(),
        });
        setSavedDoc({
          id: quoteOrderId,
          quote_no: savedDoc?.quote_no ?? "",
          status: savedDoc?.status ?? "draft",
        });
        if (customerChanged) {
          setNotice({
            tone: "error",
            text: `已保存（${res.items.length} 行），但**客户未变更**：${customerLabel} 不适用于本单（报价单的客户在建单时确定）。需要换客户请新建一张报价，避免单据与客户归属不一致。`,
          });
        } else {
          setNotice({
            tone: "info",
            text: `已保存（${res.items.length} 行，合计 ${res.total_amount ?? "—"}）`,
          });
        }
      }
      window.localStorage.setItem(FX_KEY, fxRate);
    } catch (err) {
      setNotice({
        tone: "error",
        text: handleApiError(err as Parameters<typeof handleApiError>[0]),
      });
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
      setSavedDoc({
        id: updated.id,
        quote_no: updated.quote_no,
        status: updated.status,
      });
      setNotice({
        tone: "info",
        text: `${updated.quote_no} 已签发，并已向报价记录台账入账一条`,
      });
    } catch (err) {
      setNotice({
        tone: "error",
        text: handleApiError(err as Parameters<typeof handleApiError>[0]),
      });
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
        const { data } = await apiClient.post<{ doc_no: string }>(
          "/trade-docs",
          {
            doc_type: docType,
            quote_order_id: quoteOrderId,
            currency: quoteCurrency,
          },
        );
        created.push(data.doc_no);
      } catch {
        failed.push(docType);
      }
    }
    setGenerating(false);
    if (created.length > 0) {
      toast.success(`已生成 ${created.length} 张单证：${created.join("、")}`);
      setNotice({
        tone: "info",
        text: `已生成：${created.join("、")}（到「单证」工位预览/签发）`,
      });
    }
    if (failed.length > 0) {
      setNotice({
        tone: "error",
        text: `以下类型生成失败：${failed.join("、")}`,
      });
    }
  };

  const docTypes = useMemo(
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

  return (
    <div className="space-y-5">
      {/* 企业抬头/公章入口：单证的卖方信头、银行与公章都在这里维护（仅团队管理员可保存） */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">产品报价</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            多产品逐行报价；单证的卖方抬头、银行与公章取自「企业抬头」设置。
          </p>
        </div>
        <Link
          href="/settings/company-profile"
          className="rounded-lg border px-3 py-1.5 text-xs hover:bg-muted"
        >
          企业抬头 / 收款信息 / 公章 →
        </Link>
      </div>
      <WorkbenchParamsCard
        customer={customer}
        setCustomer={setCustomer}
        customerError={customerError}
        setCustomerError={setCustomerError}
        inquiryId={inquiryId}
        setInquiryId={setInquiryId}
        inquiries={inquiries}
        onCreateInquiry={() => createInquiry.mutate()}
        creatingInquiry={createInquiry.isPending}
        taxArchives={taxArchives}
        taxArchiveId={taxArchiveId}
        setTaxArchiveId={setTaxArchiveId}
        applyTaxArchive={applyTaxArchive}
        clearTaxArchive={clearTaxArchive}
        inputVatRatePct={inputVatRatePct}
        setInputVatRatePct={setInputVatRatePct}
        giveRatioPct={giveRatioPct}
        setGiveRatioPct={setGiveRatioPct}
        outputVatRatePct={outputVatRatePct}
        setOutputVatRatePct={setOutputVatRatePct}
        rebateRatePct={rebateRatePct}
        setRebateRatePct={setRebateRatePct}
        miscTaxPct={miscTaxPct}
        setMiscTaxPct={setMiscTaxPct}
        profitPct={profitPct}
        setProfitPct={setProfitPct}
        profitAmountHint={profitAmountHint}
        quoteCurrency={quoteCurrency}
        setQuoteCurrency={setQuoteCurrency}
        fxRate={fxRate}
        setFxRate={(v) => {
          setFxTouched(true);
          setFxRate(v);
        }}
        quoteDate={quoteDate}
        setQuoteDate={setQuoteDate}
        validityDays={validityDays}
        setValidityDays={setValidityDays}
        termsTemplate={termsTemplate}
        termsQuery={termsQuery}
        quoteAs={effectiveQuoteAs}
        setQuoteAs={setQuoteAs}
        carrier={carrier}
        setCarrier={setCarrier}
        feeInputs={feeInputs}
        setFeeInputs={setFeeInputs}
        freightFrom={freightFrom}
        setFreightFrom={setFreightFrom}
        freightTo={freightTo}
        setFreightTo={setFreightTo}
      />

      {lines.map((line, index) => (
        <QuoteLineCard
          key={line.id}
          index={index}
          line={line}
          shared={shared}
          view={view}
          terms={termsByLine?.terms[index] ?? null}
          lineCount={lines.length}
          customerId={customer?.id ?? null}
          productTaxMap={productTaxMap}
          calcSignal={calcSignal}
          onChange={(patch) =>
            setLines((prev) =>
              prev.map((l) => (l.id === line.id ? { ...l, ...patch } : l)),
            )
          }
          onRemove={() =>
            setLines((prev) => prev.filter((l) => l.id !== line.id))
          }
        />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => setCalcSignal((v) => v + 1)}
          className="flex-1 sm:flex-none"
        >
          整单报价（计算全部行）
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const first = productOptions.data?.products?.[0]?.key ?? "";
            setAddPick(first);
            setAddOpen(true);
          }}
        >
          <Plus className="mr-1.5 size-4" />
          添加产品
        </Button>
      </div>

      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border bg-background p-4 shadow-xl">
            <h3 className="text-sm font-semibold">添加产品</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              先选产品，确定后再在行内选择规格（规格决定成本/重量/体积）。
            </p>
            <select
              value={addPick}
              onChange={(e) => setAddPick(e.target.value)}
              className="mt-3 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
            >
              {(productOptions.data?.products ?? []).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAddOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!addPick}
                onClick={() => {
                  setLines((prev) => [...prev, newLineDraft(addPick)]);
                  setAddOpen(false);
                }}
              >
                添加
              </Button>
            </div>
          </div>
        </div>
      )}

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
