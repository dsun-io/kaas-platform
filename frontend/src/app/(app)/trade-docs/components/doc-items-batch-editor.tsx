"use client";

/**
 * 行项批量编辑面板（A5-W2）
 *
 * 能力：多选（全选/半选）→ 选字段 → 填新值 → 预览「受影响行数 + 金额变化(CNY/USD)」→
 * **一次 PATCH** 保存 `custom.items_override` → 一次撤销（撤销同样是一次 PATCH）。
 *
 * 持久化契约（task-47 / align-b 实现的后端通道）：
 *   `raw_payload.custom.items_override = [{index, qty?, unit_price?, unit?, spec?, origin?}]`
 *   - 仅 draft；非 draft → 422 `ITEMS_OVERRIDE_DRAFT_ONLY`
 *   - index 越界 → 422 `ITEMS_OVERRIDE_INDEX`
 *   - 含金额键 → 422 `ITEMS_OVERRIDE_AMOUNT_FORBIDDEN`
 *   - 命中行 facts 标 `source=manual / trust=unverified` ⇒ 签发闸门拦住，直到人工确认
 *
 * 安全铁律：
 *   - **金额不可直接编辑**：`line_amount` 永远由 `qty × unit_price` 推导（4 位 ROUND_HALF_UP），
 *     override 里也绝不出现金额键（`validateItemsOverride` 会拦）；
 *   - 只改选中行；未选中行保持原引用；
 *   - 保存成功前**不显示"已保存"**；失败如实显示后端错误码/文案，且保留工作副本供重试/撤销。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  CheckCheck,
  RotateCcw,
  Save,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyBatchEdit,
  BATCH_FIELDS,
  buildItemsOverride,
  mergeItemsOverride,
  READONLY_AMOUNT_FIELDS,
  selectionState,
  summarizeBatchImpact,
  toggleAll,
  toggleRow,
  validateBatchValue,
  validateItemsOverride,
  type BatchField,
  type ItemRow,
  type ItemsOverrideEntry,
} from "@/lib/trade-doc/item-batch";
import { cn } from "@/lib/utils";

function money(amount: number | null, currency: string): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signed(amount: number): string {
  const prefix = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${prefix}${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function rowText(row: ItemRow, key: string): string {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/** 从 axios 错误里取后端 `detail.code/detail`（PATCH 422 的形状） */
function errorTextOf(error: unknown): string {
  const anyError = error as {
    response?: { data?: { detail?: unknown } | unknown; status?: number };
    message?: string;
  };
  const detail = anyError.response?.data;
  const inner =
    detail && typeof detail === "object" && "detail" in detail
      ? (detail as { detail?: unknown }).detail
      : undefined;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner === "object") {
    const obj = inner as { code?: unknown; detail?: unknown };
    const code = typeof obj.code === "string" ? obj.code : "";
    const text = typeof obj.detail === "string" ? obj.detail : "";
    return [code, text].filter(Boolean).join("：") || "保存失败";
  }
  return anyError.message ?? "保存失败（网络错误）";
}

export interface DocItemsBatchEditorProps {
  docType: string;
  /** 单据状态：只有 draft 能改（与后端 `_reject_protected_custom`/override 通道同口径） */
  status: string;
  /** 装配后的渲染数据（含 items/currency/fx_rate；金额预览复用 A5-W3 口径） */
  data: Record<string, unknown> | null | undefined;
  /** 既有 `custom.items_override`（撤销/合并的基线） */
  initialOverride?: ItemsOverrideEntry[];
  /**
   * 保存回调：一次调用 = 一次 PATCH（`raw_payload` 里放 `custom.items_override`）。
   * 不传时组件只维护工作副本并如实标注「未接入保存通道」。
   */
  onSave?: (override: ItemsOverrideEntry[]) => Promise<void>;
}

interface Snapshot {
  items: ItemRow[];
  override: ItemsOverrideEntry[];
  label: string;
}

