"use client";

/**
 * 第 1 步：客户与来源（业务客户必选；关联报价可选，选中带出条款/货物行）。
 * 来源（设计 §3.2）：询盘转化 / 直接下单 + 渠道；询盘必须属于本单客户。
 */
import { CustomerPicker } from "@/components/customer-picker";
import { Label } from "@/components/ui/label";
import { CHANNEL_LABEL, channelLabel } from "@/lib/inquiries/format";
import { ORDER_SOURCE_TYPE_LABEL } from "@/lib/orders/order-source";

import { useWizard } from "./wizard-context";

export function StepCustomerSource() {
  const {
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
  } = useWizard();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <CustomerPicker
        value={customer}
        onChange={(next) => {
          setCustomer(next);
          // 换客户必须重选询盘：询盘归属客户，跨客户选择会被内核 422
          setInquiryId("");
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
      <fieldset className="space-y-2 rounded-lg border border-border/70 p-3 sm:col-span-2">
        <legend className="px-1 text-xs font-medium">订单来源</legend>
        <div className="flex flex-wrap gap-4">
          {(["inquiry", "direct"] as const).map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-1.5 text-xs"
            >
              <input
                type="radio"
                name="order-source"
                value={value}
                checked={sourceType === value}
                onChange={() => {
                  setSourceType(value);
                  setInquiryId("");
                  setChannel("");
                  setError(null);
                }}
              />
              {ORDER_SOURCE_TYPE_LABEL[value]}
              <span className="text-muted-foreground">
                {value === "inquiry"
                  ? "（询盘 → 报价 → 本订单，可回溯）"
                  : "（线下电话单 / 老客户返单 / 展会现场单）"}
              </span>
            </label>
          ))}
        </div>

        {sourceType === "inquiry" ? (
          <div className="space-y-1.5">
            <Label className="text-xs">选择询盘（必选）</Label>
            <select
              aria-label="选择询盘"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={inquiryId}
              onChange={(e) => {
                setInquiryId(e.target.value);
                setError(null);
              }}
              disabled={!customer || inquiries.isLoading}
            >
              <option value="">— 选择该客户的询盘 —</option>
              {(inquiries.data ?? []).map((inquiry) => (
                <option key={inquiry.id} value={String(inquiry.id)}>
                  {(inquiry.inquiry_no ?? "#" + inquiry.id) +
                    " · " +
                    (inquiry.product_name_raw ?? "未填产品") +
                    (inquiry.channel
                      ? " · " + channelLabel(inquiry.channel)
                      : "")}
                </option>
              ))}
            </select>
            {!customer && (
              <p className="text-xs text-muted-foreground">
                先选客户，再选该客户的询盘（询盘必须属于本单客户）。
              </p>
            )}
            {customer && inquiries.isLoading && (
              <p className="text-xs text-muted-foreground">正在读取询盘…</p>
            )}
            {customer &&
              inquiries.isSuccess &&
              (inquiries.data ?? []).length === 0 && (
                <p className="text-xs text-warning">
                  该客户还没有询盘：可改为「直接下单」，或先在询盘工位新建询盘再回来。
                </p>
              )}
            {inquiries.isError && (
              <p className="text-xs text-warning">
                询盘列表读取失败：可改为「直接下单」继续建单，或稍后重试。
              </p>
            )}
            {selectedInquiry?.channel && (
              <p className="text-xs text-muted-foreground">
                渠道将继承询盘：{channelLabel(selectedInquiry.channel)}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label className="text-xs">来源渠道（可选，建议填写）</Label>
            <select
              aria-label="来源渠道"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value);
                setError(null);
              }}
            >
              <option value="">— 渠道未知（历史单可不填） —</option>
              {Object.entries(CHANNEL_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              直接下单是正常业务分类（不是异常）：渠道用于后续分析各来源的转化。
            </p>
          </div>
        )}
      </fieldset>
      {customerMismatch && (
        <p className="text-xs text-warning sm:col-span-2">
          提示：所选报价的客户是「{selectedQuote?.customer_name}
          」，与上面选的 「{customer?.name}
          」不一致。订单会按上面选的客户落库，请确认是不是同一家。
        </p>
      )}
    </div>
  );
}
