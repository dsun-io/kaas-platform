"use client";

/**
 * 定价矩阵「改价」弹窗（C36 #11）。
 *
 * 契约：`PATCH /api/v1/pricing-data/{item_id}`（`backend/worker/src/main.py:2368`）可改
 * 金额 / 单位 / 生效日期 / 备注 / 状态；**规格组合不能改**（要改组合请建新版本）。
 * 422 的 `detail` 是**字符串**（"amount must be > 0" / "unit 取值不合法" / "status 取值不合法"），
 * 404 是 "Pricing data not found" —— 两者都由调用方归一化后通过 `error` 传入，这里原样展示。
 *
 * X8：同一个弹窗兼「配置成本」（矩阵里尚未配置的行，`item_id == null`）与「改价」
 * （客户已配置的行）两种语义 —— 后端是两条端点：`POST /pricing-data` 建版本、
 * `PATCH /pricing-data/{item_id}` 就地改。配置模式只展示后端 POST 真正接收的
 * 金额/单位（生效期/备注/状态在 POST 契约里没有逐项校验，不在这里假装能改）。
 */
import { useEffect, useState } from "react";

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
import type { PricingCell } from "@contracts/export-quote";

/** 与后端 `_PRICING_UNIT_TO_COST_TYPE` 的键**逐字一致**（传别的值会 422） */
export const PRICING_UNITS = [
  "元/kg",
  "kg",
  "元/卷",
  "元/捆",
  "元/平方米",
  "元/个",
  "元/根",
] as const;

export const PRICING_STATUSES = ["active", "inactive", "deprecated"] as const;

export interface PricingCellUpdate {
  amount: number;
  unit: string;
  effective_from: string | null;
  notes: string | null;
  status: (typeof PRICING_STATUSES)[number];
}

export function PricingEditDialog({
  open,
  onOpenChange,
  cell,
  pending = false,
  error = null,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cell: PricingCell | null;
  pending?: boolean;
  error?: string | null;
  onSubmit: (values: PricingCellUpdate) => void;
}) {
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<string>("元/kg");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] =
    useState<(typeof PRICING_STATUSES)[number]>("active");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !cell) return;
    setAmount(cell.amount == null ? "" : String(cell.amount));
    setUnit(
      (PRICING_UNITS as readonly string[]).includes(cell.unit)
        ? cell.unit
        : "元/kg",
    );
    setEffectiveFrom(cell.effective_from?.slice(0, 10) ?? "");
    setNotes(cell.notes ?? "");
    setStatus("active");
    setLocalError(null);
  }, [open, cell]);

  // X8：未配置行（矩阵里没有 item_id）= 新建这份成本，走 POST；已配置 = PATCH 改价
  const isConfig = cell != null && cell.item_id == null;

  const submit = () => {
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setLocalError("金额必须是大于 0 的数字");
      return;
    }
    if (!(PRICING_UNITS as readonly string[]).includes(unit)) {
      setLocalError("单位取值不合法");
      return;
    }
    setLocalError(null);
    // 配置模式只消费 amount/unit（POST 契约）；其余字段按后端默认值填，
    // 调用方在 config 分支里不会把它们发给 PATCH。
    onSubmit({
      amount: num,
      unit,
      effective_from: isConfig ? null : effectiveFrom || null,
      notes: isConfig ? null : notes.trim() === "" ? null : notes.trim(),
      status: isConfig ? "active" : status,
    });
  };

  const shownError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isConfig ? "配置成本" : "修改定价"}</DialogTitle>
          <DialogDescription>
            {cell
              ? `${cell.labels.join(" · ")}（${
                  isConfig
                    ? "尚未配置，当前用产品兜底"
                    : `当前 ${cell.amount ?? "—"} ${cell.unit || ""}`
                }）`
              : isConfig
                ? "为这个规格组合配置成本"
                : "修改这一格的成本"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="pricing-amount">金额 *</Label>
            <Input
              id="pricing-amount"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={amount}
              disabled={pending}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pricing-unit">单位</Label>
            <select
              id="pricing-unit"
              className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={unit}
              disabled={pending}
              onChange={(e) => setUnit(e.target.value)}
            >
              {PRICING_UNITS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          {/* 配置模式（POST 建版本）只收金额/单位；生效期/备注/状态是 PATCH 才有的事 */}
          {!isConfig && (
            <>
              <div className="space-y-1">
                <Label htmlFor="pricing-effective">生效日期</Label>
                <Input
                  id="pricing-effective"
                  type="date"
                  value={effectiveFrom}
                  disabled={pending}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pricing-notes">备注</Label>
                <Input
                  id="pricing-notes"
                  value={notes}
                  disabled={pending}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="如：客户 2026-10 调价"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pricing-status">状态</Label>
                <select
                  id="pricing-status"
                  className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={status}
                  disabled={pending}
                  onChange={(e) =>
                    setStatus(
                      e.target.value as (typeof PRICING_STATUSES)[number],
                    )
                  }
                >
                  <option value="active">启用</option>
                  <option value="inactive">停用</option>
                  <option value="deprecated">弃用</option>
                </select>
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {isConfig
              ? "保存后这一行从下一张报价单起按新成本计算；规格组合不能在这里改（需新建版本）。"
              : "改价只影响金额 / 单位 / 生效期 / 备注 / 状态；规格组合不能在这里改（需新建版本）。"}
          </p>
          {shownError ? (
            <p role="alert" className="text-xs text-destructive">
              {shownError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "保存中…" : isConfig ? "保存成本" : "保存修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
