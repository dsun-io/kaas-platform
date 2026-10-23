"use client";

/**
 * 报价工作台 · 提交动作层（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * 只负责「把状态落库」：保存报价单 / 签发回调 / 批量生成单证。
 * 状态在 `use-workbench-state.ts`，界面在 `workbench-*` 组件里。
 */
import { toast } from "sonner";

import apiClient from "@/lib/api/client";
import { handleApiError } from "@/lib/api/error-handler";
import type { QuoteOrder } from "@contracts/quote-order";

import { FX_KEY, pctToRate, validUntil } from "./workbench-shared";
import type { WorkbenchState } from "./use-workbench-state";

/** 报价单头部 patch（客户快照 / 币种 / 有效期 / 条款 / 税务快照）。 */
function headerPatch(state: WorkbenchState) {
  return {
    customer_name: state.customerName || null,
    currency: state.quoteCurrency,
    valid_until: validUntil(state.quoteDate, state.validityDays),
    // 用户直选的对外条款（默认 EXW），阶梯已按该档截断
    incoterm: state.effectiveQuoteAs,
    freight_valid_from: state.freightFrom || null,
    freight_valid_to: state.freightTo || null,
    carrier: state.carrier || null,
    // 税务档案只记录来源；实际税率仍是下面快照里的显式值
    tax_archive_id: state.selectedTaxArchive?.id ?? null,
    tax_archive_code: state.selectedTaxArchive?.code ?? null,
    tax_archive_name: state.selectedTaxArchive?.name ?? null,
    tax_snapshot: {
      output_vat_rate: pctToRate(state.outputVatRatePct),
      misc_fee_rate: pctToRate(state.miscTaxPct),
      // 进项税/退税率按产品不同，快照保留当时每个产品的取值
      product_taxes: state.productTaxMap,
    },
  };
}

/** 动作层对外暴露的形状。 */
export interface WorkbenchActions {
  /** 保存（新建或更新 + 整批替换行项）；失败写页内 notice，不抛给调用方。 */
  onSave: () => Promise<void>;
  /** 签发成功回调：同步单据状态并提示入账。 */
  handleIssued: (updated: QuoteOrder) => void;
  /** 按 docPick 逐张生成单证（逐张失败可部分成功）。 */
  onGenerateDocs: () => Promise<void>;
}

export function useWorkbenchActions(state: WorkbenchState): WorkbenchActions {
  const items = () =>
    state.computed.map((b, i) => ({
      ...b.item,
      sort_order: i,
      spec_snapshot: b.item.spec_snapshot,
    }));

  const onSave = async () => {
    if (state.computed.length === 0) {
      toast.error("请先计算至少一行");
      return;
    }
    // 客户必选：报价是"客户 → 报价 → 报价单/订单 → 单证"这棵树唯一的根入口。
    // 不选客户就落库，这张报价在客户页永远查不到，也无法计入台账。
    if (!state.customer) {
      state.setCustomerError(
        "请选择业务客户 —— 报价必须挂客户，否则客户页的「往来记录」里查不到这张报价",
      );
      toast.error("请先选择业务客户");
      return;
    }
    state.setCustomerError(null);
    state.setNotice(null);
    // 客户在创建那一刻写死（Patch 契约不含 customer_id）：改了要重新建单，
    // 否则"单据上的客户"与"客户树里的客户"会不一致。
    const customerChanged =
      state.createdCustomerId !== null &&
      state.createdCustomerId !== state.customer.id;
    try {
      if (state.quoteOrderId === null) {
        const created = await state.mutations.create.mutateAsync({
          // 契约里 customer_id 是字符串（后端 BIGINT），与既有实现一致
          customer_id: state.customer.id,
          customer_name: state.customerName || null,
          inquiry_id: state.inquiryId ? Number(state.inquiryId) : null,
          currency: state.quoteCurrency,
          valid_until: validUntil(state.quoteDate, state.validityDays),
          incoterm: headerPatch(state).incoterm,
          // 可见范围默认 private（仅自己可见），与后端默认值一致
          owner_scope: "private",
          items: items(),
        });
        state.setQuoteOrderId(created.id);
        state.setCreatedCustomerId(state.customer.id);
        // 没选询盘时后端已自动给客户建一条，并把报价挂上去；这里同步到界面
        if (created.inquiry_id != null) {
          state.setInquiryId(String(created.inquiry_id));
          void state.queryClient.invalidateQueries({
            queryKey: ["customer-inquiries", state.customer.id],
          });
        }
        state.setSavedDoc({
          id: created.id,
          quote_no: created.quote_no,
          status: created.status,
        });
        state.setNotice({
          tone: "info",
          text: `已保存为报价单 ${created.quote_no}`,
        });
      } else {
        await state.mutations.update.mutateAsync({
          id: state.quoteOrderId,
          patch: headerPatch(state),
        });
        const res = await state.mutations.replaceItems.mutateAsync({
          id: state.quoteOrderId,
          items: items(),
        });
        state.setSavedDoc({
          id: state.quoteOrderId,
          quote_no: state.savedDoc?.quote_no ?? "",
          status: state.savedDoc?.status ?? "draft",
        });
        if (customerChanged) {
          state.setNotice({
            tone: "error",
            text: `已保存（${res.items.length} 行），但**客户未变更**：${state.customerLabel} 不适用于本单（报价单的客户在建单时确定）。需要换客户请新建一张报价，避免单据与客户归属不一致。`,
          });
        } else {
          state.setNotice({
            tone: "info",
            text: `已保存（${res.items.length} 行，合计 ${res.total_amount ?? "—"}）`,
          });
        }
      }
      window.localStorage.setItem(FX_KEY, state.fxRate);
    } catch (err) {
      state.setNotice({
        tone: "error",
        text: handleApiError(err as Parameters<typeof handleApiError>[0]),
      });
    }
  };

  /**
   * 签发成功回调。签发本身（二次确认 + 防重复 PATCH）收敛在 `QuoteIssueButton`，
   * 这里只负责把结果同步到界面（右侧汇总卡与底部吸底条共用同一个组件）。
   */
  const handleIssued = (updated: QuoteOrder) => {
    state.setSavedDoc({
      id: updated.id,
      quote_no: updated.quote_no,
      status: updated.status,
    });
    state.setNotice({
      tone: "info",
      text: `${updated.quote_no} 已签发，并已向报价记录台账入账一条`,
    });
  };

  const onGenerateDocs = async () => {
    if (!state.quoteOrderId) {
      toast.error("请先保存报价单 —— 单证必须挂靠上游，才能继承货物与条款");
      return;
    }
    if (state.docPick.length === 0) {
      toast.error("请先选择要生成的单证类型");
      return;
    }
    state.setGenerating(true);
    state.setNotice(null);
    const created: string[] = [];
    const failed: string[] = [];
    for (const docType of state.docPick) {
      try {
        const { data } = await apiClient.post<{ doc_no: string }>(
          "/trade-docs",
          {
            doc_type: docType,
            quote_order_id: state.quoteOrderId,
            currency: state.quoteCurrency,
          },
        );
        created.push(data.doc_no);
      } catch {
        failed.push(docType);
      }
    }
    state.setGenerating(false);
    if (created.length > 0) {
      toast.success(`已生成 ${created.length} 张单证：${created.join("、")}`);
      state.setNotice({
        tone: "info",
        text: `已生成：${created.join("、")}（到「单证」工位预览/签发）`,
      });
    }
    if (failed.length > 0) {
      state.setNotice({
        tone: "error",
        text: `以下类型生成失败：${failed.join("、")}`,
      });
    }
  };

  return { onSave, handleIssued, onGenerateDocs };
}
