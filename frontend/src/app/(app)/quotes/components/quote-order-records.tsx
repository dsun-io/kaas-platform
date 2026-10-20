"use client";

import { LoadingBlock } from "@/components/shared/loading-block";

/**
 * 报价单记录 —— 历史报价的**全信息**视图（UNCERTAIN #19 口径）。
 *
 * 与下面的旧台账（quotations 事实表）并存：旧台账是"报价事实"窄表，
 * 本视图直接读 quote_orders（客户 / 时间 / 报价人 / 产品 / 规格 / 数量 / 价格），
 * 签发时落库的内部分解（cost_breakdown）给 platform 员工多两列：
 * 税前成本、利润（元/㎡）与利润率 —— **对内一目了然，对外无此列**
 * （后端对 customer 账号已按接口层剥除 cost_breakdown，前端再按账号类型守卫一次）。
 */
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/shared/detail-drawer";
import { NumberEditDialog } from "@/components/shared/number-edit-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useQuoteOrder,
  useQuoteOrders,
  useUpdateQuoteOrder,
} from "../hooks/use-quote-orders";
import { useRole } from "@/hooks/use-role";
import type { QuoteOrder, QuoteOrderItem } from "@contracts/quote-order";

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  sent: "已发送",
  accepted: "已接受",
  rejected: "已拒绝",
  expired: "已过期",
  closed: "已关闭",
};

/** cost_breakdown.currency_cny_per_m2 的形状（落库方在 line-to-item.ts）。 */
interface CostBreakdown {
  currency_cny_per_m2?: {
    cost_pretax?: number;
    profit_amount?: number;
    quote_excl_vat?: number;
  };
}

function fmt(n: number | null | undefined, digits = 2): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

/** 利润率 = 利润 ÷ 不含税售价（与算价引擎 margin_on_price 口径一致）。 */
function marginOf(bd: CostBreakdown | null | undefined): number | null {
  const profit = bd?.currency_cny_per_m2?.profit_amount;
  const quote = bd?.currency_cny_per_m2?.quote_excl_vat;
  if (profit == null || quote == null || quote <= 0) return null;
  return profit / quote;
}

function ItemRow({
  item,
  internal,
}: {
  item: QuoteOrderItem;
  internal: boolean;
}) {
  const bd = item.cost_breakdown as CostBreakdown | null | undefined;
  const spec = item.spec_snapshot as Record<string, unknown> | null | undefined;
  return (
    <TableRow>
      <TableCell className="font-medium">{item.product_name}</TableCell>
      <TableCell className="max-w-[220px] truncate text-xs">
        {typeof spec?.specification === "string" ? spec.specification : "—"}
      </TableCell>
      <TableCell className="text-xs">
        {item.qty} {item.qty_unit ?? ""}
      </TableCell>
      <TableCell className="text-xs">
        {fmt(item.unit_price)} {item.currency ?? ""}
      </TableCell>
      <TableCell className="text-xs">{fmt(item.line_amount)}</TableCell>
      {internal ? (
        <>
          <TableCell className="text-xs">
            {fmt(bd?.currency_cny_per_m2?.cost_pretax, 4)}
          </TableCell>
          <TableCell className="text-xs">
            {fmt(bd?.currency_cny_per_m2?.profit_amount, 4)}
          </TableCell>
          <TableCell className="text-xs">
            {marginOf(bd) == null
              ? "—"
              : `${((marginOf(bd) as number) * 100).toFixed(1)}%`}
          </TableCell>
        </>
      ) : null}
    </TableRow>
  );
}

