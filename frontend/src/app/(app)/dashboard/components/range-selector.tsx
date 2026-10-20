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
    // a11y（C26/A9）：三个按钮只能选一个 ⇒ 语义是**单选组**，用 radiogroup/aria-checked，
    // 不是互斥的 aria-pressed 切换按钮（后者语义是"可独立开关的按钮"）。
    // 选择理由：同一时刻恰有一个范围生效；读屏会播报「x / 3，已选中」。
    <div
      role="radiogroup"
      aria-label="时间范围"
      className="inline-flex rounded-lg border p-0.5"
    >
      {RANGES.map((range) => {
        const checked = value === range.value;
        return (
          <Button
            key={range.value}
            role="radio"
            aria-checked={checked}
            variant={checked ? "default" : "ghost"}
            size="sm"
            onClick={() => onChange(range.value)}
            className="h-7 text-xs"
          >
            {range.label}
          </Button>
        );
      })}
    </div>
  );
}
