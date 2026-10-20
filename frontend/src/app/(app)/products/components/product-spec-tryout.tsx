"use client";

/**
 * 公式试算（P16 · S6.3-b）—— 用 `/explain` 的 `spec_override` 做草稿定义的
 * 「逐步代入计算逻辑」自证。
 *
 * 为什么必须做（docs/archive/2026-10-20-closeout/PRODUCT_MODULE_MERGE_PLAN.md §5）：
 * `spec_from_dict` 的 422 闸门**不校验 `expr`** —— 公式写错（`d**2.1`、
 * 变量名笔误）要到算价时才炸，且报的是引擎内部错误，业务看不懂。
 * 试算把「这组取值下每一步怎么算」当场展示，公式写错立刻看到。
 *
 * 硬约束：
 * - **不新建接口** —— 走 `POST /export-quote/products/{key}/explain`
 *   （body 带 `spec_override`，草稿定义，不落库、不影响线上产品）；
 * - 试算的取值来自 `numeric_inputs` + `variants` 的默认/手填值。
 */
import { useMemo, useState } from "react";
import { Calculator, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";

interface NumericInputLike {
  key: string;
  label?: string;
  default?: number | null;
}

interface VariantGroupLike {
  name: string;
  label?: string;
  options: Array<{ name?: string }>;
}

interface DerivedLike {
  name: string;
  expr: string;
  unit?: string;
  label?: string;
}

export interface SpecSnapshot {
  key?: string;
  numeric_inputs?: NumericInputLike[];
  variants?: VariantGroupLike[];
  derived?: DerivedLike[];
  [k: string]: unknown;
}

interface ExplainStep {
  code?: string;
  name?: string;
  expr?: string;
  value?: number | string | null;
  unit?: string;
  label?: string;
  note?: string;
  error?: string;
}

interface ExplainResult {
  product_key?: string;
  product_name?: string;
  steps?: ExplainStep[];
  ok?: boolean;
  errors?: Array<{ code?: string; error?: string }>;
  warnings?: string[];
}

interface ProductSpecTryoutProps {
  /** 产品 key（URL 参数；新建未填 key 时禁用试算） */
  productKey: string;
  /** 当前编辑器里的草稿 spec（作为 spec_override 发出） */
  spec: SpecSnapshot | null;
}

export function ProductSpecTryout({
  productKey,
  spec,
}: ProductSpecTryoutProps) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [variantPicks, setVariantPicks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const numerics = useMemo(() => spec?.numeric_inputs ?? [], [spec]);
  const variants = useMemo(() => spec?.variants ?? [], [spec]);
  const derived = useMemo(() => spec?.derived ?? [], [spec]);

  const reset = () => {
    setResult(null);
    setError(null);
  };

  const run = async () => {
    if (!spec) return;
    setLoading(true);
    setResult(null);
    setError(null);
    const picked: Record<string, unknown> = {};
    for (const n of numerics) {
      const raw = values[n.key] ?? "";
      if (raw === "") {
        if (n.default != null) picked[n.key] = n.default;
        continue;
      }
      picked[n.key] = Number(raw);
    }
    for (const v of variants) {
      const want = variantPicks[v.name] ?? v.options[0]?.name;
      if (want) picked[v.name] = want;
    }
    try {
      const { data } = await apiClient.post<ExplainResult>(
        `/export-quote/products/${encodeURIComponent(productKey)}/explain`,
        { spec: picked, spec_override: spec },
      );
      setResult(data);
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message;
      setError(detail ?? "试算失败，请检查公式或取值");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1"
        disabled={!productKey}
        title={productKey ? undefined : "先填产品 Key 才能试算"}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Calculator className="size-3" />
        公式试算
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>公式试算（草稿定义，不落库）</DialogTitle>
            <DialogDescription>
              用当前编辑器里的公式逐步代入计算 —— 公式写错会在这里当场暴露，
              不会等到算价时才炸。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {numerics.map((n) => (
                <div key={n.key}>
                  <Label className="text-[11px] text-muted-foreground">
                    {n.label || n.key}
                  </Label>
                  <Input
                    type="number"
                    value={values[n.key] ?? ""}
                    placeholder={n.default != null ? String(n.default) : "取值"}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [n.key]: e.target.value,
                      }))
                    }
                    className="h-7 text-xs"
                  />
                </div>
              ))}
            </div>

            {variants.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {variants.map((v) => (
                  <div key={v.name}>
                    <Label className="text-[11px] text-muted-foreground">
                      {v.label || v.name}
                    </Label>
                    <select
                      value={variantPicks[v.name] ?? v.options[0]?.name ?? ""}
                      onChange={(e) =>
                        setVariantPicks((prev) => ({
                          ...prev,
                          [v.name]: e.target.value,
                        }))
                      }
                      className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
                    >
                      {v.options.map((o, i) => (
                        <option key={i} value={o.name ?? ""}>
                          {o.name ?? "(未命名)"}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={run}
                disabled={loading || numerics.length + variants.length === 0}
              >
                {loading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Calculator className="size-3" />
                )}
                {loading ? "试算中…" : "开始试算"}
              </Button>
              {derived.length === 0 && (
                <p className="self-center text-xs text-muted-foreground">
                  当前草稿里还没有派生公式 —— 先在「派生公式」tab 加公式。
                </p>
              )}
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            {result && (
              <div className="space-y-2">
                {result.warnings?.map((w, i) => (
                  <p key={i} className="text-[11px] text-muted-foreground">
                    {w}
                  </p>
                ))}
                {result.ok === false && (
                  <p className="text-xs text-destructive">
                    试算失败（{result.errors?.length ?? 0} 处错误）——
                    逐条看下面：
                  </p>
                )}
                <div className="max-h-72 overflow-y-auto rounded border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th scope="col" className="p-2">
                          指标
                        </th>
                        <th scope="col" className="p-2">
                          公式
                        </th>
                        <th scope="col" className="p-2">
                          结果
                        </th>
                        <th scope="col" className="p-2">
                          单位
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(result.steps ?? []).map((s, i) => (
                        <tr
                          key={i}
                          className={`border-b last:border-0 ${
                            s.error ? "bg-destructive/5" : ""
                          }`}
                        >
                          <td className="p-2">
                            {s.label || s.name || s.code || `#${i + 1}`}
                          </td>
                          <td className="p-2 font-mono text-[11px]">
                            {s.expr ?? ""}
                          </td>
                          <td className="p-2">
                            {s.error ? (
                              <span className="text-destructive">
                                {s.error}
                              </span>
                            ) : (
                              String(s.value ?? "")
                            )}
                          </td>
                          <td className="p-2">{s.unit ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
