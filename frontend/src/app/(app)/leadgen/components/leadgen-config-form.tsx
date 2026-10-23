"use client";

/**
 * 抓取配置表单（从 page.tsx 拆出，行为/文案/DOM 结构不变）。
 * 受控组件：状态仍归页面（配置同时被「校验 / 开始抓取」两条动作读取）。
 *
 * FormField 收编（P0-C）：原先是 placeholder 当 label（输入后即丢失字段名），
 * 现在每个字段有真实 <label for>（点标签可聚焦），校验错误以 aria-describedby +
 * aria-invalid 挂到对应控件上（仅当错误确实属于该字段时）。
 */
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/shared/form-field";

import type { LeadgenConfig } from "../lib/types";

export function LeadgenConfigFields({
  cfg,
  regions,
  onChange,
  onQuantityChange,
  industryError = null,
}: {
  cfg: LeadgenConfig;
  regions: string[];
  onChange: (patch: Partial<LeadgenConfig>) => void;
  onQuantityChange: (value: string) => void;
  /** 与「行业关键词」相关的校验问题（由页面从 /leadgen/validate 的 issues 里挑出） */
  industryError?: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <FormField label="数据源" htmlFor="leadgen-source">
        <select
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={cfg.source}
          onChange={(e) => onChange({ source: e.target.value })}
        >
          <option value="demo">演示数据源</option>
          <option value="csv">CSV 导入</option>
        </select>
      </FormField>
      <FormField label="地区" htmlFor="leadgen-region">
        <select
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={cfg.region}
          onChange={(e) => onChange({ region: e.target.value })}
        >
          <option value="">全部地区</option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="行业关键词"
        required
        htmlFor="leadgen-industry"
        error={industryError}
      >
        <Input
          placeholder="如：fence / 围栏"
          value={cfg.industry}
          onChange={(e) => onChange({ industry: e.target.value })}
        />
      </FormField>
      <FormField label="ICP 备注" htmlFor="leadgen-icp">
        <Input
          placeholder="可选：目标客户特征"
          value={cfg.icp}
          onChange={(e) => onChange({ icp: e.target.value })}
        />
      </FormField>
      <FormField label="抓取数量" htmlFor="leadgen-quantity">
        <Input
          type="number"
          min={1}
          value={cfg.quantity}
          onChange={(e) => onQuantityChange(e.target.value)}
        />
      </FormField>
    </div>
  );
}
