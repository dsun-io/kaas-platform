"use client";

/**
 * 品名对照编辑弹窗（B2）。
 *
 * 为什么做成 Dialog 而不是行内编辑：对照表每行有唯一键（类目 + 地区 + 语言）与
 * 别名/HS 等旁路字段，行内编辑会把"保存失败 409"渲染到表格里、还会被列表重取冲掉。
 * 弹窗内独立持有草稿：失败时保留输入、可原样重试（`role="alert"` 展示后端原因）。
 *
 * 契约：`PATCH /market/name-mappings/{id}`（部分字段）；唯一冲突 409、不存在 404。
 * 本组件只做「预填 → 本地校验 → 提交」；请求与错误归一化在父组件（同一套 `useAsyncAction`）。
 */
import { useState } from "react";

import { AsyncButton } from "@/components/shared";
import { FormField } from "@/components/shared/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  buildNameMappingPatch,
  toNameMappingEditDraft,
  validateNameMappingEditDraft,
  type NameMappingEditDraft,
  type NameMappingPatch,
  type NameMappingRow,
} from "@/lib/market/name-mapping";

/** 常见语言；行里是其他语言（种子数据有 de）时原样保留并追加选项，不能悄悄改成 en。 */
const KNOWN_LANGS = [
  { value: "zh", label: "中文（zh）" },
  { value: "en", label: "英文（en）" },
];

function langOptions(current: string) {
  if (KNOWN_LANGS.some((l) => l.value === current)) return KNOWN_LANGS;
  return [...KNOWN_LANGS, { value: current, label: `其他（${current}）` }];
}

export interface NameMappingEditDialogProps {
  /** 打开时的那一行（快照；列表后续刷新不影响已打开的表单） */
  row: NameMappingRow;
  /** 地区下拉候选（`GET /market/regions`） */
  regions: readonly string[];
  pending: boolean;
  /** 后端失败原文（已 normalize），弹窗内 `role="alert"` 展示 */
  error: string | null;
  onSubmit: (patch: NameMappingPatch) => void;
  onClose: () => void;
}

export function NameMappingEditDialog({
  row,
  regions,
  pending,
  error,
  onSubmit,
  onClose,
}: NameMappingEditDialogProps) {
  const [draft, setDraft] = useState<NameMappingEditDraft>(() =>
    toNameMappingEditDraft(row),
  );
  const [errors, setErrors] = useState<string[]>([]);

  const field = <K extends keyof NameMappingEditDraft>(
    key: K,
    value: NameMappingEditDraft[K],
  ) => setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    const localErrors = validateNameMappingEditDraft(draft);
    setErrors(localErrors);
    if (localErrors.length > 0) return;
    onSubmit(buildNameMappingPatch(draft));
  };

  const regionOptions = Array.from(
    new Set([...regions, draft.regionCode].filter(Boolean)),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑品名对照</DialogTitle>
          <DialogDescription>
            修改后立即保存；唯一键是「类目 + 地区 + 语言」，重复会返回 409。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormField
            label="品名（local_name）"
            htmlFor="name-mapping-edit-local-name"
            required
          >
            <Input
              id="name-mapping-edit-local-name"
              value={draft.localName}
              onChange={(e) => field("localName", e.target.value)}
            />
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="语言（lang）"
              htmlFor="name-mapping-edit-lang"
              required
            >
              <select
                id="name-mapping-edit-lang"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={draft.lang}
                onChange={(e) => field("lang", e.target.value)}
              >
                {langOptions(draft.lang).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField
              label="地区（region_code）"
              htmlFor="name-mapping-edit-region"
              required
            >
              <select
                id="name-mapping-edit-region"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={draft.regionCode}
                onChange={(e) => field("regionCode", e.target.value)}
              >
                {regionOptions.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <FormField
            label="HS 编码（hs_code，可选）"
            htmlFor="name-mapping-edit-hs-code"
          >
            <Input
              id="name-mapping-edit-hs-code"
              value={draft.hsCode}
              placeholder="例如：7314.41"
              onChange={(e) => field("hsCode", e.target.value)}
            />
          </FormField>

          <div className="flex items-center gap-2">
            <input
              id="name-mapping-edit-verified"
              type="checkbox"
              className="size-4 rounded border"
              checked={draft.isVerified}
              onChange={(e) => field("isVerified", e.target.checked)}
            />
            <Label htmlFor="name-mapping-edit-verified">
              已核实（is_verified）
            </Label>
          </div>

          {errors.length > 0 && (
            <ul
              role="alert"
              className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              保存失败：{error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <AsyncButton
            pending={pending}
            pendingLabel="保存中…"
            onClick={submit}
          >
            保存
          </AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
