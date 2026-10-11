"use client";

/**
 * 单据内容填写入口（`raw_payload.custom`）
 *
 * 为什么必须有这个界面
 * --------------------
 * 单证工位此前只有「开单（选客户/类型/币种）」+「预览/打印」两端：
 * 单据建出来 `custom` 是空的，只能靠上游订单带入；**手工补内容没有任何入口**，
 * 于是 PI 的备注、唛头、公章、产品照片、买方回签栏全都填不进去
 * ——「能开单但填不进内容」。
 *
 * 设计取舍
 * --------
 * - **字段清单来自模板 manifest**（`getTemplateFields`），不在这里硬编码第二份；
 *   以后给某类单证加字段，界面自动出现，不会漏。
 * - **控件由字段类型推导**：标量给输入框、`object/array/image_list` 给 JSON 文本域、
 *   `image` 给文件选择（转 data URI）。类型未知时退回文本，**不静默丢字段**。
 * - **保存走 `PATCH /trade-docs/{id}`**，且 `raw_payload` 必须带上 `sources`
 *   （后端整块替换，漏了就抹掉上游快照 —— 见 `buildPayloadPatch` 的测试）。
 * - **仅 draft 可改**：签发后服务端返回 `PAYLOAD_LOCKED`，界面先把话说清楚，
 *   不让用户白填一遍。
 */
import { useMemo, useState } from "react";
import { FileJson2, ImageUp, Lock, Save, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildCustom,
  buildPayloadPatch,
  listCustomFields,
  parseInput,
  readImageAsDataUri,
  toInputText,
  type CustomFieldDef,
  type TradeDocRawPayload,
} from "@/lib/trade-doc/custom-fields";

import { useUpdateTradeDoc } from "../hooks/use-trade-docs";
import { DocPhotoPicker } from "./doc-photo-picker";

export function DocCustomForm({
  docId,
  docType,
  status,
  payload,
}: {
  docId: number;
  docType: string;
  status: string;
  payload: TradeDocRawPayload | null | undefined;
}) {
  const update = useUpdateTradeDoc();
  const custom = (payload?.custom ?? {}) as Record<string, unknown>;
  const fields = useMemo(() => listCustomFields(docType), [docType]);

  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, toInputText(custom[f.name])])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const editable = status === "draft";

  const setText = (name: string, value: string) => {
    setTexts((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const reset = () => {
    setTexts(
      Object.fromEntries(fields.map((f) => [f.name, toInputText(custom[f.name])])),
    );
    setErrors({});
  };

  const save = () => {
    const nextErrors: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      const parsed = parseInput(field.control, texts[field.name] ?? "");
      if (!parsed.ok) nextErrors[field.name] = parsed.error ?? "格式不对";
      else values[field.name] = parsed.value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("有字段格式不对，先改完再保存");
      return;
    }
    update.mutate(
      { id: docId, raw_payload: buildPayloadPatch(payload, buildCustom(custom, values)) },
      {
        onSuccess: () => toast.success("单据内容已保存"),
        onError: () => toast.error("保存失败（已签发的单据内容冻结，不可修改）"),
      },
    );
  };

  // ── 产品图引用（用户要求：单证直接调用产品管理页面的图片）────────────────
  // `product_photos` 支持 `{"file_id": N, "caption": …}` 条目：引用产品图库里的图，
  // 由后端 render-data 装配层解析成 data URI（渲染器白名单不放开，也不需要放开）。
  const photosField = useMemo(() => fields.find((f) => f.name === "product_photos"), [fields]);
  const pickedIds = useMemo(() => {
    const raw = texts["product_photos"];
    if (!raw?.trim()) return [] as number[];
    try {
      const arr: unknown = JSON.parse(raw);
      if (!Array.isArray(arr)) return [] as number[];
      return arr
        .map((e) => (e && typeof e === "object" ? (e as { file_id?: number }).file_id : undefined))
        .filter((n): n is number => typeof n === "number");
    } catch {
      return [] as number[]; // 用户正在手改 JSON 时不让选择器报错
    }
  }, [texts]);

  const appendPhoto = (entry: { file_id: number; caption: string }) => {
    const current = texts["product_photos"] ?? "";
    let arr: unknown[] = [];
    if (current.trim()) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (!Array.isArray(parsed)) {
          toast.error("产品照片需要是数组形式，先改好再加图");
          return;
        }
        arr = parsed;
      } catch {
        toast.error("现有内容不是合法 JSON，先修好再加图");
        return;
      }
    }
    if (arr.some((e) => e && typeof e === "object" && (e as { file_id?: number }).file_id === entry.file_id)) {
      toast.info("这张图已经在单据里了");
      return;
    }
    arr.push({ file_id: entry.file_id, caption: entry.caption });
    setText("product_photos", JSON.stringify(arr, null, 2));
    toast.success("已添加引用（点「保存内容」后生效）");
  };

  return (
    <div className="mb-4 rounded-md border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <FileJson2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">填写单据内容</span>
        <span className="text-xs text-muted-foreground">
          手工填写**优先于**上游带入：只填要覆盖或补充的项，其余留空即用上游数据
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={reset} disabled={!editable}>
            <Undo2 className="mr-1 h-3.5 w-3.5" />
            还原
          </Button>
          <Button size="sm" onClick={save} disabled={!editable || update.isPending}>
            <Save className="mr-1 h-3.5 w-3.5" />
            {update.isPending ? "保存中…" : "保存内容"}
          </Button>
        </div>
      </div>

      {!editable && (
        <p className="border-b bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
          该单据状态为「{status}」，内容已冻结，不可修改。
        </p>
      )}

      <div className="grid gap-3 p-3 sm:grid-cols-2">
        {fields.map((field) => (
          <FieldRow
            key={field.name}
            field={field}
            text={texts[field.name] ?? ""}
            error={errors[field.name]}
            disabled={!editable}
            onChange={(value) => setText(field.name, value)}
          />
        ))}
        {photosField && (
          <DocPhotoPicker onPick={appendPhoto} disabled={!editable} pickedIds={pickedIds} />
        )}
      </div>
    </div>
  );
}

