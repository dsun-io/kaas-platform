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
 * - **`custom.product_key`（关联产品）**：产品基础信息在「产品」工位维护一次，
 *   单据只记"本单属于哪个产品"；render-data 装配时由后端把产品档案里对应的字段
 *   补进**仍为空**的行项（HS 编码）。字段名与优先级由共享内核
 *   `kaas_common/trade_doc/product_defaults.py` 定，这里只是选择器。
 */
import { useMemo, useState } from "react";
import { FileJson2, ImageUp, Lock, Package, Save, Undo2 } from "lucide-react";

import { ErrorState } from "@/components/shared/error-state";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  decideFill,
  isClauseField,
  pickTemplateFill,
  templateAppliesTo,
  type ClauseTemplate,
} from "@/lib/trade-doc/clause-templates";
import { useClauseTemplates } from "@/lib/trade-doc/use-clause-templates";
import { useProducts } from "@/lib/products/use-products";

import { useUpdateTradeDoc } from "../hooks/use-trade-docs";
import { effectivePayload } from "@/lib/trade-doc/amount-summary";

import { AmountSummaryBar } from "./amount-summary-bar";
import { DocPhotoPicker, type PickedPhoto } from "./doc-photo-picker";
import {
  parsePhotoEntries,
  removePhotoEntry,
  reorderPhotoEntries,
} from "./photo-entries";

/** 单据关联的产品 key 存在 custom 的这个键上（后端共享内核同一口径） */
const PRODUCT_KEY = "product_key";

/**
 * 内容项填错时给人话（解析能力不变，只改展示）：
 * - 多项内容（原 JSON 文本域）格式不对 ⇒ 告诉他"照提示填 / 留空沿用上游"，不甩解析错误；
 * - 标量沿用既有可读提示（如"不是合法数字"）。
 */
function fieldErrorMessage(control: string, error?: string): string {
  if (control === "json") {
    return "格式无法识别：请按输入框里的提示填写；一般留空即可沿用上游带入的内容";
  }
  return error && error !== "未知字段" && error !== "JSON 解析失败"
    ? error
    : "这项内容格式不对，请检查后重试";
}

/** 控件类型换成业务说法（不把 json/boolean 这些类型名摆给用户） */
const CONTROL_LABELS: Record<string, string> = {
  text: "文本",
  date: "日期",
  number: "数字",
  boolean: "是 / 否",
  image: "图片",
  json: "多项内容",
};

