"use client";

/**
 * 询盘详情抽屉（X1 · 审计 §1.5）。
 *
 * 原来客户页把「产品行 + 联系人 + 渠道 + 报价→订单→单证 + 阶段历史」全部
 * **内联展开在卡片下方**：卡片被越推越长、与列表滚动混在一起，客户详情本身
 * 又是一个左侧面板，等于三层纵向堆叠。现在统一收进右侧 `DetailDrawer`：
 *   · 卡片仍保留摘要（询盘号 / 阶段 / 产品摘要 / 报价状态）；
 *   · 点卡片（或 Enter/Space）→ 抽屉里看全部后续进度。
 *
 * 数据来源不变：`InquiryFollowup` 仍读客户记录接口（`/customers/{id}/records`）
 * 聚合出的 quotes/orders/documents；`InquiryStageHistory` 仍读
 * `/inquiries/{id}/stage-log`（失败静默隐藏，不影响主信息）。
 */
import type { StatusTone } from "@/components/shared";
import { DetailDrawer } from "@/components/shared/detail-drawer";
import type { RecordQuote } from "@/lib/customer/customer-records";

import { InquiryFollowup, InquiryStageHistory } from "./inquiry-followups";
import {
  displayInquiryItems,
  inquiryProductSummary,
  type InquiryItem,
} from "./inquiry-items";

/** 抽屉只需要询盘的展示字段（与客户详情接口 `inquiries[]` 同形）。 */
export interface InquiryDetailSource {
  id: number;
  inquiry_no?: string | null;
  channel: string | null;
  product_name_raw: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  application: string | null;
  items?: InquiryItem[] | null;
  status: string;
  created_at: string;
}

export interface InquiryDetailContact {
  id: number;
  name: string;
}

export function InquiryDetailDrawer({
  open,
  onOpenChange,
  inquiry,
  stage,
  quotes,
  primaryContact = null,
  onContactClick,
  recordsLoading = false,
  recordsUnavailable = false,
  onRetryRecords,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inquiry: InquiryDetailSource | null;
  stage: { label: string; tone: StatusTone } | null;
  quotes: RecordQuote[];
  primaryContact?: InquiryDetailContact | null;
  /** 点击联系人（由客户页打开联系人详情弹窗并关闭本抽屉） */
  onContactClick?: () => void;
  recordsLoading?: boolean;
  recordsUnavailable?: boolean;
  onRetryRecords?: () => void;
}) {
  const productViews = inquiry ? displayInquiryItems(inquiry) : [];

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      widthClassName="sm:max-w-2xl"
      title={
        inquiry ? `询盘 ${inquiry.inquiry_no ?? `#${inquiry.id}`}` : "询盘详情"
      }
      description={
        inquiry
          ? `${inquiryProductSummary(productViews)}${
              stage ? ` · 当前阶段：${stage.label}` : ""
            }`
          : undefined
      }
    >
      {inquiry ? (
        <div className="space-y-4">
          <section
            aria-labelledby="inquiry-products-title"
            className="space-y-2"
          >
            <h4
              id="inquiry-products-title"
              className="text-xs font-medium text-muted-foreground"
            >
              产品（{productViews.length}）
            </h4>
            {productViews.length === 0 ? (
              <p className="text-xs text-muted-foreground">未填写产品</p>
            ) : (
              productViews.map((item, itemIndex) => (
                <div
                  key={`inquiry-item-${itemIndex}`}
                  className="rounded-lg border border-border/60 bg-white/60 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      {item.name}
                    </span>
                    <span className="text-muted-foreground">
                      {item.quantity != null
                        ? `${item.quantity} ${item.quantityUnit ?? ""}`
                        : "数量未填"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                    <span>规格：{item.spec ?? "—"}</span>
                    <span>用途：{item.application ?? "—"}</span>
                  </div>
                </div>
              ))
            )}
          </section>

          <section
            aria-labelledby="inquiry-basic-title"
            className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"
          >
            <h4 id="inquiry-basic-title" className="sr-only">
              询盘基本信息
            </h4>
            <span className="sm:col-span-2">
              联系人：
              {primaryContact ? (
                onContactClick ? (
                  <button
                    type="button"
                    onClick={() => onContactClick()}
                    className="font-medium text-primary hover:underline"
                  >
                    {primaryContact.name}
                  </button>
                ) : (
                  <span className="font-medium text-foreground">
                    {primaryContact.name}
                  </span>
                )
              ) : (
                "—"
              )}
            </span>
            <span>渠道：{inquiry.channel ?? "—"}</span>
            <span>
              创建：
              {new Date(inquiry.created_at).toLocaleDateString()}
            </span>
          </section>

          <section
            aria-labelledby="inquiry-followup-title"
            className="space-y-2"
          >
            <h4
              id="inquiry-followup-title"
              className="text-xs font-medium text-muted-foreground"
            >
              报价 → 订单 → 单证
            </h4>
            <InquiryFollowup
              quotes={quotes}
              loading={recordsLoading}
              unavailable={recordsUnavailable}
              onRetry={onRetryRecords}
              emptyText={
                inquiry.status === "quoted"
                  ? "该询盘已标记为「已报价」，但暂时没有找到关联的报价单。"
                  : "该询盘还没有报价单。"
              }
            />
          </section>

          {/* F4 阶段变更历史（只读；接口失败静默隐藏） */}
          <InquiryStageHistory inquiryId={inquiry.id} />
        </div>
      ) : null}
    </DetailDrawer>
  );
}
