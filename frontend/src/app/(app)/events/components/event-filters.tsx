"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EventFilters as EventFiltersType } from "../hooks/use-events";
import { Search, X } from "lucide-react";

const EVENT_TYPES = [
  "audit.access",
  "capability.update",
  "chat.turn",
  "kb.edit",
  "quote.request",
  "quote.response",
];

interface Props {
  filters: EventFiltersType;
  onChange: (filters: EventFiltersType) => void;
}

export function EventFilters({ filters, onChange }: Props) {
  const set = (key: keyof EventFiltersType, value: string | undefined) => {
    onChange({ ...filters, [key]: value || undefined });
  };

  const clear = () => {
    onChange({});
  };

  const hasFilters = Object.values(filters).some((v) => v !== undefined);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="租户 ID"
        value={filters.tenant_id ?? ""}
        onChange={(e) => set("tenant_id", e.target.value)}
        className="w-full sm:w-36"
      />

      <Select
        value={filters.event_type ?? "all"}
        onValueChange={(v) =>
          set("event_type", v === "all" || !v ? undefined : v)
        }
      >
        <SelectTrigger className="w-full sm:w-40">
          <SelectValue placeholder="事件类型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部类型</SelectItem>
          {EVENT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        placeholder="操作人"
        value={filters.actor_id ?? ""}
        onChange={(e) => set("actor_id", e.target.value)}
        className="w-full sm:w-32"
      />

      <Select
        value={filters.event_source ?? "all"}
        onValueChange={(v) =>
          set("event_source", v === "all" || !v ? undefined : v)
        }
      >
        <SelectTrigger className="w-full sm:w-32">
          <SelectValue placeholder="来源" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部来源</SelectItem>
          <SelectItem value="frontend">前端</SelectItem>
          <SelectItem value="backend">后端</SelectItem>
        </SelectContent>
      </Select>

      <Button variant="ghost" size="sm" onClick={clear}>
        <Search className="mr-1 size-3" />
        搜索
      </Button>

      {hasFilters && (
        <Button variant="ghost" size="icon-sm" onClick={clear}>
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
