"use client";

/**
 * 开单表单：选单证类型 + 选业务客户（必选）+ 选父对象（可选）+ 币种。
 *
 * 关键设计
 * --------
 * - **客户必选**：`trade_docs.customer_id` 是指向业务客户的外键，
 *   买方识别、客户页的往来记录树都靠它。手输单号既容易错、
 *   也会绕开继承逻辑，所以这里一律用选择器。
 * - **父对象可选**：正常业务流是「报价 → 转订单 → 出单证」，但业务也允许
 *   手动新建与导入历史单据（设计文档 §1.6）—— 这类单据没有报价/订单这一环，
 *   直接挂客户是**正规路径**。因此父对象三选一（不关联 / 订单 / 报价单 / 询盘），
 *   天然互斥，不可能同时挂两个。
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

import {
  CustomerPicker,
  type CustomerPickerValue,
} from "@/components/customer-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildCreatePreviewData } from "@/lib/trade-doc/create-preview";
import { getAvailableTemplates } from "@/lib/trade-doc/render";
import {
  toCustomerIdPayload,
  useOrderOptions,
  useQuoteOptions,
} from "@/lib/workstation/use-upstream";

import { useCreateTradeDoc } from "../hooks/use-trade-docs";
import { DOC_TYPE_GROUPS, THIRD_PARTY_TYPES } from "../lib/doc-type-groups";
import { DocCreatePreview } from "./doc-create-preview";

/** 父对象类型：`none` = 直接挂客户（手动新建 / 导入历史单据的正规路径）。 */
type SourceKind = "none" | "order" | "quote" | "inquiry";

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
  // 是否盖公司默认公章（默认勾选）：随单保存；未配置默认章时后端不报错、只不盖章。
  // 目前只在开单时选择（已开单要改盖章需重开单；后端 with_seal 列已就绪，后续可扩 draft PATCH）。
  const [withSeal, setWithSeal] = useState(true);
  const [customer, setCustomer] = useState<CustomerPickerValue | null>(null);
  const [customerError, setCustomerError] = useState<string | null>(null);

  const orders = useOrderOptions();
  const quotes = useQuoteOptions();

  const create = useCreateTradeDoc();

  /**
   * 「成品预览」的可用性 = 开单必填是否齐全（与 submit() 的校验同一口径；
   * 差别只在这里不弹 toast，而是把入口禁用并把缺项列出来）。
   */
  const previewBlockers = useMemo(() => {
    const missing: string[] = [];
    if (docTypes.length === 0) missing.push("单证类型");
    if (!customer) missing.push("业务客户");
    if (sourceKind === "order" && !sourceId) missing.push("来源订单");
    if (sourceKind === "quote" && !sourceId) missing.push("来源报价单");
    if (sourceKind === "inquiry" && !sourceId.trim()) missing.push("询盘编号");
    return missing;
  }, [docTypes, customer, sourceKind, sourceId]);
  const previewBlocked = previewBlockers.length > 0;

  // 多选类型时预览第一张（开单后其余类型可在台账里逐张预览）
  const previewType = docTypes[0] ?? "";
  const previewDocLabel = useMemo(
    () =>
      templates.find((t) => t.doc_type === previewType)?.name_zh ?? previewType,
    [templates, previewType],
  );

  /**
   * 成品预览数据：样板底稿 + 当前表单已填值（客户/币种/上游贸易条款）。
   * **纯前端本地装配、不发任何请求、不写库**（边界见 lib/trade-doc/create-preview.ts）。
   */
  const preview = useMemo(() => {
    if (previewBlocked || !previewType) return null;
    const upstream =
      sourceKind === "order"
        ? (orders.data?.find((o) => String(o.id) === sourceId) ?? null)
        : sourceKind === "quote"
          ? (quotes.data?.find((q) => String(q.id) === sourceId) ?? null)
          : null;
    return buildCreatePreviewData({
      docType: previewType,
      currency,
      customerName: customer?.name ?? null,
      upstream,
    });
  }, [
    previewBlocked,
    previewType,
    sourceKind,
    sourceId,
    orders.data,
    quotes.data,
    currency,
    customer,
  ]);

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
    if (!customer) {
      setCustomerError(
        "请选择业务客户 —— 单证必须归属到客户，否则在客户页查不到这张单",
      );
      return toast.error("请先选择业务客户");
    }
    setCustomerError(null);

    // 上游字段先收在一起；`doc_type` 在循环里逐个补上
    // （不开个头就加 doc_type 的"半成品",避免类型上以为它已完整）
    let source: {
      order_id?: number;
      quote_order_id?: number;
      inquiry_id?: number;
    };
    if (sourceKind === "none") {
      // 直接挂客户：历史单据没走过报价/订单，这是设计允许的正规路径
      source = {};
    } else if (sourceKind === "order") {
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
          await create.mutateAsync({
            ...source,
            // 客户必选：order/quote 上游时后端会校验一致性，直接挂客户时它就是唯一归属
            customer_id: toCustomerIdPayload(customer.id),
            currency,
            doc_type: docType,
            // 始终显式带上（false 也要带）：否则后端无法区分
            // 「用户取消了盖章」和「老客户端没这个字段」
            with_seal: withSeal,
          }),
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

        {/* 客户是必选项，也是这张单唯一的"归属依据" —— 放第一格 */}
        <CustomerPicker
          value={customer}
          onChange={(next) => {
            setCustomer(next);
            setCustomerError(null);
          }}
          required
          label="业务客户"
          error={customerError}
          hint="单证挂到客户名下，才会出现在客户页的「往来记录」里"
        />

        <label className="space-y-1">
          <span className="text-sm font-medium">关联父对象（可选）</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={sourceKind}
            onChange={(e) => {
              setSourceKind(e.target.value as SourceKind);
              setSourceId("");
            }}
          >
            <option value="none">不关联（直接挂客户）</option>
            <option value="order">订单</option>
            <option value="quote">报价单</option>
            <option value="inquiry">询盘（手输编号）</option>
          </select>
          <span className="block text-xs text-muted-foreground">
            三选一，互斥；选了会让单据继承父对象的货物、金额与贸易条款
          </span>
        </label>

        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm font-medium">选择具体父对象</span>
          {sourceKind === "none" && (
            <span className="block rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              不关联报价/订单：这张单直接归属于所选的业务客户。
              导入的历史单据、线下手工开的单走这条路（不会成为「脏数据」）。
            </span>
          )}
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
              还没有订单。请先在「订单」工位建单，或改选「报价单」/「不关联」。
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

        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={withSeal}
            onChange={(e) => setWithSeal(e.target.checked)}
          />
          <span>
            <span className="font-medium">盖公司默认公章</span>
            <span className="block text-xs text-muted-foreground">
              默认勾选，随单保存。公章（含默认章）在「企业信息」里维护；
              未配置默认章时不会盖章，也不影响开单。
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <Button onClick={submit} disabled={create.isPending}>
          <FilePlus2 className="mr-1 h-4 w-4" />
          {create.isPending ? "开单中…" : `开单（${docTypes.length} 张）`}
        </Button>
        {/* 开单前成品预览：本地渲染、不写库（问题 6） */}
        <DocCreatePreview
          preview={preview}
          docLabel={previewDocLabel}
          blockers={previewBlockers}
        />
      </div>
    </div>
  );
}
