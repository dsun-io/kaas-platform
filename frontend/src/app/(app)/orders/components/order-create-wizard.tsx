"use client";

/**
 * 手工新建订单 · 五步向导（§6 + §13.3）。
 *
 * 步骤（用户口径"四步"把附件并入收尾，这里把收款计划与附件拆开更好填）：
 * 1. 客户与来源：业务客户必选；关联报价可选（选中后带出币种/条款/货物行）；
 * 2. 订单信息：日期 / 币种 / 贸易术语 / 付款方式 / 装卸港 / 唛头 / 原产国 / 备注；
 * 3. 货物与金额：货物明细（数量×单价，也允许直接改行金额）+ 运费/保险/其他，
 *    订单总额自动汇总（只读）；
 * 4. 收款计划：30/70、50/50、100% 预付、自定义；比例变化自动算金额，
 *    改金额时反算比例只提示；比例合计 > 100% 前端拦；
 * 5. 附件上传：合同 / PO / 信用证 / 其他（PDF/JPG/PNG，可多份、可跳过）。
 *
 * 为什么附件在最后一步、且"先建单后传附件"：设计稿 §11 风险表明确要求
 * 上传失败不能让用户以为没建单 —— 建单成功后逐个上传，失败的明确提示
 * "订单已创建，附件可在详情里补传"（订单详情有补传入口）。
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import apiClient from "@/lib/api/client";
import {
  attachmentDisplayName,
  attachmentKindLabel,
  ORDER_ATTACHMENT_ACCEPT,
  ORDER_ATTACHMENT_KINDS,
  formatFileSize,
  validateAttachmentFile,
} from "@/lib/orders/order-attachments";
import {
  buildExternalDocForm,
  EXTERNAL_DOC_ACCEPT,
  EXTERNAL_DOC_TYPES,
  validateExternalDocFile,
} from "@/lib/orders/external-docs";
import {
  buildOrderCreatePayload,
  COMMON_QTY_UNITS,
  draftOrderTotal,
  EMPTY_ORDER_INFO,
  itemDraftAmount,
  itemDraftsFromQuote,
  makeItemDraft,
  parseNonNegative,
  recalcItemAmount,
  sumDraftItemsAmount,
  validateOrderInfo,
  validateOrderItems,
  type OrderInfoDraft,
  type OrderItemDraft,
} from "@/lib/orders/order-create";
import { formatOrderMoney } from "@/lib/orders/order-detail";
import {
  amountRatioHint,
  applyAmountChange,
  applyPaymentPlanTemplate,
  applyRatioChange,
  applyTotalChange,
  makePlanRow,
  PAYMENT_PLAN_TEMPLATES,
  PLAN_SCHEDULE_TYPE_OPTIONS,
  sumPlanAmounts,
  sumPlanRatios,
  validatePaymentPlan,
  type PaymentPlanRow,
} from "@/lib/orders/payment-plan";
import {
  toCustomerIdPayload,
  useQuoteOptions,
  type OrderOption,
} from "@/lib/workstation/use-upstream";

const STEPS = [
  { title: "客户与来源", hint: "订单归属到哪个客户；有报价就关联上" },
  { title: "订单信息", hint: "日期、币种、贸易条款" },
  { title: "货物与金额", hint: "明细行 + 运费/保险/其他，总额自动" },
  { title: "收款计划", hint: "按比例自动算应收" },
  { title: "附件上传", hint: "合同 / PO / 信用证扫描件" },
] as const;

interface QuoteDetailLite {
  id: number;
  customer_id?: string | number | null;
  customer_name?: string | null;
  currency?: string | null;
  incoterm?: string | null;
  payment_terms?: string | null;
  port_of_loading?: string | null;
  port_of_destination?: string | null;
  shipping_marks?: string | null;
  country_of_origin?: string | null;
  items?: {
    product_name?: string | null;
    qty?: number | null;
    qty_unit?: string | null;
    unit_price?: number | null;
    line_amount?: number | null;
    spec_snapshot?: Record<string, unknown> | null;
  }[];
}

interface PendingAttachment {
  key: string;
  file: File;
  kind: string;
  name: string;
  error: string | null;
}

/**
 * 「导入已有单证」草稿：与订单附件分开（进 external_doc_uploads 台账，
 * 不是 file_objects 随单文件）。订单创建成功后才逐条 POST /external-docs。
 */
