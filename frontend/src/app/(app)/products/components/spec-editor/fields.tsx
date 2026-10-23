"use client";

/**
 * 规格编辑器 · 通用小输入（U-P1D2 拆出）。
 *
 * 口径：数值输入**留空 = null**（避免把 0 误当成用户填的值），文本输入原样回传。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** 数值字段的通用输入（"留空 = null"，避免把 0 误当成用户填的值） */
export function NumberField({
  label,
  value,
  step,
  onChange,
  className,
}: {
  label: string;
  value: number | null | undefined;
  step?: string;
  onChange: (v: number | null) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === "" ? null : Number(raw));
        }}
        className="h-7 text-xs"
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  className,
  placeholder,
  mono,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className={className}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("h-7 text-xs", mono && "font-mono")}
      />
    </div>
  );
}