export function DocItemsBatchEditor({
  docType,
  status,
  data,
  initialOverride,
  onSave,
}: DocItemsBatchEditorProps) {
  const sourceItems = useMemo<ItemRow[]>(() => {
    const raw = data?.items;
    return Array.isArray(raw)
      ? (raw as ItemRow[]).map((row) => ({ ...row }))
      : [];
  }, [data]);

  const editable = status === "draft";
  const [items, setItems] = useState<ItemRow[]>(sourceItems);
  const [override, setOverride] = useState<ItemsOverrideEntry[]>(
    initialOverride ?? [],
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [field, setField] = useState<BatchField>("unit_price");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [undo, setUndo] = useState<Snapshot | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  // 上游数据变化（重新带入/保存后刷新）⇒ 重置工作副本与选择。
  // React 19 的 lint 禁止"effect 里同步 setState"（级联渲染）；用官方推荐的
  // "渲染期按 props 变化调整 state"模式（带守卫，不会循环）。
  const [lastSource, setLastSource] = useState<ItemRow[]>(sourceItems);
  if (lastSource !== sourceItems) {
    setLastSource(sourceItems);
    setItems(sourceItems);
    setSelected(new Set());
    setSaveError("");
    // 注意：**不清** undo / savedAt —— 保存成功后父组件会 refetch（sourceItems 变），
    // 若在这里清掉，用户刚保存完就失去"已保存/撤销"，等于 undo 名存实亡。
  }

  // 既有 override 变化（页面刷新/撤销后回填）⇒ 同步基线；用内容签名比较，
  // 避免父组件每次渲染都传新数组导致无谓重置。
  const overrideSignature = JSON.stringify(initialOverride ?? []);
  const [lastOverrideSignature, setLastOverrideSignature] =
    useState(overrideSignature);
  if (lastOverrideSignature !== overrideSignature) {
    setLastOverrideSignature(overrideSignature);
    setOverride(initialOverride ?? []);
  }

  const state = selectionState(selected, items.length);
  const validation = validateBatchValue(field, value);
  const preview = useMemo(() => {
    if (!validation.ok || selected.size === 0) return null;
    const applied = applyBatchEdit(items, selected, field, validation.value);
    const impact = summarizeBatchImpact({
      docType,
      data,
      beforeItems: items,
      afterItems: applied.items,
      changedIndexes: applied.changedIndexes,
    });
    const entries = buildItemsOverride(items, applied.items);
    return { applied, impact, entries };
  }, [docType, data, items, selected, field, validation]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = state === "some";
    }
  }, [state]);

  const forbidden = preview
    ? validateItemsOverride(
        preview.entries as unknown as Record<string, unknown>[],
      )
    : null;
  const canApply =
    editable &&
    !saving &&
    validation.ok &&
    selected.size > 0 &&
    !!preview &&
    !preview.applied.unchanged &&
    forbidden === null;

  async function persist(
    nextItems: ItemRow[],
    nextOverride: ItemsOverrideEntry[],
    snapshot: Snapshot | null,
  ) {
    const blocked = validateItemsOverride(
      nextOverride as unknown as Record<string, unknown>[],
    );
    if (blocked) {
      setSaveError([blocked.code, blocked.detail].filter(Boolean).join("："));
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await onSave?.(nextOverride);
      setItems(nextItems);
      setOverride(nextOverride);
      setUndo(snapshot);
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch (error) {
      // 保存失败 ⇒ **不**改展示值之外的状态标注；保留工作副本并在错误条里如实说明
      setItems(nextItems);
      setSaveError(errorTextOf(error));
      setUndo(snapshot);
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    if (!preview || !canApply) return;
    const label = `批量改「${BATCH_FIELDS.find((f) => f.value === field)?.label}」`;
    const snapshot: Snapshot = { items, override, label };
    const nextOverride = mergeItemsOverride(override, preview.entries);
    await persist(preview.applied.items, nextOverride, snapshot);
    setValue("");
  }

  async function undoApply() {
    if (!undo || saving) return;
    const snapshot = undo;
    setUndo(null);
    await persist(snapshot.items, snapshot.override, null);
  }

  if (items.length === 0) {
    return (
      <p className="border-b bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        本单没有行项（行项来自上游订单/报价；无上游时无可批量编辑的内容）。
      </p>
    );
  }

  return (
    <div className="border-b" aria-label="行项批量编辑">
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/20 px-3 py-2 text-xs">
        <span className="flex items-center gap-1 font-medium">
          <ArrowRightLeft className="h-3.5 w-3.5" />
          行项批量编辑
        </span>
        <span className="text-muted-foreground">
          已选 <b>{selected.size}</b> / {items.length} 行
        </span>
        <button
          type="button"
          className="underline underline-offset-2 disabled:opacity-50"
          disabled={!editable || saving}
          onClick={() => setSelected(new Set())}
        >
          清空选择
        </button>
        <span className="text-muted-foreground">
          金额列只读（{READONLY_AMOUNT_FIELDS.join(" / ")} 由 数量×单价 推导）
        </span>
        {!editable && (
          <span className="rounded bg-warning-muted px-2 py-0.5 text-warning-muted-foreground">
            该单据状态为「{status}」，行项已冻结，不可批量修改
          </span>
        )}
        {saving && <span className="text-muted-foreground">保存中…</span>}
        {!saving && savedAt && (
          <span className="rounded bg-success-muted px-2 py-0.5 text-success-muted-foreground">
            已保存 {savedAt}（后端将把受影响行项事实标为未确认，签发前请复核）
          </span>
        )}
        {!saving && saveError && (
          <span
            className="rounded bg-destructive/10 px-2 py-0.5 text-destructive"
            role="alert"
          >
            未保存：{saveError}
          </span>
        )}
        {!onSave && (
          <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
            未接入保存通道（仅工作副本）
          </span>
        )}
        {undo && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={saving}
            onClick={() => void undoApply()}
          >
            <Undo2 className="mr-1 h-3 w-3" />
            撤销本次批量修改
          </Button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-end gap-2 border-b bg-background px-3 py-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">要改的字段</span>
            <select
              aria-label="批量字段"
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={field}
              disabled={!editable || saving}
              onChange={(e) => {
                setField(e.target.value as BatchField);
                setValue("");
              }}
            >
              {BATCH_FIELDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">新值</span>
            <Input
              aria-label="批量新值"
              className="h-8 w-32 text-xs"
              value={value}
              disabled={!editable || saving}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                field === "qty" || field === "unit_price"
                  ? "如 30 / 26.5"
                  : "文本"
              }
            />
          </label>
          <Button
            size="sm"
            className="h-8"
            onClick={() => void apply()}
            disabled={!canApply}
          >
            <CheckCheck className="mr-1 h-3.5 w-3.5" />
            {onSave
              ? `保存（${selected.size} 行，一次提交）`
              : `应用到工作副本（${selected.size} 行）`}
          </Button>
          {undo && (
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={saving}
              onClick={() => void undoApply()}
              title={undo.label}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              撤销
            </Button>
          )}

          {!validation.ok && (
            <span className="text-destructive" role="alert">
              {validation.error}
            </span>
          )}
          {validation.ok && selected.size > 0 && preview?.applied.unchanged && (
            <span className="text-muted-foreground">
              选中行的该字段已经等于这个值（没有变化）
            </span>
          )}
          {forbidden && (
            <span className="text-destructive" role="alert">
              {forbidden.code}：{forbidden.detail}
            </span>
          )}
          {validation.ok && preview && !preview.applied.unchanged && (
            <span className="text-muted-foreground">
              将影响 <b>{preview.impact.affectedRows}</b> 行 · 行合计{" "}
              {preview.impact.before.usd !== null ? (
                <>
                  CNY {money(preview.impact.before.cny, "").trim()} →{" "}
                  {money(preview.impact.after.cny, "").trim()}（
                  {signed(preview.impact.delta.cny ?? 0)}）· USD{" "}
                  {money(preview.impact.before.usd, "").trim()} →{" "}
                  {money(preview.impact.after.usd, "").trim()}（
                  {signed(preview.impact.delta.usd ?? 0)}）
                </>
              ) : (
                <>
                  合计 {money(preview.impact.before.cny, "")}
                  {" → "}
                  {money(preview.impact.after.cny, "")}
                </>
              )}
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="w-10 p-2">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="全选行项"
                  checked={state === "all"}
                  disabled={!editable || saving || items.length === 0}
                  onChange={() =>
                    setSelected(toggleAll(selected, items.length))
                  }
                />
              </th>
              <th scope="col" className="p-2">
                #
              </th>
              <th scope="col" className="p-2">
                品名
              </th>
              <th scope="col" className="p-2">
                规格
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
                行金额（只读）
              </th>
              <th scope="col" className="p-2">
                原产国
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((row, index) => {
              const checked = selected.has(index);
              return (
                <tr
                  key={index}
                  className={cn(
                    "border-b last:border-0",
                    checked && "bg-primary/5",
                  )}
                >
                  <td className="p-2">
                    <input
                      type="checkbox"
                      aria-label={`选择第 ${index + 1} 行`}
                      checked={checked}
                      disabled={!editable || saving}
                      onChange={() => setSelected(toggleRow(selected, index))}
                    />
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {index + 1}
                  </td>
                  <td className="p-2">{rowText(row, "product_name")}</td>
                  <td
                    className="max-w-[16rem] truncate p-2 text-xs"
                    title={rowText(row, "specification")}
                  >
                    {rowText(row, "specification")}
                  </td>
                  <td className="p-2">{rowText(row, "qty")}</td>
                  <td className="p-2 text-xs">{rowText(row, "qty_unit")}</td>
                  <td className="p-2">{rowText(row, "unit_price")}</td>
                  <td className="p-2 font-mono text-xs text-muted-foreground">
                    {rowText(row, "line_amount")}
                    <span className="ml-1 text-[10px]">只读</span>
                  </td>
                  <td className="p-2 text-xs">
                    {rowText(row, "country_of_origin")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground">
        <Save className="h-3 w-3" />
        一次保存 = 一次 PATCH（写
        `custom.items_override`，只含真正变化的行/字段）；
        保存后受影响行项事实标为未确认，签发闸门会拦住直到人工确认。
      </p>
    </div>
  );
}
