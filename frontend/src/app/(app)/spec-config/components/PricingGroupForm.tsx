"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export interface PricingFormValue {
  price: number | "";
  price_unit: string;
  effective_from: string;
  effective_to: string;
  min_qty: number | "";
  note: string;
  change_reason: string;
}

const PRICE_UNITS = [
  { value: "cny_per_pcs", label: "元/件" },
  { value: "cny_per_m", label: "元/米" },
  { value: "cny_per_m2", label: "元/平方米" },
  { value: "cny_per_kg", label: "元/kg" },
  { value: "cny_per_t", label: "元/吨" },
  { value: "cny_per_roll", label: "元/卷" },
];

interface Props {
  value: PricingFormValue;
  onChange: (v: PricingFormValue) => void;
  showPrice?: boolean;
}

export function PricingGroupForm({ value, onChange, showPrice = true }: Props) {
  function update<K extends keyof PricingFormValue>(
    key: K,
    v: PricingFormValue[K],
  ) {
    onChange({ ...value, [key]: v });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">价格信息</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {showPrice && (
            <>
              <div className="space-y-2">
                <Label>
                  价格 <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="number"
                  step="0.01"
                  value={value.price}
                  onChange={(e) =>
                    update(
                      "price",
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                  placeholder="输入价格"
                />
              </div>
              <div className="space-y-2">
                <Label>
                  价格单位 <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={value.price_unit}
                  onValueChange={(v) => v && update("price_unit", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择单位" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRICE_UNITS.map((u) => (
                      <SelectItem key={u.value} value={u.value}>
                        {u.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label>
              生效日期 <span className="text-destructive">*</span>
            </Label>
            <Input
              type="date"
              value={value.effective_from}
              onChange={(e) => update("effective_from", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>失效日期</Label>
            <Input
              type="date"
              value={value.effective_to}
              onChange={(e) => update("effective_to", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>最小订购量</Label>
            <Input
              type="number"
              value={value.min_qty}
              onChange={(e) =>
                update(
                  "min_qty",
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              placeholder="可选"
            />
          </div>
          <div className="space-y-2">
            <Label>备注</Label>
            <Input
              value={value.note}
              onChange={(e) => update("note", e.target.value)}
              placeholder="可选"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>
              变更原因 <span className="text-destructive">*</span>
            </Label>
            <Input
              value={value.change_reason}
              onChange={(e) => update("change_reason", e.target.value)}
              placeholder="请输入变更原因"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
