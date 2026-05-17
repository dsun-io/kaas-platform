"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, CheckCircle } from "lucide-react";
import { useBindings } from "../hooks/use-bindings";
import { useWizardSubmit } from "../hooks/use-wizard-submit";
import { DynamicSpecForm } from "./DynamicSpecForm";
import { PricingGroupForm, type PricingFormValue } from "./PricingGroupForm";
import { AttributeProposeDialog } from "./AttributeProposeDialog";
import type { BindingWithAttribute } from "@contracts/spec-system";

interface Props {
  categoryId: number;
  categoryName: string;
}

const GROUP_CONFIG = [
  { code: "identity", label: "产品标识", step: 1 },
  { code: "variant", label: "变体属性", step: 2 },
  { code: "spec", label: "规格属性", step: 3 },
] as const;

export function QuoteWizard({ categoryId, categoryName }: Props) {
  const { data: bindings, isLoading } = useBindings(categoryId);
  const submitMutation = useWizardSubmit();

  const [currentStep, setCurrentStep] = useState(1);
  const [specValues, setSpecValues] = useState<
    Record<
      string,
      Record<number, { value: unknown; value_code?: string | null }>
    >
  >({});
  const [pricing, setPricing] = useState<PricingFormValue>({
    price: "",
    price_unit: "cny_per_m",
    effective_from: new Date().toISOString().slice(0, 10),
    effective_to: "",
    min_qty: "",
    note: "",
    change_reason: "",
  });
  const [weightKg, setWeightKg] = useState<number | "">("");
  const [description, setDescription] = useState("");
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeGroup, setProposeGroup] = useState("spec");
  const [result, setResult] = useState<{
    sku_id: number;
    spec_hash: string;
  } | null>(null);

  const totalSteps = 5; // G1 identity + G2 variant + G3 spec + G4 pricing + G5 confirm

  const activeGroups = useMemo(() => {
    if (!bindings) return [];
    const codes = new Set(bindings.map((b) => b.group_code));
    return GROUP_CONFIG.filter((g) => codes.has(g.code));
  }, [bindings]);

  function getGroupBindings(groupCode: string): BindingWithAttribute[] {
    return (bindings || []).filter((b) => b.group_code === groupCode);
  }

  function handleSpecChange(
    groupCode: string,
    values: Record<number, { value: unknown; value_code?: string | null }>,
  ) {
    setSpecValues((prev) => ({ ...prev, [groupCode]: values }));
  }

  function canProceed(): boolean {
    if (currentStep <= activeGroups.length) {
      const group = activeGroups[currentStep - 1];
      if (!group) return true;
      const groupBindings = getGroupBindings(group.code);
      const requiredBindings = groupBindings.filter((b) => b.is_required);
      const currentValues = specValues[group.code] || {};
      return requiredBindings.every((b) => {
        const v = currentValues[b.attribute.id];
        return v && v.value !== undefined && v.value !== "" && v.value !== null;
      });
    }
    if (currentStep === activeGroups.length + 1) {
      // pricing step
      return (
        pricing.price !== "" &&
        !!pricing.price_unit &&
        !!pricing.effective_from &&
        pricing.change_reason.length > 0
      );
    }
    return true;
  }

  async function handleSubmit() {
    if (!bindings) return;

    // Flatten all spec values
    const flatSpecValues: Record<
      string,
      { attribute_id: number; value: unknown; value_code?: string | null }
    > = {};
    for (const [groupCode, values] of Object.entries(specValues)) {
      for (const [attrId, v] of Object.entries(values)) {
        flatSpecValues[attrId] = {
          attribute_id: Number(attrId),
          value: v.value,
          value_code: v.value_code,
        };
      }
    }

    const payload = {
      category_id: categoryId,
      spec_values: flatSpecValues,
      pricing:
        pricing.price !== ""
          ? {
              price: Number(pricing.price),
              price_unit: pricing.price_unit,
              effective_from: pricing.effective_from,
              effective_to: pricing.effective_to || null,
              min_qty: pricing.min_qty !== "" ? Number(pricing.min_qty) : null,
              tier_rules: null,
              note: pricing.note || null,
              change_reason: pricing.change_reason,
            }
          : undefined,
      weight_kg: weightKg !== "" ? Number(weightKg) : undefined,
      description: description || undefined,
    };

    const data = await submitMutation.mutateAsync(payload);
    setResult({ sku_id: data.sku_id, spec_hash: data.spec_hash });
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          加载品类属性...
        </CardContent>
      </Card>
    );
  }

  if (result) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
          <CheckCircle className="h-12 w-12 text-green-500" />
          <h2 className="text-xl font-semibold">提交成功</h2>
          <p className="text-muted-foreground">SKU ID: {result.sku_id}</p>
          <p className="text-muted-foreground">规格 Hash: {result.spec_hash}</p>
          <Button
            onClick={() => {
              setResult(null);
              setCurrentStep(1);
              setSpecValues({});
            }}
          >
            继续录入
          </Button>
        </CardContent>
      </Card>
    );
  }

  const stepOffset = activeGroups.length;

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {activeGroups.map((g, i) => (
          <div key={g.code} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                currentStep > i + 1
                  ? "bg-green-500 text-white"
                  : currentStep === i + 1
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {currentStep > i + 1 ? "✓" : i + 1}
            </div>
            <span
              className={
                currentStep === i + 1 ? "font-medium" : "text-muted-foreground"
              }
            >
              {g.label}
            </span>
            {i < activeGroups.length - 1 && (
              <span className="text-muted-foreground">→</span>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center ${
              currentStep === stepOffset + 1
                ? "bg-primary text-primary-foreground"
                : currentStep > stepOffset + 1
                  ? "bg-green-500 text-white"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {currentStep > stepOffset + 1 ? "✓" : stepOffset + 1}
          </div>
          <span
            className={
              currentStep === stepOffset + 1
                ? "font-medium"
                : "text-muted-foreground"
            }
          >
            价格
          </span>
          <span className="text-muted-foreground">→</span>
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center ${
              currentStep === stepOffset + 2
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {stepOffset + 2}
          </div>
          <span
            className={
              currentStep === stepOffset + 2
                ? "font-medium"
                : "text-muted-foreground"
            }
          >
            确认
          </span>
        </div>
      </div>

      {/* Step content */}
      {currentStep <= activeGroups.length &&
        (() => {
          const group = activeGroups[currentStep - 1];
          if (!group) return null;
          return (
            <DynamicSpecForm
              bindings={bindings || []}
              groupCode={group.code}
              groupLabel={group.label}
              value={specValues[group.code] || {}}
              onChange={(v) => handleSpecChange(group.code, v)}
              onPropose={() => {
                setProposeGroup(group.code);
                setProposeOpen(true);
              }}
            />
          );
        })()}

      {currentStep === stepOffset + 1 && (
        <PricingGroupForm value={pricing} onChange={setPricing} />
      )}

      {currentStep === stepOffset + 2 && (
        <Card>
          <CardContent className="py-6 space-y-4">
            <h3 className="text-lg font-semibold">确认提交</h3>
            <div className="space-y-2 text-sm">
              <p>
                <span className="font-medium">品类:</span> {categoryName}
              </p>
              {Object.entries(specValues).map(([groupCode, values]) => {
                const group = activeGroups.find((g) => g.code === groupCode);
                return (
                  <div key={groupCode}>
                    <span className="font-medium">
                      {group?.label || groupCode}:
                    </span>
                    {Object.entries(values).map(([attrId, v]) => {
                      const binding = bindings?.find(
                        (b) => b.attribute.id === Number(attrId),
                      );
                      return binding ? (
                        <span key={attrId} className="ml-2">
                          {binding.attribute.name}=
                          {String(v.value_code || v.value)}
                        </span>
                      ) : null;
                    })}
                  </div>
                );
              })}
              {pricing.price !== "" && (
                <p>
                  <span className="font-medium">价格:</span> {pricing.price}{" "}
                  {pricing.price_unit}
                  {pricing.effective_from && ` (自 ${pricing.effective_from})`}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">重量 (kg)</label>
                <input
                  type="number"
                  step="0.01"
                  className="w-full border rounded px-3 py-2 text-sm"
                  value={weightKg}
                  onChange={(e) =>
                    setWeightKg(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                  placeholder="可选"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">描述</label>
                <input
                  className="w-full border rounded px-3 py-2 text-sm"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
          disabled={currentStep === 1}
        >
          上一步
        </Button>
        {currentStep < totalSteps ? (
          <Button
            onClick={() => setCurrentStep((s) => s + 1)}
            disabled={!canProceed()}
          >
            下一步
          </Button>
        ) : (
          <Button onClick={handleSubmit} disabled={submitMutation.isPending}>
            {submitMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                提交中...
              </>
            ) : (
              "提交"
            )}
          </Button>
        )}
      </div>

      {/* Propose dialog */}
      <AttributeProposeDialog
        open={proposeOpen}
        onClose={() => setProposeOpen(false)}
        categoryId={categoryId}
        groupCode={proposeGroup}
      />
    </div>
  );
}
