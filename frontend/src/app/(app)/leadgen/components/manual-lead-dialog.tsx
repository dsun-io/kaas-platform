"use client";

/**
 * 手工新建线索（C36 #18，展会/老客户等非抓取来源）。
 *
 * 契约：`POST /api/v1/leads`（`LeadCreate`），只有 `company_name` 必填。
 * 后端会做两件用户能撞到的事：① 未开通 leadgen 工位 → 404 WORKSTATION_NOT_SUBSCRIBED；
 * ② 同一公司（place_id 不传时按公司名 hash）已存在 → 409 DUPLICATE_PLACE。
 * 两者都由 `formatManualLeadError` 翻成人话显示，不吞成"请求失败"。
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import apiClient from "@/lib/api/client";
import {
  LEAD_FIELD_GROUPS,
  emptyLeadDraft,
  formatManualLeadError,
  validateManualLeadDraft,
  type LeadDraft,
} from "@/lib/leadgen/manual-lead";

export function ManualLeadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<LeadDraft>(emptyLeadDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const setField = (key: keyof LeadDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const submit = async () => {
    const checked = validateManualLeadDraft(draft);
    setErrors(checked.errors);
    if (!checked.ok) return;
    setPending(true);
    setError(null);
    try {
      const { data } = await apiClient.post<Record<string, unknown>>(
        "/leads",
        checked.payload,
        { silent: true },
      );
      toast.success(
        `已新建线索：${String((data as { company_name?: unknown }).company_name ?? draft.company_name)}`,
      );
      qc.invalidateQueries({ queryKey: ["leads"] });
      setDraft(emptyLeadDraft());
      onOpenChange(false);
    } catch (err) {
      setError(formatManualLeadError(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setErrors({});
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建线索</DialogTitle>
          <DialogDescription>
            手工来源（展会/老客户等）。只有公司名称必填；同一公司重复新建会被后端 409
            拦截。
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="space-y-4">
          {LEAD_FIELD_GROUPS.map((group) => (
            <fieldset key={group.title} className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">
                {group.title}
              </legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <label key={field.key} className="space-y-1 text-xs">
                    <span>
                      {field.label}
                      {field.key === "company_name" ? (
                        <span className="ml-0.5 text-destructive">*</span>
                      ) : null}
                    </span>
                    {field.control === "textarea" ? (
                      <Textarea
                        name={field.key}
                        value={draft[field.key] ?? ""}
                        placeholder={field.placeholder}
                        onChange={(e) => setField(field.key, e.target.value)}
                        rows={2}
                      />
                    ) : field.control === "select" ? (
                      <select
                        name="can_supply"
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        value={draft.can_supply ?? ""}
                        onChange={(e) => setField("can_supply", e.target.value)}
                      >
                        <option value="">未填</option>
                        <option value="yes">是</option>
                        <option value="no">否</option>
                      </select>
                    ) : (
                      <Input
                        name={field.key}
                        value={draft[field.key] ?? ""}
                        placeholder={field.placeholder}
                        aria-invalid={Boolean(errors[field.key])}
                        onChange={(e) => setField(field.key, e.target.value)}
                      />
                    )}
                    {errors[field.key] ? (
                      <span className="text-destructive">{errors[field.key]}</span>
                    ) : null}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={pending}>
            {pending ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Plus className="mr-1 size-4" />
            )}
            {pending ? "保存中…" : "保存线索"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
