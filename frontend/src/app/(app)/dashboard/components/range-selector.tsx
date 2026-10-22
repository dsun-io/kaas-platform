"use client";

import { Button } from "@/components/ui/button";
import { DASHBOARD_RANGES } from "@/lib/dashboard/funnel";

interface Props {
  value: string;
  onChange: (range: string) => void;
}

export function RangeSelector({ value, onChange }: Props) {
  return (
    // a11y（C26/A9）：几个按钮只能选一个 ⇒ 语义是**单选组**，用 radiogroup/aria-checked，
    // 不是互斥的 aria-pressed 切换按钮（后者语义是"可独立开关的按钮"）。
    // 选择理由：同一时刻恰有一个范围生效；读屏会播报「x / 4，已选中」。
    // 取值范围与内核 `main.py:dashboard_funnel` 的 since_map 同源（DASHBOARD_RANGES）。
    <div
      role="radiogroup"
      aria-label="时间范围"
      className="inline-flex rounded-lg border p-0.5"
    >
      {DASHBOARD_RANGES.map((range) => {
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
