"use client";

/**
 * 开单表单：选单证类型 + 选上游来源（订单 / 报价单 / 询盘）+ 币种。
 *
 * 关键设计
 * --------
 * - 单证类型来自模板清单（manifest），所以「能选的类型」一定「渲染得出来」，
 *   不会出现选了某类型却打不开的情况。
 * - 类型**多选**：一票货常常要同时开报价单 + 形式发票 + 合同（按业务顺序），
 *   一次提交依次开完，避免"开一张、再回来选下一张"重复操作。
 * - 类型按业务分组展示（出口商自制 / 第三方签发 / 通用），
 *   并标注「第三方签发」—— 这类单据本系统只出申报信息，不是正式凭证，
 *   提前讲清楚，避免用户以为打印出来就能用。
 */
import { useMemo, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getAvailableTemplates } from "@/lib/trade-doc/render";
import {
  useOrderOptions,
  useQuoteOptions,
} from "@/lib/workstation/use-upstream";

import { useCreateTradeDoc } from "../hooks/use-trade-docs";
import { DOC_TYPE_GROUPS, THIRD_PARTY_TYPES } from "../lib/doc-type-groups";

type SourceKind = "order" | "quote" | "inquiry" | "none";

export function DocCreateForm({
  onCreated,
}: {
  onCreated?: (id: number) => void;
}) {
  const templates = useMemo(() => getAvailableTemplates(), []);
  const [docTypes, setDocTypes] = useState<string[]>(["ci"]);
  const [sourceKind, setSourceKind] = useState<SourceKind>("order");
  const [sourceId, setSourceId] = useState("");
  const [currency, setCurrency] = useState("USD");

  const orders = useOrderOptions();
  const quotes = useQuoteOptions();

  const create = useCreateTradeDoc();

  const toggleType = (value: string) =>
    setDocTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );

  /**
   * 依次开单。
   *
   * 逐个开而不是并集提交：单证工位的接口是"一张一个类型"（每种单据有自己的
   * 编号前缀、必填项与快照），并发提交会让失败定位变模糊。
   * 因此这里**逐张报错**：哪一张没开出来必须说清楚，不能"部分成功"就笼统提示成功。
   */
  const submit = async () => {
    if (docTypes.length === 0) return toast.error("请至少选择一种单证类型");
    if (sourceKind === "none") {
      return toast.error("单证必须关联一个上游来源（订单 / 报价单 / 询盘）");
    }

    // 上游字段先收在一起；`doc_type` 在循环里逐个补上
    // （不开个头就加 doc_type 的"半成品",避免类型上以为它已完整）
    let source: { order_id?: number; quote_order_id?: number; inquiry_id?: number };
    if (sourceKind === "order") {
      if (!sourceId) return toast.error("请选择来源订单");
      source = { order_id: Number(sourceId) };
    } else if (sourceKind === "quote") {
      if (!sourceId) return toast.error("请选择来源报价单");
      source = { quote_order_id: Number(sourceId) };
    } else {
      if (!sourceId) return toast.error("请输入询盘编号");
      source = { inquiry_id: Number(sourceId) };
    }

    const created: { id: number; doc_no: string }[] = [];
    const failed: string[] = [];
    for (const docType of docTypes) {
      try {
        created.push(
          await create.mutateAsync({ ...source, currency, doc_type: docType }),
        );
      } catch {
        failed.push(docType);
      }
    }

    if (created.length > 0) {
      toast.success(`已开单：${created.map((d) => d.doc_no).join("、")}`);
      // 预览第一张（用户最想先看的那张），其余在台账里可点开
      const first = created[0];
      if (first) onCreated?.(first.id);
    }
    if (failed.length > 0) {
      toast.error(`以下类型未生成：${failed.join("、")}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <span className="text-sm font-medium">
            单证类型（可多选，共 {docTypes.length} 张）
          </span>
          <div className="space-y-2 rounded-md border p-3">
            {DOC_TYPE_GROUPS.map((group) => (
              <div key={group.label} className="space-y-1">
                <p className="text-xs text-muted-foreground">{group.label}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {group.types
                    .map((type) => templates.find((t) => t.doc_type === type))
                    .filter((t): t is NonNullable<typeof t> => Boolean(t))
                    .map((t) => (
                      <label
                        key={t.doc_type}
                        className="flex items-center gap-1.5 text-sm"
                        title={t.description}
                      >
                        <input
                          type="checkbox"
                          checked={docTypes.includes(t.doc_type)}
                          onChange={() => toggleType(t.doc_type)}
                        />
                        {t.name_zh}
                        <span className="text-xs text-muted-foreground">
                          {t.name_en}
                          {THIRD_PARTY_TYPES.has(t.doc_type)
                            ? "（第三方签发）"
                            : ""}
                        </span>
                      </label>
                    ))}
                </div>
              </div>
            ))}
          </div>
          <span className="block text-xs text-muted-foreground">
            一票货常常要同时开报价单 + 形式发票 + 合同（按业务顺序）。
            勾选多个会**依次开单**，哪一张没开成会单独提示。
          </span>
        </div>

        <label className="space-y-1">
          <span className="text-sm font-medium">上游来源</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={sourceKind}
            onChange={(e) => {
              setSourceKind(e.target.value as SourceKind);
              setSourceId("");
            }}
          >
            <option value="order">订单</option>
            <option value="quote">报价单</option>
            <option value="inquiry">询盘（手输编号）</option>
          </select>
          <span className="block text-xs text-muted-foreground">
            单据会继承上游的货物、金额与贸易条款
          </span>
        </label>

        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm font-medium">选择具体来源</span>
          {sourceKind === "order" && (
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">— 请选择订单 —</option>
              {(orders.data ?? []).map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.order_no} · {o.customer_name ?? "未填客户"} · {o.currency}{" "}
                  {o.total_amount ?? "-"}
                </option>
              ))}
            </select>
          )}
          {sourceKind === "quote" && (
            <select
              className="h-9 w-full md:w-full rounded-md border border-input bg-background px-2 text-sm"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">— 请选择报价单 —</option>
              {(quotes.data ?? []).map((q) => (
                <option key={q.id} value={String(q.id)}>
                  {q.quote_no} · {q.customer_name ?? "未填客户"} · {q.currency}{" "}
                  {q.total_amount ?? "-"}
                </option>
              ))}
            </select>
          )}
          {sourceKind === "inquiry" && (
            <Input
              placeholder="询盘编号（数字 ID）"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            />
          )}
          {sourceKind === "order" && orders.data?.length === 0 && (
            <span className="block text-xs text-warning">
              还没有订单。请先在「订单」工位建单，或改选「报价单」。
            </span>
          )}
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">币种</span>
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </label>
      </div>

      <Button onClick={submit} disabled={create.isPending}>
        <FilePlus2 className="mr-1 h-4 w-4" />
        {create.isPending ? "开单中…" : `开单（${docTypes.length} 张）`}
      </Button>
    </div>
  );
}
