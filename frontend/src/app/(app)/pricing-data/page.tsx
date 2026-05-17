"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Upload, Plus, X, Loader2 } from "lucide-react";
import {
  usePricingData,
  useCreatePricingData,
  useUpdatePricingData,
  useDeletePricingData,
  type PricingEntry,
} from "./hooks/use-pricing-data";
import { PricingDataForm } from "./components/PricingDataForm";
import { PricingDataTable } from "./components/PricingDataTable";

const NO_EXPIRY = "__no_expiry__";

export default function PricingDataPage() {
  const { data: entries = [], isLoading: loadingEntries } = usePricingData();
  const createMutation = useCreatePricingData();
  const updateMutation = useUpdatePricingData();
  const deleteMutation = useDeletePricingData();

  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<PricingEntry | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const submitting = createMutation.isPending || updateMutation.isPending;

  function startEdit(entry: PricingEntry) {
    setEditingEntry(entry);
    setShowForm(true);
    setFormError(null);
  }

  function cancelForm() {
    setEditingEntry(null);
    setShowForm(false);
    setFormError(null);
  }

  async function handleSubmit(
    values: {
      product_category: string;
      product_type?: string;
      wire_diameter?: string;
      height?: string;
      mesh_width?: string;
      mesh_spec?: string;
      roll_length?: string;
      weight_kg?: string;
      cost_amount: number;
      cost_unit: string;
      effective_from?: string;
      effective_to?: string;
      notes?: string;
    },
    editingId: number | null,
  ) {
    setFormError(null);
    const payload = {
      product_category: values.product_category,
      product_type: values.product_type || undefined,
      wire_diameter: values.wire_diameter || undefined,
      height: values.height ? parseFloat(values.height) : undefined,
      mesh_width: values.mesh_width ? parseFloat(values.mesh_width) : undefined,
      mesh_spec: values.mesh_spec || undefined,
      roll_length: values.roll_length
        ? parseFloat(values.roll_length)
        : undefined,
      weight_kg: values.weight_kg ? parseFloat(values.weight_kg) : undefined,
      cost_amount: values.cost_amount,
      cost_unit: values.cost_unit,
      effective_from: values.effective_from || undefined,
      effective_to: values.effective_to || undefined,
      notes: values.notes || undefined,
    };

    try {
      if (editingId != null) {
        await updateMutation.mutateAsync({ id: editingId, payload });
      } else {
        await createMutation.mutateAsync(payload);
      }
      cancelForm();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "保存失败";
      setFormError(msg);
    }
  }

  async function handleDelete() {
    if (deleteConfirmId == null) return;
    try {
      await deleteMutation.mutateAsync(deleteConfirmId);
    } catch {
      // ignore
    } finally {
      setDeleteConfirmId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">报价数据</h1>
          <p className="text-muted-foreground mt-1">管理产品规格与成本价数据</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled
            title="即将支持 CSV / Excel 导入"
            className="gap-2"
          >
            <Upload className="size-4" />
            上传规格/报价表
          </Button>
          <Button
            onClick={() => {
              if (editingEntry) cancelForm();
              else setShowForm(!showForm);
            }}
            className="gap-2"
          >
            {editingEntry ? (
              <>
                <X className="size-4" />
                取消编辑
              </>
            ) : (
              <>
                <Plus className="size-4" />
                新增
              </>
            )}
          </Button>
        </div>
      </div>

      {showForm && (
        <PricingDataForm
          editingEntry={editingEntry}
          onSubmit={handleSubmit}
          onCancel={cancelForm}
          submitting={submitting}
          error={formError}
        />
      )}

      <PricingDataTable
        entries={entries}
        loading={loadingEntries}
        onEdit={startEdit}
        onDelete={(id) => setDeleteConfirmId(id)}
        editingId={editingEntry?.id ?? null}
      />

      {/* Delete Confirmation Dialog */}
      {deleteConfirmId != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-lg border shadow-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">确认停用</h3>
            <p className="text-sm text-muted-foreground mb-4">
              停用后该规格将在报价页中不再可选，已有报价不受影响。
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirmId(null)}
                disabled={deleteMutation.isPending}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending && (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                )}
                确认停用
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