interface PendingExternalDoc {
  key: string;
  file: File;
  doc_type: string;
  notes: string;
  error: string | null;
}

let attachmentSeq = 0;
function nextAttachmentKey(): string {
  attachmentSeq += 1;
  return `attach-${Date.now().toString(36)}-${attachmentSeq}`;
}

let externalDocSeq = 0;
function nextExternalDocKey(): string {
  externalDocSeq += 1;
  return `extdoc-${Date.now().toString(36)}-${externalDocSeq}`;
}

export function OrderCreateWizard({
  onCreated,
}: {
  onCreated?: (order: OrderOption) => void;
}) {
  const qc = useQueryClient();
  const quotes = useQuoteOptions();

  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [customer, setCustomer] = useState<CustomerPickerValue | null>(null);
  const [quoteId, setQuoteId] = useState("");
  const [info, setInfo] = useState<OrderInfoDraft>({ ...EMPTY_ORDER_INFO });
  const [items, setItems] = useState<OrderItemDraft[]>([]);
  const [freight, setFreight] = useState("");
  const [insurance, setInsurance] = useState("");
  const [other, setOther] = useState("");
  const [planTemplate, setPlanTemplate] = useState("30_70");
  const [plan, setPlan] = useState<PaymentPlanRow[]>(() =>
    applyPaymentPlanTemplate("30_70", 0),
  );
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  /** 第 5 步「导入已有单证」草稿（与附件分开：进 external_doc_uploads 台账） */
  const [externalDocs, setExternalDocs] = useState<PendingExternalDoc[]>([]);
  const [error, setError] = useState<string | null>(null);

  const quoteIdNum = quoteId ? Number(quoteId) : null;

  const goodsAmount = useMemo(() => sumDraftItemsAmount(items), [items]);
  const total = useMemo(
    () => draftOrderTotal({ items, freight, insurance, other }),
    [items, freight, insurance, other],
  );

  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  /** 订单总额变化（改运费/货物/保险）→ 未手改金额的收款期按比例重算。 */
  const syncPlanTotal = (nextTotal: number) =>
    setPlan((prev) => applyTotalChange(prev, nextTotal));

  /** 选报价：币种/贸易条款/货物行自动带出（用户之后仍可改）。 */
  const chooseQuote = async (nextQuoteId: string) => {
    setQuoteId(nextQuoteId);
    setQuoteError(null);
    const id = nextQuoteId ? Number(nextQuoteId) : null;
    if (id === null || !Number.isFinite(id)) return;
    setQuoteLoading(true);
    try {
      const { data: quote } = await apiClient.get<QuoteDetailLite>(
        `/quotes/${id}`,
      );
      setInfo((prev) => ({
        ...prev,
        currency: (quote.currency ?? prev.currency).toUpperCase(),
        incoterm: quote.incoterm ?? prev.incoterm,
        payment_terms: quote.payment_terms ?? prev.payment_terms,
        port_of_loading: quote.port_of_loading ?? prev.port_of_loading,
        port_of_destination:
          quote.port_of_destination ?? prev.port_of_destination,
        shipping_marks: quote.shipping_marks ?? prev.shipping_marks,
        country_of_origin: quote.country_of_origin ?? prev.country_of_origin,
      }));
      const nextItems = itemDraftsFromQuote(quote.items);
      setItems(nextItems);
      syncPlanTotal(
        draftOrderTotal({
          items: nextItems,
          freight,
          insurance,
          other,
        }),
      );
      if (quote.customer_id !== null && quote.customer_id !== undefined) {
        setCustomer((prev) =>
          prev ?? {
            id: String(quote.customer_id),
            name: quote.customer_name ?? `#${quote.customer_id}`,
          },
        );
      }
    } catch {
      setQuoteError("报价明细读取失败：仍然可以手工填后面的步骤。");
    } finally {
      setQuoteLoading(false);
    }
  };

  const planValidation = useMemo(
    () => validatePaymentPlan(plan, total),
    [plan, total],
  );

  const create = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const { data } = await apiClient.post<OrderOption>("/orders", payload);
      return data;
    },
  });

  const setInfoField = (field: keyof OrderInfoDraft, value: string) => {
    setInfo((prev) => ({ ...prev, [field]: value }));
    setError(null);
  };

  /** 货物行变化统一走这里：先算新总额，再同步收款计划金额。 */
  const applyItems = (nextItems: OrderItemDraft[]) => {
    setItems(nextItems);
    syncPlanTotal(
      draftOrderTotal({ items: nextItems, freight, insurance, other }),
    );
  };
  const addItem = () => applyItems([...items, makeItemDraft()]);
  const updateItem = (key: string, patch: Partial<OrderItemDraft>) => {
    applyItems(
      items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
    setError(null);
  };
  const removeItem = (key: string) =>
    applyItems(items.filter((item) => item.key !== key));

  const updatePlanRow = (key: string, patch: Partial<PaymentPlanRow>) => {
    setPlan((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
    setPlanTemplate("custom");
    setError(null);
  };
  const removePlanRow = (key: string) => {
    setPlan((prev) => prev.filter((row) => row.key !== key));
    setPlanTemplate("custom");
  };
  const addPlanRow = () => {
    setPlan((prev) => [...prev, makePlanRow({ schedule_type: "balance" })]);
    setPlanTemplate("custom");
  };

  const chooseTemplate = (templateId: string) => {
    setPlanTemplate(templateId);
    setPlan(applyPaymentPlanTemplate(templateId, total));
    setError(null);
  };

  const addAttachments = (fileList: FileList | null) => {
    if (!fileList) return;
    const next: PendingAttachment[] = [];
    for (const file of Array.from(fileList)) {
      next.push({
        key: nextAttachmentKey(),
        file,
        kind: "contract",
        name: file.name,
        error: validateAttachmentFile(file),
      });
    }
    setAttachments((prev) => [...prev, ...next]);
  };

  const addExternalDocs = (fileList: FileList | null) => {
    if (!fileList) return;
    const next: PendingExternalDoc[] = Array.from(fileList).map((file) => ({
      key: nextExternalDocKey(),
      file,
      doc_type: "contract",
      notes: "",
      error: validateExternalDocFile(file),
    }));
    setExternalDocs((prev) => [...prev, ...next]);
    setError(null);
  };

  const updateExternalDoc = (key: string, patch: Partial<PendingExternalDoc>) => {
    setExternalDocs((prev) =>
      prev.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
    setError(null);
  };

  const removeExternalDoc = (key: string) =>
    setExternalDocs((prev) => prev.filter((item) => item.key !== key));

  const validate = (index: number): string | null => {
    if (index === 0) {
      if (!customer) return "请选择业务客户 —— 订单必须归属到客户，否则客户页查不到这张单";
      return null;
    }
    if (index === 1) {
      return validateOrderInfo(info)[0] ?? null;
    }
    if (index === 2) {
      const itemErrors = validateOrderItems(items);
      if (itemErrors.length > 0) return itemErrors[0] ?? null;
      const numbers = [freight, insurance, other];
      if (numbers.some((value) => !parseNonNegative(value).ok)) {
        return "运费 / 保险费 / 其他费用必须是非负数字";
      }
      return null;
    }
    if (index === 3) {
      return planValidation.errors[0] ?? null;
    }
    return null;
  };

  const goTo = (index: number) => {
    if (index > maxStep) return;
    setError(null);
    setStep(index);
  };

  const goNext = () => {
    const reason = validate(step);
    if (reason) {
      setError(reason);
      return;
    }
    const next = Math.min(step + 1, STEPS.length - 1);
    setMaxStep((prev) => Math.max(prev, next));
    setError(null);
    setStep(next);
  };

  const reset = () => {
    setStep(0);
    setMaxStep(0);
    setCustomer(null);
    setQuoteId("");
    setInfo({ ...EMPTY_ORDER_INFO });
    setItems([]);
    setFreight("");
    setInsurance("");
    setOther("");
    setPlanTemplate("30_70");
    setPlan(applyPaymentPlanTemplate("30_70", 0));
    setAttachments([]);
    setExternalDocs([]);
    setError(null);
    setQuoteLoading(false);
    setQuoteError(null);
  };

  const submit = async () => {
    const reason = validate(0) ?? validate(1) ?? validate(2) ?? validate(3);
    if (reason || !customer) {
      setError(reason ?? "请先补齐必填信息");
      return;
    }
    const badAttachment = attachments.find((item) => item.error);
    if (badAttachment) {
      setError(
        `附件「${badAttachment.file.name}」${badAttachment.error}，请先移除或换文件再建单。`,
      );
      return;
    }
    const badExternalDoc = externalDocs.find((item) => item.error);
    if (badExternalDoc) {
      setError(
        `已有单证「${badExternalDoc.file.name}」${badExternalDoc.error}，请先移除或换文件再建单。`,
      );
      return;
    }
    setError(null);
    const payload = buildOrderCreatePayload({
      customer_id: toCustomerIdPayload(customer.id),
      customer_name: customer.name,
      quote_order_id: quoteIdNum,
      info,
      items,
      freight,
      insurance,
      other,
      plan,
    });

    let order: OrderOption;
    try {
      order = await create.mutateAsync(payload);
    } catch {
      // 具体错误信息由 apiClient 响应拦截器统一提示，这里补业务口径
      setError("建单失败：请确认所选客户存在、未删除且属于本团队，然后重试。");
      return;
    }

    let failed = 0;
    for (const attachment of attachments) {
      if (attachment.error) {
        failed += 1;
        continue;
      }
      try {
        const form = new FormData();
        form.append("file", attachment.file);
        form.append(
          "name",
          attachmentDisplayName(
            attachment.kind,
            attachment.name,
            attachment.file.name,
          ),
        );
        await apiClient.post(`/orders/${order.id}/files`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          silent: true,
        });
      } catch {
        failed += 1;
      }
    }

    // 已有单证：进 external_doc_uploads 台账（不是订单附件），逐条导入
    let docsFailed = 0;
    for (const doc of externalDocs) {
      try {
        await apiClient.post(
          "/external-docs",
          buildExternalDocForm({
            file: doc.file,
            doc_type: doc.doc_type,
            order_id: order.id,
            customer_id: customer ? toCustomerIdPayload(customer.id) : null,
            notes: doc.notes,
          }),
          {
            headers: { "Content-Type": "multipart/form-data" },
            silent: true,
          },
        );
      } catch {
        docsFailed += 1;
      }
    }

    void qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
    void qc.invalidateQueries({ queryKey: ["customer-records"] });
    void qc.invalidateQueries({ queryKey: ["orders", order.id] });
    // 建单即按 payment_plan 生成应收台账（§13.3）：应收页应立刻能看到
    void qc.invalidateQueries({ queryKey: ["receivables"] });
    void qc.invalidateQueries({ queryKey: ["external-docs"] });

    const warnings: string[] = [];
    if (failed > 0) {
      warnings.push(
        `${failed} 个附件没传成功（可在订单详情「订单附件」里补传）`,
      );
    }
    if (docsFailed > 0) {
      warnings.push(
        `${docsFailed} 份已有单证没导入成功（可在订单详情「已导入单证」里补导入）`,
      );
    }
    if (warnings.length > 0) {
      toast.warning(`订单 ${order.order_no} 已创建，但${warnings.join("；")}。`);
    } else {
      toast.success(
        quoteIdNum
          ? `已由报价生成订单 ${order.order_no}（贸易条款已继承）`
          : `已新建订单 ${order.order_no}（直接挂客户）`,
      );
    }
    onCreated?.(order);
    reset();
  };

  const selectedQuote =
    (quotes.data ?? []).find((q) => String(q.id) === quoteId) ?? null;
  const customerMismatch =
    !!selectedQuote?.customer_name &&
    !!customer?.name &&
    selectedQuote.customer_name !== customer.name;

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-1" aria-label="建单步骤">
        {STEPS.map((item, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <li key={item.title} className="flex items-center gap-1">
              <button
                type="button"
                aria-current={active ? "step" : undefined}
                disabled={index > maxStep}
                onClick={() => goTo(index)}
                className={`inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60"
                }`}
              >
                <span
                  className={`flex size-5 items-center justify-center rounded-full text-[11px] ${
                    done || active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground"
                  }`}
                >
                  {done ? <Check className="size-3" /> : index + 1}
                </span>
                {item.title}
              </button>
              {index < STEPS.length - 1 && (
                <ChevronRight className="size-3.5 text-muted-foreground/60" />
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{STEPS[step]?.hint}</p>

      {step === 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <CustomerPicker
            value={customer}
            onChange={(next) => {
              setCustomer(next);
              setError(null);
            }}
            required
            hint="订单上的客户是后续单证与往来记录树的归属依据"
          />
          <div className="space-y-1.5">
            <Label className="text-xs">关联报价单（可选）</Label>
            <select
              aria-label="关联报价单"
              className="h-8 w-full rounded-lg border border-input bg-background px-2 text-xs"
              value={quoteId}
              onChange={(e) => void chooseQuote(e.target.value)}
            >
              <option value="">（不关联 —— 直接挂客户）</option>
              {(quotes.data ?? []).map((quote) => (
                <option key={quote.id} value={String(quote.id)}>
                  {quote.quote_no} · {quote.customer_name ?? "未填客户"} ·{" "}
                  {quote.currency} {quote.total_amount ?? "-"}
                </option>
              ))}
            </select>
            {quotes.data?.length === 0 && (
              <p className="text-xs text-warning">
                还没有报价单 —— 请先在「报价」工位出报价。
              </p>
            )}
            {quoteLoading && (
              <p className="text-xs text-muted-foreground">
                正在带出报价的币种、条款与货物行…
              </p>
            )}
            {quoteError && <p className="text-xs text-warning">{quoteError}</p>}
          </div>
          {customerMismatch && (
            <p className="text-xs text-warning sm:col-span-2">
              提示：所选报价的客户是「{selectedQuote?.customer_name}」，与上面选的
              「{customer?.name}」不一致。订单会按上面选的客户落库，请确认是不是同一家。
            </p>
          )}
        </div>
      )}

      {step === 1 && (
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
              onChange={(e) =>
                setInfoField("port_of_destination", e.target.value)
              }
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
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="p-2">
                    产品名称 *
                  </th>
                  <th scope="col" className="p-2">
                    规格说明
                  </th>
                  <th scope="col" className="p-2">
                    数量
                  </th>
                  <th scope="col" className="p-2">
                    单位
                  </th>
                  <th scope="col" className="p-2">
                    单价
                  </th>
                  <th scope="col" className="p-2">
                    金额
                  </th>
                  <th scope="col" className="p-2" />
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="p-3 text-center text-xs text-muted-foreground"
                    >
                      暂不填明细也可以继续（历史订单）—— 需要时点下面「添加货物行」。
                    </td>
                  </tr>
                )}
                {items.map((item, index) => (
                  <tr key={item.key} className="border-b last:border-0">
                    <td className="p-1.5">
                      <Input
                        aria-label={`第 ${index + 1} 行产品名称`}
                        className="h-8 text-xs"
                        value={item.product_name}
                        placeholder="如 勾花网 / Chain Link Fence"
                        onChange={(e) =>
                          updateItem(item.key, { product_name: e.target.value })
                        }
                      />
                    </td>
                    <td className="p-1.5">
                      <Input
                        aria-label={`第 ${index + 1} 行规格`}
                        className="h-8 text-xs"
                        value={item.spec_text}
                        placeholder="如 2.5mm 热镀锌"
                        onChange={(e) =>
                          updateItem(item.key, { spec_text: e.target.value })
                        }
                      />
                    </td>
                    <td className="p-1.5">
                      <Input
                        aria-label={`第 ${index + 1} 行数量`}
                        className="h-8 w-20 text-xs"
                        inputMode="decimal"
                        value={item.qty}
                        onChange={(e) =>
                          applyItems(
                            items.map((row) =>
                              row.key === item.key
                                ? recalcItemAmount({
                                    ...row,
                                    qty: e.target.value,
                                  })
                                : row,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="p-1.5">
                      <Input
                        aria-label={`第 ${index + 1} 行单位`}
                        className="h-8 w-20 text-xs"
                        list="order-qty-units"
                        value={item.qty_unit}
                        onChange={(e) =>
                          updateItem(item.key, { qty_unit: e.target.value })
                        }
                      />
                    </td>
                    <td className="p-1.5">
                      <Input
                        aria-label={`第 ${index + 1} 行单价`}
                        className="h-8 w-24 text-xs"
                        inputMode="decimal"
                        value={item.unit_price}
                        onChange={(e) =>
                          applyItems(
                            items.map((row) =>
                              row.key === item.key
                                ? recalcItemAmount({
                                    ...row,
                                    unit_price: e.target.value,
                                  })
                                : row,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="p-1.5">
                      <Input
                        aria-label={`第 ${index + 1} 行金额`}
                        className="h-8 w-24 text-xs"
                        inputMode="decimal"
                        value={item.line_amount}
                        placeholder={itemDraftAmount(item).toFixed(2)}
                        onChange={(e) =>
                          updateItem(item.key, {
                            line_amount: e.target.value,
                            amount_touched: true,
                          })
                        }
                      />
                    </td>
                    <td className="p-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`删除第 ${index + 1} 行`}
                        onClick={() => removeItem(item.key)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <datalist id="order-qty-units">
            {COMMON_QTY_UNITS.map((unit) => (
              <option key={unit} value={unit} />
            ))}
          </datalist>
          <Button type="button" size="sm" variant="outline" onClick={addItem}>
            <Plus className="mr-1 h-4 w-4" />
            添加货物行
          </Button>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs font-medium">运费</span>
              <Input
                aria-label="运费"
                inputMode="decimal"
                value={freight}
                placeholder="0.00"
                onChange={(e) => {
                  const value = e.target.value;
                  setFreight(value);
                  syncPlanTotal(
                    draftOrderTotal({ items, freight: value, insurance, other }),
                  );
                }}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium">保险费</span>
              <Input
                aria-label="保险费"
                inputMode="decimal"
                value={insurance}
                placeholder="0.00"
                onChange={(e) => {
                  const value = e.target.value;
                  setInsurance(value);
                  syncPlanTotal(
                    draftOrderTotal({ items, freight, insurance: value, other }),
                  );
                }}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium">其他费用</span>
              <Input
                aria-label="其他费用"
                inputMode="decimal"
                value={other}
                placeholder="佣金、包装附加等"
                onChange={(e) => {
                  const value = e.target.value;
                  setOther(value);
                  syncPlanTotal(
                    draftOrderTotal({ items, freight, insurance, other: value }),
                  );
                }}
              />
            </label>
          </div>

          <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">货物金额</dt>
              <dd className="tabular-nums">
                {formatOrderMoney(goodsAmount, info.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">运费</dt>
              <dd className="tabular-nums">
                {formatOrderMoney(Number(freight || 0), info.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">保险费</dt>
              <dd className="tabular-nums">
                {formatOrderMoney(Number(insurance || 0), info.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">其他费用</dt>
              <dd className="tabular-nums">
                {formatOrderMoney(Number(other || 0), info.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-4 sm:col-span-2">
              <dt className="font-medium">订单总额</dt>
              <dd className="font-semibold tabular-nums">
                {formatOrderMoney(total, info.currency)}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {PAYMENT_PLAN_TEMPLATES.map((template) => (
              <Button
                key={template.id}
                type="button"
                size="sm"
                variant={
                  planTemplate === template.id ? "secondary" : "outline"
                }
                onClick={() => chooseTemplate(template.id)}
              >
                {template.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={addPlanRow}
            >
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
                <div
                  key={row.key}
                  className="space-y-2 rounded-lg border p-3"
                >
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
      )}

      {step === 4 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">随单附件</h3>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/40">
              <Upload className="size-4" />
              选择文件
              <input
                type="file"
                className="sr-only"
                aria-label="选择订单附件"
                accept={ORDER_ATTACHMENT_ACCEPT}
                multiple
                onChange={(e) => {
                  addAttachments(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="text-xs text-muted-foreground">
              合同 / PO / 信用证，PDF、JPG、PNG，可多份；提交后再上传。
            </span>
          </div>

          {attachments.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              可以不传附件直接建单；建单后仍可在订单详情里补传。
            </p>
          ) : (
            <ul className="space-y-2">
              {attachments.map((attachment) => (
                <li
                  key={attachment.key}
                  className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_10rem_1fr_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">{attachment.file.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatFileSize(attachment.file.size)}
                    </p>
                  </div>
                  <select
                    aria-label={`附件类别 ${attachment.file.name}`}
                    className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                    value={attachment.kind}
                    onChange={(e) =>
                      setAttachments((prev) =>
                        prev.map((item) =>
                          item.key === attachment.key
                            ? { ...item, kind: e.target.value }
                            : item,
                        ),
                      )
                    }
                  >
                    {ORDER_ATTACHMENT_KINDS.map((kind) => (
                      <option key={kind.value} value={kind.value}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label={`附件名称 ${attachment.file.name}`}
                    className="h-8 text-xs"
                    value={attachment.name}
                    onChange={(e) =>
                      setAttachments((prev) =>
                        prev.map((item) =>
                          item.key === attachment.key
                            ? { ...item, name: e.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`移除附件 ${attachment.file.name}`}
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((item) => item.key !== attachment.key),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                  {attachment.error && (
                    <p className="text-xs text-destructive sm:col-span-4">
                      {attachment.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            类别会写进附件名（如「
            {attachmentKindLabel("contract")} · 合同扫描件.pdf」），订单详情按名字展示。
          </p>

          <div className="space-y-3 border-t pt-3">
            <div>
              <h3 className="text-sm font-medium">导入已有单证（可选）</h3>
              <p className="text-xs text-muted-foreground">
                客户/第三方已经开好的合同、PO、发票、装箱单、原产地证。导入后进单证台账
                （可在订单详情下载），与上面的随单附件分开管理；订单创建成功后逐份导入，
                失败可在订单详情「已导入单证」里补导入。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/40">
                <Upload className="size-4" />
                添加已有单证
                <input
                  type="file"
                  className="sr-only"
                  aria-label="选择已有单证文件"
                  accept={EXTERNAL_DOC_ACCEPT}
                  multiple
                  onChange={(e) => {
                    addExternalDocs(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="text-xs text-muted-foreground">
                PDF / JPG / PNG / Word / Excel，可多份。
              </span>
            </div>

            {externalDocs.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                没有已有单证也可以直接建单；建单后仍可在订单详情里补导入。
              </p>
            ) : (
              <ul className="space-y-2">
                {externalDocs.map((doc) => (
                  <li
                    key={doc.key}
                    className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_10rem_1fr_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">{doc.file.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatFileSize(doc.file.size)}
                      </p>
                    </div>
                    <select
                      aria-label={`单证类型 ${doc.file.name}`}
                      className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                      value={doc.doc_type}
                      onChange={(e) =>
                        updateExternalDoc(doc.key, {
                          doc_type: e.target.value,
                        })
                      }
                    >
                      {EXTERNAL_DOC_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                    <Input
                      aria-label={`单证备注 ${doc.file.name}`}
                      className="h-8 text-xs"
                      placeholder="备注（可选）"
                      value={doc.notes}
                      onChange={(e) =>
                        updateExternalDoc(doc.key, { notes: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`移除单证 ${doc.file.name}`}
                      onClick={() => removeExternalDoc(doc.key)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                    {doc.error && (
                      <p className="text-xs text-destructive sm:col-span-4">
                        {doc.error}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="size-3.5" />
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={step === 0 || create.isPending}
          onClick={() => goTo(step - 1)}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          上一步
        </Button>
        {step < STEPS.length - 1 ? (
          <Button type="button" size="sm" onClick={goNext}>
            下一步
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={create.isPending}
            onClick={() => void submit()}
          >
            <FilePlus2 className="mr-1 h-4 w-4" />
            {create.isPending
              ? "建单中…"
              : `创建订单${attachments.length > 0 ? `（${attachments.length} 个附件）` : ""}`}
          </Button>
        )}
        {quoteIdNum && (
          <span className="text-xs text-muted-foreground">
            已关联报价 #{quoteIdNum}
          </span>
        )}
      </div>
    </div>
  );
}
