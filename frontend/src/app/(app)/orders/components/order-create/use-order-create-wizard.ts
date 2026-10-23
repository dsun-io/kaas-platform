"use client";

/**
 * 建单向导的数据/动作层（U-P1D2 拆分）。
 *
 * 主组件只剩编排与提交栏；这里集中：五步草稿状态、选报价带出条款/货物行、
 * 收款计划联动、建单提交（POST /orders + 附件/已有单证逐个上传）与错误文案。
 * 返回值即 `WizardApi`，步骤组件通过 context 读取（见 wizard-context.tsx）。
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { CustomerPickerValue } from "@/components/customer-picker";
import { apiErrorCode } from "@/lib/api/api-error";
import apiClient from "@/lib/api/client";
import {
  attachmentDisplayName,
  validateAttachmentFile,
} from "@/lib/orders/order-attachments";
import {
  buildExternalDocForm,
  validateExternalDocFile,
} from "@/lib/orders/external-docs";
import {
  buildOrderCreatePayload,
  draftOrderTotal,
  EMPTY_ORDER_INFO,
  itemDraftsFromQuote,
  makeItemDraft,
  parseNonNegative,
  sumDraftItemsAmount,
  validateOrderInfo,
  validateOrderItems,
  type OrderInfoDraft,
  type OrderItemDraft,
} from "@/lib/orders/order-create";
import {
  buildOrderSourcePayload,
  orderSourceErrorHint,
  validateOrderSourceDraft,
  type OrderSourceType,
} from "@/lib/orders/order-source";
import {
  applyPaymentPlanTemplate,
  applyTotalChange,
  makePlanRow,
  validatePaymentPlan,
  type PaymentPlanRow,
} from "@/lib/orders/payment-plan";
import {
  toCustomerIdPayload,
  useQuoteOptions,
  type OrderOption,
} from "@/lib/workstation/use-upstream";

import { useInquiryOptions } from "../../hooks/use-inquiry-options";
import { nextAttachmentKey, nextExternalDocKey } from "./draft-ids";
import {
  WIZARD_STEPS,
  type PendingAttachment,
  type PendingExternalDoc,
  type QuoteDetailLite,
  type WizardApi,
} from "./types";

export function useOrderCreateWizard({
  onCreated,
}: {
  onCreated?: (order: OrderOption) => void;
}): WizardApi {
  const qc = useQueryClient();
  const quotes = useQuoteOptions();

  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [customer, setCustomer] = useState<CustomerPickerValue | null>(null);
  const [quoteId, setQuoteId] = useState("");
  // 来源（设计 §3.2）：默认直接下单；选了带询盘的报价会自动切到「询盘转化」。
  const [sourceType, setSourceType] = useState<OrderSourceType>("direct");
  const [inquiryId, setInquiryId] = useState("");
  const [channel, setChannel] = useState("");
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
  // 只有选了「询盘转化」才去拉询盘下拉（不白打接口，也不给直接下单加负担）
  const inquiries = useInquiryOptions(
    customer?.id ?? null,
    sourceType === "inquiry",
  );
  const selectedInquiry =
    (inquiries.data ?? []).find((row) => String(row.id) === inquiryId) ?? null;

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
        setCustomer(
          (prev) =>
            prev ?? {
              id: String(quote.customer_id),
              name: quote.customer_name ?? `#${quote.customer_id}`,
            },
        );
      }
      // 报价自带询盘 ⇒ 订单来源自动定为「询盘转化」；没有询盘则回到直接下单
      // （换报价时不能残留上一张报价的询盘，否则会挂错客户/询盘）。
      if (quote.inquiry_id) {
        setSourceType("inquiry");
        setInquiryId(String(quote.inquiry_id));
        setChannel("");
      } else {
        setSourceType("direct");
        setInquiryId("");
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

  const updateExternalDoc = (
    key: string,
    patch: Partial<PendingExternalDoc>,
  ) => {
    setExternalDocs((prev) =>
      prev.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
    setError(null);
  };

  const removeExternalDoc = (key: string) =>
    setExternalDocs((prev) => prev.filter((item) => item.key !== key));

  const validate = (index: number): string | null => {
    if (index === 0) {
      if (!customer)
        return "请选择业务客户 —— 订单必须归属到客户，否则客户页查不到这张单";
      return validateOrderSourceDraft({
        sourceType,
        inquiryId: inquiryId ? Number(inquiryId) : null,
      });
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
    const next = Math.min(step + 1, WIZARD_STEPS.length - 1);
    setMaxStep((prev) => Math.max(prev, next));
    setError(null);
    setStep(next);
  };

  const reset = () => {
    setStep(0);
    setMaxStep(0);
    setCustomer(null);
    setQuoteId("");
    setSourceType("direct");
    setInquiryId("");
    setChannel("");
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
    const source = buildOrderSourcePayload({
      sourceType,
      inquiryId: inquiryId ? Number(inquiryId) : null,
      sourceChannel: channel,
    });
    const payload = buildOrderCreatePayload({
      customer_id: toCustomerIdPayload(customer.id),
      customer_name: customer.name,
      quote_order_id: quoteIdNum,
      source_type: source.source_type,
      inquiry_id: source.inquiry_id ?? null,
      source_channel: source.source_channel ?? null,
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
    } catch (err) {
      // 来源类 422 有明确的操作指引（内核措辞 + 前端解释），必须让用户看到；
      // 其它错误沿用原有业务口径（详细原因由 apiClient 拦截器统一 toast）。
      const hint = orderSourceErrorHint(apiErrorCode(err));
      setError(
        hint ?? "建单失败：请确认所选客户存在、未删除且属于本团队，然后重试。",
      );
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
      toast.warning(
        `订单 ${order.order_no} 已创建，但${warnings.join("；")}。`,
      );
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

  return {
    customer,
    setCustomer,
    quoteId,
    chooseQuote,
    quotes,
    quoteLoading,
    quoteError,
    sourceType,
    setSourceType,
    inquiryId,
    setInquiryId,
    channel,
    setChannel,
    inquiries,
    selectedInquiry,
    selectedQuote,
    customerMismatch,
    setError,
    info,
    setInfoField,
    items,
    setItems,
    addItem,
    updateItem,
    removeItem,
    applyItems,
    freight,
    setFreight,
    insurance,
    setInsurance,
    other,
    setOther,
    syncPlanTotal,
    goodsAmount,
    total,
    plan,
    planTemplate,
    chooseTemplate,
    addPlanRow,
    updatePlanRow,
    removePlanRow,
    planValidation,
    attachments,
    setAttachments,
    externalDocs,
    addAttachments,
    addExternalDocs,
    updateExternalDoc,
    removeExternalDoc,
    step,
    maxStep,
    goTo,
    goNext,
    submit,
    creating: create.isPending,
    quoteIdNum,
    attachmentCount: attachments.length,
    error,
    reset,
  };
}
