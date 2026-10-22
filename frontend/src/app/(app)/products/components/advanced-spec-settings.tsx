"use client";

/**
 * 高级设置（仅平台管理员，默认折叠）。
 *
 * 普通成员看不到这个组件：调用方按 isSystemAdmin 决定是否渲染。
 * 能力与旧版完全一致（ProductSpecEditor 原样保留），只是收进折叠区，
 * 这样底层公式/列/校验仍可维护，又不会吓到业务同事。
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";

import { ProductSpecEditor } from "./product-spec-editor";
import type { ProductSpec } from "@/lib/products/tenant-products";

export function AdvancedSpecSettings({
  spec,
  productKey,
  onChange,
}: {
  spec: ProductSpec;
  productKey: string;
  onChange: (next: ProductSpec) => void;
}) {
  const [json, setJson] = useState(() => JSON.stringify(spec, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const handleJson = (next: string) => {
    setJson(next);
    try {
      const parsed = JSON.parse(next) as ProductSpec;
      setError(null);
      onChange(parsed);
    } catch {
      setError("内容格式有误：请检查括号、逗号和引号；修正前保存会被阻止。");
    }
  };

  return (
    <details
      className="rounded-xl border border-dashed"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium">
        <ChevronDown
          className={"size-4 transition-transform " + (open ? "rotate-180" : "")}
          aria-hidden="true"
        />
        高级设置（仅平台管理员）
        <span className="text-xs font-normal text-muted-foreground">
          计算规则 / 底层结构；日常配置不需要打开
        </span>
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          修改这里会影响报价计算结果。看不懂的项请保持原样；改完先保存，再用报价试算核对。
        </p>
        <ProductSpecEditor
          specJson={error ? json : JSON.stringify(spec, null, 2)}
          onChange={handleJson}
          productKey={productKey}
        />
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