function FieldRow({
  field,
  text,
  error,
  disabled,
  onChange,
}: {
  field: CustomFieldDef;
  text: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { name, spec, control } = field;
  const label = spec.description ?? name;
  const wide = control === "json";

  if (field.protected) {
    // 受保护字段（金额/行项）：不提供编辑控件 —— 它们只能来自上游快照或系统计算。
    // 服务端的闸门是 422 CUSTOM_FIELD_PROTECTED，这里只是不让人白填一遍。
    return (
      <div className="space-y-1 rounded-md border border-dashed bg-muted/30 p-2 sm:col-span-2">
        <span className="flex items-center gap-1 text-xs font-medium">
          <Lock className="h-3 w-3" />
          {label}
          <code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {name}
          </code>
        </span>
        <p className="text-[11px] text-muted-foreground">
          只能来自上游订单/报价或系统计算，<b>不接受手工覆盖</b>
          （服务端会直接拒绝）。改了上游再「重新带入」即可。
        </p>
      </div>
    );
  }

  return (
    <label className={`space-y-1 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="flex items-center gap-1 text-xs font-medium">
        {label}
        <code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {name}
        </code>
        {spec.required && <span className="text-destructive">*</span>}
        <span className="text-[10px] font-normal text-muted-foreground">
          {control}
        </span>
      </span>

      {control === "json" && (
        <textarea
          className="min-h-[88px] w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={name === "product_photos" ? '[{"image":"data:image/jpeg;base64,…","caption":"…"}]' : "{}"}
        />
      )}

      {control === "boolean" && (
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={text === "true" ? "true" : text === "" ? "" : "false"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">（不填）</option>
          <option value="true">是 / 印出</option>
          <option value="false">否 / 不印</option>
        </select>
      )}

      {control === "image" && (
        <div className="space-y-2">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={disabled}
            className="block w-full text-xs"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                onChange(await readImageAsDataUri(file));
              } catch {
                toast.error("读取图片失败");
              }
            }}
          />
          {text ? (
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={text} alt={name} className="h-10 w-auto border" />
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() => onChange("")}
              >
                清除
              </Button>
            </div>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ImageUp className="h-3.5 w-3.5" />
              选择图片后会内联成 data URI 存进单据（渲染器只收 data: 与 http(s)）
            </span>
          )}
        </div>
      )}

      {(control === "text" || control === "date" || control === "number") && (
        <Input
          type={control === "date" ? "date" : control === "number" ? "number" : "text"}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {error && <span className="block text-[11px] text-destructive">{error}</span>}
    </label>
  );
}
