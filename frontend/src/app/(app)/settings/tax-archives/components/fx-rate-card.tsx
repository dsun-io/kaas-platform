"use client";

/**
 * 「手工汇率」卡片（C36 #14）——挂在税务管理页（税务/汇率同属对外报价的输入参数）。
 *
 * 展示：`GET /fx-rates/latest` 的当前 USD/CNY 汇率与来源（过期会标黄）；
 * 录入：`POST /fx-rates`（同币种对+同日期 UPSERT），成功后失效 `["fx","latest"]`，
 * 报价工作台/批量导入的默认汇率会跟着刷新。
 *
 * 权限：后端该端点只要求登录（不要求团队管理员），卡片对登录用户可见；
 * 但税务页本身是团队管理员才可写的区域 —— 这里独立成卡，不继承页面的 canWrite。
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { normalizeApiError } from "@/lib/api/api-error";
import { useLatestFxRate } from "@/lib/fx/use-latest-fx";
import { useCreateFxRate } from "@/lib/fx/use-manual-fx";

function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function FxRateCard() {
  const latest = useLatestFxRate("USD", "CNY");
  const create = useCreateFxRate();
  const [base, setBase] = useState("USD");
  const [quote, setQuote] = useState("CNY");
  const [rate, setRate] = useState("");
  const [date, setDate] = useState(todayIso());
  const [source, setSource] = useState("manual");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const num = Number(rate);
    if (!Number.isFinite(num) || num <= 0) {
      setError("汇率必须是大于 0 的数字（如 6.7029）");
      return;
    }
    if (!base.trim() || !quote.trim()) {
      setError("基准币种、报价币种都必须填写");
      return;
    }
    try {
      const row = await create.mutateAsync({
        base_currency: base,
        quote_currency: quote,
        rate: num,
        rate_date: date || null,
        source,
      });
      toast.success(
        `已录入 ${row.base_currency}/${row.quote_currency} = ${row.rate}（${row.rate_date}）`,
      );
      setRate("");
    } catch (err) {
      // 422 invalid_rate / 网络错误都如实展示
      setError(normalizeApiError(err).message);
    }
  };

  const current = latest.data;

  return (
    <SectionCard
      title="汇率（手工录入兜底）"
      description="外部汇率源异常时手工录入当天汇率；同币种对+同日期的记录会被覆盖（source=manual 留痕）。"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">当前 USD/CNY：</span>
        {latest.isLoading ? (
          <span className="text-muted-foreground">读取中…</span>
        ) : current ? (
          <>
            <span className="font-mono font-medium">{current.rate}</span>
            <span className="text-xs text-muted-foreground">
              {current.rate_date} · {current.source ?? "unknown"}
            </span>
            {current.is_stale ? (
              <StatusBadge tone="warning">缓存已过期（外部源不可用）</StatusBadge>
            ) : (
              <StatusBadge tone="success">正常</StatusBadge>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            暂无汇率（外部源不可用时可手工录入）
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="space-y-1">
          <span className="text-sm font-medium">基准币种</span>
          <Input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="USD"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">报价币种</span>
          <Input
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            placeholder="CNY"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">汇率 *</span>
          <Input
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="如 6.7029"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">汇率日期</span>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">来源</span>
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="manual"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => void submit()} disabled={create.isPending}>
          {create.isPending ? "保存中…" : "保存汇率"}
        </Button>
        <span className="text-xs text-muted-foreground">
          1 {base || "USD"} = ? {quote || "CNY"}；保存后报价页默认汇率立即生效。
        </span>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SectionCard>
  );
}
