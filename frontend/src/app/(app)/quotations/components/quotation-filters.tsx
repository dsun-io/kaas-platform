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
import type { QuotationFilters as Filters } from "../hooks/use-quotations";
import { Search, X } from "lucide-react";
import { ProductCategory } from "@contracts/categories";

const CATEGORIES = Object.values(ProductCategory);

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

export function QuotationFilters({ filters, onChange }: Props) {
  const set = (key: keyof Filters, value: string | undefined) => {
    onChange({ ...filters, [key]: value || undefined });
  };

  const clear = () => onChange({});
  const hasFilters = Object.values(filters).some((v) => v !== undefined);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="客户 ID"
        value={filters.customer_id ?? ""}
        onChange={(e) => set("customer_id", e.target.value)}
        className="w-full sm:w-36"
      />
      <Select
        value={filters.product_category ?? "all"}
        onValueChange={(v) =>
          set("product_category", v === "all" || !v ? undefined : v)
        }
      >
        <SelectTrigger className="w-full sm:w-32">
          <SelectValue placeholder="品类" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部品类</SelectItem>
          {CATEGORIES.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        placeholder="spec_hash"
        value={filters.spec_hash ?? ""}
        onChange={(e) => set("spec_hash", e.target.value)}
        className="w-full sm:w-40"
      />
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
