"use client";

/**
 * 手工新增情报货运（C36 #16）。
 *
 * 契约：`POST /api/v1/intel/shipments`（JSON，`ShipmentCreate`）；必填
 * shipper/consignee/product_desc；`ship_date` 是 datetime（date input → 补 T00:00:00）。
 * 字段多，按 `SHIPMENT_FIELD_GROUPS` 分组；后端 422 的字段级错误直接显示在表单上方。
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
  SHIPMENT_FIELD_GROUPS,
  emptyShipmentDraft,
  formatShipmentError,
  validateShipmentDraft,
  type ShipmentDraft,
} from "@/lib/intel/shipment-form";

export function ManualShipmentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ShipmentDraft>(emptyShipmentDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const setField = (key: keyof ShipmentDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const submit = async () => {
    const checked = validateShipmentDraft(draft);
    setErrors(checked.errors);
    if (!checked.ok) return;
    setPending(true);
    setError(null);
    try {
      const { data } = await apiClient.post<Record<string, unknown>>(
        "/intel/shipments",
        checked.payload,
        { silent: true },
      );
      toast.success(
        `已新增货运记录 #${String((data as { id?: unknown }).id ?? "")}`,
      );
      qc.invalidateQueries({ queryKey: ["intel", "shipments"] });
      setDraft(emptyShipmentDraft());
      onOpenChange(false);
    } catch (err) {
      setError(formatShipmentError(err));
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
          <DialogTitle>手工新增情报货运</DialogTitle>
          <DialogDescription>
            用于少量补录（CSV 批量导入更省事）。必填发货人/收货人/产品描述；成功后可在「货运记录」查到。
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="space-y-4">
          {SHIPMENT_FIELD_GROUPS.map((group) => (
            <fieldset key={group.title} className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">
                {group.title}
              </legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <label key={field.key} className="space-y-1 text-xs">
                    <span>
                      {field.label}
                      {field.required ? (
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
                    ) : (
                      <Input
                        name={field.key}
                        type={
                          field.control === "date"
                            ? "date"
                            : field.control === "number"
                              ? "number"
                              : "text"
                        }
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
            {pending ? "保存中…" : "保存货运记录"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
