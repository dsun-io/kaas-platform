"use client";

/**
 * 调研产品筛选条（从 page.tsx 拆出；选项、文案、"改筛选即回第 1 页"语义不变）。
 */
import { Input } from "@/components/ui/input";

import { CAN_SUPPLY_OPTIONS } from "../lib/constants";

export function ResearchFilters({
  search,
  country,
  category,
  canSupply,
  countryOptions,
  categories,
  onSearchChange,
  onCountryChange,
  onCategoryChange,
  onCanSupplyChange,
}: {
  search: string;
  country: string;
  category: string;
  canSupply: string;
  countryOptions: string[];
  categories: string[];
  onSearchChange: (value: string) => void;
  onCountryChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onCanSupplyChange: (value: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Input
        className="w-56"
        placeholder="搜索产品 / 店铺…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <select
        className="rounded-md border bg-background px-3 py-2 text-sm"
        value={country}
        onChange={(e) => onCountryChange(e.target.value)}
      >
        <option value="">国家：全部</option>
        {countryOptions.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        className="rounded-md border bg-background px-3 py-2 text-sm"
        value={category}
        onChange={(e) => onCategoryChange(e.target.value)}
      >
        <option value="">类目：全部</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        className="rounded-md border bg-background px-3 py-2 text-sm"
        value={canSupply}
        onChange={(e) => onCanSupplyChange(e.target.value)}
      >
        {CAN_SUPPLY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