export function QuoteOrderRecords() {
  const { data, isLoading } = useQuoteOrders();
  const { user } = useRole();
  // 双视图守卫：与后端剥除同口径（internal 才看得到分解列）
  const internal = user?.account_type === "internal";

  const orders: QuoteOrder[] = data?.items ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // 列表不返回行项（防 N+1）——选中后单独拉详情
  const detail = useQuoteOrder(selectedId);
  const selected = detail.data ?? null;
  const selectedItems: QuoteOrderItem[] = selected?.items ?? [];
  const update = useUpdateQuoteOrder();
  const [quoteNoEdit, setQuoteNoEdit] = useState<QuoteOrder | null>(null);
  const [quoteNoError, setQuoteNoError] = useState<string | null>(null);

  const saveQuoteNo = async (value: string) => {
    if (!quoteNoEdit) return;
    setQuoteNoError(null);
    try {
      await update.mutateAsync({
        id: quoteNoEdit.id,
        patch: { quote_no: value },
      });
      setQuoteNoEdit(null);
    } catch (e) {
      const msg =
        (e as { response?: { data?: { detail?: { detail?: string } } } })
          ?.response?.data?.detail?.detail ?? "修改失败，请重试";
      setQuoteNoError(msg);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          报价单记录
          {data && (
            <span className="ml-2 font-normal text-muted-foreground">
              共 {data.total} 单
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingBlock rows={3} className="py-6" />
        ) : orders.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无报价单 —— 在「产品报价」页保存后会出现在这里
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>报价单号</TableHead>
                <TableHead>客户</TableHead>
                <TableHead>时间</TableHead>
                <TableHead>报价人</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((q) => (
                <TableRow
                  key={q.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(q.id)}
                >
                  <TableCell className="font-mono text-xs">
                    <div className="flex items-center gap-1">
                      <span>{q.quote_no}</span>
                      {q.quote_no_editable !== false && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1 text-[11px]"
                          onClick={(e) => {
                            e.stopPropagation();
                            setQuoteNoError(null);
                            setQuoteNoEdit(q);
                          }}
                        >
                          改编号
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {q.customer_name ?? `#${q.customer_id ?? "—"}`}
                  </TableCell>
                  <TableCell className="text-xs">
                    {fmtDate(q.created_at)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {q.created_by ? `#${q.created_by}` : "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {q.total_amount == null
                      ? "—"
                      : `${q.total_amount.toFixed(2)} ${q.currency}`}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        q.status === "accepted"
                          ? "default"
                          : q.status === "rejected"
                            ? "secondary"
                            : "secondary"
                      }
                    >
                      {STATUS_LABELS[q.status] ?? q.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <DetailDrawer
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        title={selected ? `报价单 ${selected.quote_no}` : ""}
        description={
          selected
            ? `${selected.customer_name ?? "—"} · ${fmtDate(selected.created_at)}`
            : undefined
        }
      >
        {selected ? (
          detail.isLoading ? (
            <p className="text-sm text-muted-foreground">加载行项…</p>
          ) : selectedItems.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>产品</TableHead>
                  <TableHead>规格</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead>单价</TableHead>
                  <TableHead>行金额</TableHead>
                  {internal ? (
                    <>
                      <TableHead>税前成本(元/㎡)</TableHead>
                      <TableHead>利润(元/㎡)</TableHead>
                      <TableHead>利润率</TableHead>
                    </>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedItems.map((item) => (
                  <ItemRow key={item.id} item={item} internal={internal} />
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">该报价单暂无行项</p>
          )
        ) : null}
      </DetailDrawer>

      <NumberEditDialog
        open={quoteNoEdit !== null}
        onOpenChange={(open) => {
          if (!open) setQuoteNoEdit(null);
        }}
        title="修改报价单号"
        label="报价单号"
        currentValue={quoteNoEdit?.quote_no ?? ""}
        description="报价单号默认自动生成；生成 PI/合同等后续单证之前可以修改。"
        warning="确认后单号会立即生效。一旦生成 PI/合同等后续单证（或转为订单），该编号将自动锁定。"
        pending={update.isPending}
        error={quoteNoError}
        onConfirm={saveQuoteNo}
      />
    </Card>
  );
}
