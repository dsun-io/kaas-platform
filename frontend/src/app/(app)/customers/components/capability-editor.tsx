"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";

interface SpecEntry {
  key: string;
  value: string;
}

interface Props {
  constraints: Record<string, unknown>;
  onChange: (constraints: Record<string, unknown>) => void;
  disabled?: boolean;
}

function toEntries(obj: Record<string, unknown>): SpecEntry[] {
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function fromEntries(entries: SpecEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const e of entries) {
    if (!e.key.trim()) continue;
    // Try to parse as JSON, fallback to string
    try {
      result[e.key] = JSON.parse(e.value);
    } catch {
      result[e.key] = e.value;
    }
  }
  return result;
}

export function CapabilityEditor({ constraints, onChange, disabled }: Props) {
  const [entries, setEntries] = useState<SpecEntry[]>(toEntries(constraints));

  const updateEntry = (index: number, field: "key" | "value", val: string) => {
    const next = entries.map((e, i) =>
      i === index ? { ...e, [field]: val } : e,
    );
    setEntries(next);
    onChange(fromEntries(next));
  };

  const addEntry = () => {
    setEntries([...entries, { key: "", value: "" }]);
  };

  const removeEntry = (index: number) => {
    const next = entries.filter((_, i) => i !== index);
    setEntries(next);
    onChange(fromEntries(next));
  };

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            placeholder="参数名"
            value={entry.key}
            onChange={(e) => updateEntry(i, "key", e.target.value)}
            disabled={disabled}
            className="w-32 h-7 text-xs"
          />
          <Input
            placeholder="参数值"
            value={entry.value}
            onChange={(e) => updateEntry(i, "value", e.target.value)}
            disabled={disabled}
            className="flex-1 h-7 text-xs"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            onClick={() => removeEntry(i)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      {!disabled && (
        <Button
          variant="ghost"
          size="sm"
          onClick={addEntry}
          className="text-xs"
        >
          <Plus className="mr-1 size-3" />
          添加参数
        </Button>
      )}
    </div>
  );
}