export function DocCustomForm({
  docId,
  docType,
  status,
  payload,
  data,
}: {
  docId: number;
  docType: string;
  status: string;
  /** `raw_payload`（含 sources/custom；保存时整块回写） */
  payload: TradeDocRawPayload | null | undefined;
  /** 装配后的渲染数据（含 items/currency 与 custom 合并结果）—— 金额摘要条的数据源 */
  data: Record<string, unknown> | null | undefined;
}) {
  const update = useUpdateTradeDoc();
  const custom = (payload?.custom ?? {}) as Record<string, unknown>;
  const fields = useMemo(() => listCustomFields(docType), [docType]);
  const products = useProducts();

  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.name, toInputText(custom[f.name])]),
    ),
  );
  // 关联产品（`custom.product_key`）：不是模板字段，所以单独一个状态，
  // 保存时并进同一份 `values` —— 清空即删掉该键（buildCustom 的 undefined 语义）。
  const savedProductKey =
    typeof custom[PRODUCT_KEY] === "string"
      ? (custom[PRODUCT_KEY] as string)
      : "";
  const [productKey, setProductKey] = useState<string>(savedProductKey);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const editable = status === "draft";

  // A5-W3：把正在编辑的 custom 叠到装配数据上 ⇒ 摘要条与「保存后会渲染成什么样」同口径。
  // 受保护字段（items / total_amount）不参与合并（effectivePayload 内已挡，与后端一致）。
  const pendingCustom = useMemo(() => {
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.protected) continue;
      const parsed = parseInput(field.control, texts[field.name] ?? "");
      if (parsed.ok && parsed.value !== undefined)
        values[field.name] = parsed.value;
    }
    return values;
  }, [fields, texts]);
  const effectiveData = useMemo(
    () => effectivePayload(data, pendingCustom),
    [data, pendingCustom],
  );

  /**
   * 条款模板（A5-W1）：只对 manifest 里真实存在的条款字段（payment_terms/inspection/
   * claims/force_majeure/arbitration）提供「选择模板回填」；其余字段保持原表单。
   * 模板列表按 doc_type 过滤（GET ?doc_type=），且前端再按 doc_types 兜一层
   * （空 doc_types = 通用）。
   */
  const clauseFields = useMemo(
    () => fields.filter((f) => isClauseField(f.name) && !f.protected),
    [fields],
  );
  const clauseTemplatesQuery = useClauseTemplates(docType, {
    enabled: editable && clauseFields.length > 0,
  });
  const clauseTemplates = useMemo(
    () =>
      (clauseTemplatesQuery.data ?? []).filter((t) =>
        templateAppliesTo(t, docType),
      ),
    [clauseTemplatesQuery.data, docType],
  );
  /** 仅"已填内容 + 模板不同"时才弹二次确认；默认只填空字段（风险 1）。 */
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    field: CustomFieldDef;
    template: ClauseTemplate;
  } | null>(null);
  /** 回填后的"备注说明"（单段字段实际回填了英文还是中文；按字段展示） */
  const [fillNotes, setFillNotes] = useState<Record<string, string>>({});

  const applyTemplate = (field: CustomFieldDef, template: ClauseTemplate) => {
    if (!editable) return;
    const fill = pickTemplateFill(template);
    const decision = decideFill(texts[field.name] ?? "", fill.text);
    if (decision === "noop") {
      toast.info(
        fill.text
          ? "该模板内容与当前内容项一致，无需回填"
          : "该模板中英文内容都是空的，未回填",
      );
      return;
    }
    if (decision === "confirm-overwrite") {
      setPendingOverwrite({ field, template });
      return;
    }
    setText(field.name, fill.text);
    setFillNotes((prev) => ({ ...prev, [field.name]: fill.note }));
    toast.success(
      `已用「${template.name}」回填（${fill.lang === "en" ? "英文" : "中文"}）`,
    );
  };

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
      Object.fromEntries(
        fields.map((f) => [f.name, toInputText(custom[f.name])]),
      ),
    );
    setProductKey(savedProductKey);
    setErrors({});
  };

  const save = () => {
    const nextErrors: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      const parsed = parseInput(field.control, texts[field.name] ?? "");
      if (!parsed.ok) {
        nextErrors[field.name] = fieldErrorMessage(field.control, parsed.error);
      } else values[field.name] = parsed.value;
    }
    values[PRODUCT_KEY] = productKey.trim() ? productKey.trim() : undefined;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("有内容项格式不对，请按提示改完再保存");
      return;
    }
    update.mutate(
      {
        id: docId,
        raw_payload: buildPayloadPatch(payload, buildCustom(custom, values)),
      },
      {
        onSuccess: () => toast.success("单据内容已保存"),
        onError: () =>
          toast.error("保存失败（已签发的单据内容冻结，不可修改）"),
      },
    );
  };

  // ── 产品图引用（用户要求：单证直接调用产品管理页面的图片）────────────────
  // `product_photos` 支持 `{"file_id": N, "caption": …}` 条目：引用产品图库里的图，
  // 由后端 render-data 装配层解析成 data URI（渲染器白名单不放开，也不需要放开）。
  const photosField = useMemo(
    () => fields.find((f) => f.name === "product_photos"),
    [fields],
  );
  /**
   * 已引用的图（顺序 = 出图顺序）。
   *
   * 解析与写回都在 `./photo-entries`（纯函数、有单测）：那里钉住了两条约束 ——
   * 重排只换位置不吃字段、遇到认不出来的条目宁可不动。这里只做状态搬运。
   */
  const pickedPhotos = useMemo(
    () => parsePhotoEntries(texts["product_photos"]),
    [texts],
  );

  const pickedIds = useMemo(
    () => pickedPhotos.map((p) => p.file_id),
    [pickedPhotos],
  );

  const reorderPhotos = (next: PickedPhoto[]) => {
    const written = reorderPhotoEntries(texts["product_photos"], next);
    if (written === null) {
      toast.error("产品照片里有无法识别的条目，请先修正 JSON 后再拖动排序");
      return;
    }
    setText("product_photos", written);
  };

  const removePhoto = (fileId: number) => {
    const written = removePhotoEntry(texts["product_photos"], fileId);
    if (written === null) {
      toast.error("现有内容格式无法识别，请先修正后再移除");
      return;
    }
    setText("product_photos", written);
  };

  const appendPhoto = (entry: { file_id: number; caption: string }) => {
    const current = texts["product_photos"] ?? "";
    let arr: unknown[] = [];
    if (current.trim()) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (!Array.isArray(parsed)) {
          toast.error("产品照片的填写格式无法识别，请先修正后再加图");
          return;
        }
        arr = parsed;
      } catch {
        toast.error("现有内容格式无法识别，请先修正后再加图");
        return;
      }
    }
    if (
      arr.some(
        (e) =>
          e &&
          typeof e === "object" &&
          (e as { file_id?: number }).file_id === entry.file_id,
      )
    ) {
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
          <Button
            size="sm"
            variant="ghost"
            onClick={reset}
            disabled={!editable}
          >
            <Undo2 className="mr-1 h-3.5 w-3.5" />
            还原
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!editable || update.isPending}
          >
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

      {/* A5-W3：只读金额摘要条（编辑中即时重算；金额真源仍是 payload，不可在此修改） */}
      <AmountSummaryBar
        docType={docType}
        data={effectiveData}
        sources={payload?.sources ?? null}
      />

      <div className="grid gap-3 p-3 sm:grid-cols-2">
        {/* 关联产品：决定"产品基础信息"能否带入本单据（后端按字段声明与空值判定） */}
        <div className="space-y-1 rounded-md border border-dashed bg-muted/20 p-2 sm:col-span-2">
          <span className="flex items-center gap-1 text-xs font-medium">
            <Package className="h-3.5 w-3.5" />
            关联产品
          </span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={productKey}
            disabled={!editable}
            onChange={(e) => setProductKey(e.target.value)}
          >
            <option value="">（不关联）</option>
            {(products.data?.items ?? []).map((p) => (
              <option key={p.product_key} value={p.product_key}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            选定后，该产品在「产品」工位维护的基础信息会自动带入本单据：目前是
            <b> HS 编码</b>
            （仅商业发票 / 原产地证 / 质量证明 /
            报关信息表，且行项该栏为空时）。
            产品档案改了，所有关联单据同步生效，不必逐张重填。
          </p>
          {products.isError && (
            <ErrorState
              title="产品列表读取失败"
              message="稍后重试即可；不影响本单其余字段的填写与保存。"
              onRetry={() => void products.refetch()}
              className="px-3 py-4"
            />
          )}
        </div>
        {fields.map((field) => (
          <FieldRow
            key={field.name}
            field={field}
            text={texts[field.name] ?? ""}
            error={errors[field.name]}
            disabled={!editable}
            onChange={(value) => setText(field.name, value)}
            clauseTemplates={
              isClauseField(field.name) ? clauseTemplates : undefined
            }
            onApplyClauseTemplate={(template) => applyTemplate(field, template)}
            clauseFillNote={fillNotes[field.name]}
            clauseTemplateHint={
              isClauseField(field.name)
                ? clauseTemplatesQuery.isLoading
                  ? "正在读取条款模板…"
                  : clauseTemplatesQuery.isError
                    ? "条款模板暂时读不到，可直接手动填写。"
                    : clauseTemplates.length === 0
                      ? "团队暂无可用模板，可直接自定义输入。"
                      : "模板为中英双语；这项内容是一段文本，按英文单证口径优先回填英文（无英文则中文）。已填内容默认不覆盖。"
                : undefined
            }
          />
        ))}
        {photosField && (
          <DocPhotoPicker
            onPick={appendPhoto}
            disabled={!editable}
            pickedIds={pickedIds}
            picked={pickedPhotos}
            onReorder={reorderPhotos}
            onRemove={removePhoto}
          />
        )}
      </div>

      {/* 覆盖确认（A5-W1 风险 1）：默认只填空字段；已填内容要覆盖必须用户点头。
          不用 window.confirm —— 需要可测、可解释（显示字段与模板名）。 */}
      <Dialog
        open={pendingOverwrite !== null}
        onOpenChange={(open) => {
          if (!open) setPendingOverwrite(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>覆盖已填内容？</DialogTitle>
            <DialogDescription>
              内容项「
              {pendingOverwrite?.field.spec.description ??
                pendingOverwrite?.field.name}
              」已有内容。用模板「{pendingOverwrite?.template.name}
              」回填会覆盖它 —— 默认只填空的内容项，请确认是否覆盖。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingOverwrite(null)}>
              取消（保留原内容）
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!pendingOverwrite) return;
                const fill = pickTemplateFill(pendingOverwrite.template);
                setText(pendingOverwrite.field.name, fill.text);
                setFillNotes((prev) => ({
                  ...prev,
                  [pendingOverwrite.field.name]: fill.note,
                }));
                toast.success(
                  `已用「${pendingOverwrite.template.name}」覆盖回填（${fill.lang === "en" ? "英文" : "中文"}）`,
                );
                setPendingOverwrite(null);
              }}
            >
              覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FieldRow({
  field,
  text,
  error,
  disabled,
  onChange,
  clauseTemplates,
  onApplyClauseTemplate,
  clauseTemplateHint,
  clauseFillNote,
}: {
  field: CustomFieldDef;
  text: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  /** 仅条款类字段传入：该单证类型可用的模板（已按 doc_type 过滤） */
  clauseTemplates?: ClauseTemplate[];
  onApplyClauseTemplate?: (template: ClauseTemplate) => void;
  clauseTemplateHint?: string;
  /** 回填后的双语说明（实际回填英文还是中文） */
  clauseFillNote?: string;
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
        </span>
        <p className="text-[11px] text-muted-foreground">
          只能来自上游订单/报价或系统计算，<b>不接受手工覆盖</b>
          （系统会自动挡住）。改了上游再「重新带入」即可。
        </p>
      </div>
    );
  }

  return (
    <label
      className={`space-y-1 ${wide ? "sm:col-span-2" : ""}`}
      data-field={name}
    >
      <span className="flex items-center gap-1 text-xs font-medium">
        {label}
        {spec.required && <span className="text-destructive">*</span>}
        <span className="text-[10px] font-normal text-muted-foreground">
          {CONTROL_LABELS[control] ?? "文本"}
        </span>
      </span>

      {/* 条款模板回填（A5-W1）：只对条款类字段出现；"自定义"仍直接用下方输入框 */}
      {isClauseField(name) && onApplyClauseTemplate && (
        <div className="space-y-1 rounded-md border border-dashed bg-muted/20 p-2">
          <select
            aria-label={`${label} 条款模板`}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value=""
            disabled={
              disabled || !clauseTemplates || clauseTemplates.length === 0
            }
            onChange={(e) => {
              const template = clauseTemplates?.find(
                (t) => String(t.id) === e.target.value,
              );
              // 受控 value="" ⇒ 选完立即回到占位项，允许再次选择同一模板
              e.target.value = "";
              if (template) onApplyClauseTemplate(template);
            }}
          >
            <option value="">
              {clauseTemplates && clauseTemplates.length > 0
                ? "选择条款模板回填…"
                : "暂无可用条款模板"}
            </option>
            {(clauseTemplates ?? []).map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.name}
              </option>
            ))}
          </select>
          {clauseTemplateHint && (
            <span className="block text-[10px] text-muted-foreground">
              {clauseTemplateHint}
            </span>
          )}
          {clauseFillNote && (
            <span
              role="note"
              className="block text-[10px] text-muted-foreground"
            >
              {clauseFillNote}
            </span>
          )}
        </div>
      )}

      {control === "json" && (
        <div className="space-y-1">
          <textarea
            className="min-h-[88px] w-full rounded-md border border-input bg-background p-2 text-xs"
            value={text}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              name === "product_photos"
                ? "从下方图库选图即可，一般不用手填"
                : "一般留空即可沿用上游带入的内容"
            }
          />
          <span className="block text-[10px] text-muted-foreground">
            需要手填多项内容时，请按系统要求的格式填写；一般留空即可。
          </span>
        </div>
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
              选择图片后会随单据一起保存，打印/导出时自动带上
            </span>
          )}
        </div>
      )}

      {(control === "text" || control === "date" || control === "number") && (
        <Input
          type={
            control === "date"
              ? "date"
              : control === "number"
                ? "number"
                : "text"
          }
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {error && (
        <span className="block text-[11px] text-destructive">{error}</span>
      )}
    </label>
  );
}
