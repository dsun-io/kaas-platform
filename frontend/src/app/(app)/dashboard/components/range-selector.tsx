"use client";

import { Button } from "@/components/ui/button";

const RANGES = [
  { value: "today", label: "今日" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
] as const;

interface Props {
  value: string;
  onChange: (range: string) => void;
}

export function RangeSelector({ value, onChange }: Props) {
  return (
    <div className="inline-flex rounded-lg border p-0.5">
      {RANGES.map((range) => (
        <Button
          key={range.value}
          variant={value === range.value ? "default" : "ghost"}
          size="sm"
          onClick={() => onChange(range.value)}
          className="h-7 text-xs"
        >
          {range.label}
        </Button>
      ))}
    </div>
  );
}
