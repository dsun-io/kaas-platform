"use client";

/**
 * 产品规格可视化编辑器（P16 · 第一步 S6.1）。
 *
 * 三段式（与 docs/archive/2026-10-20-closeout/PRODUCT_MODULE_MERGE_PLAN.md §5 对齐）：
 *   S6.1 = 数值参数（`numeric_inputs`）+ 变体档位（`variants`）+ 派生公式（`derived`）
 *   S6.2 = 列（`columns`）+ 不变量（`invariants`）+ 空间扣减（`space_deduction`）
 *   S6.3 = 参考参数（`params`）+ 说明（`notes`）+ 常量（`constants`）+ 公式试算
 *
 * **三条硬约束**（同一文档）：
 * 1. 不按 `Axis` 设计控件（三产品 `axes=[]`，画了也没人用）；
 * 2. 不新建接口 —— 保存仍走 `/tenant-products`，试算走 `/explain` 的 `spec_override`；
 * 3. **JSON 文本框原样保留为「高级 JSON」模式**（P14 硬约束①）：
 *    `specJson` 是唯一真源，表单编辑生成新 JSON 写回、JSON 手改反向喂表单
 *    —— 两条路径永远看到同一份数据，任何一侧都能兜住另一侧的失误。
 *
 * U-P1D2 拆分：本文件只留**页签状态 + 编排**；类型/纯函数见 `spec-editor/types.ts`，
 * 状态与回调见 `spec-editor/use-spec-editor-model.ts`，各页签见 `spec-editor/*-tab.tsx`。
 */
import { useState } from "react";

import { cn } from "@/lib/utils";

import { DerivedTab } from "./spec-editor/derived-tab";
import { JsonTab } from "./spec-editor/json-tab";
import { MetaTab } from "./spec-editor/meta-tab";
import { ReportTab } from "./spec-editor/report-tab";
import { SpecsTab } from "./spec-editor/specs-tab";
import { useSpecEditorModel } from "./spec-editor/use-spec-editor-model";
import type { EditorTab, ProductSpecEditorProps } from "./spec-editor/types";

const TABS: readonly { key: EditorTab; label: string }[] = [
  { key: "specs", label: "数值参数 / 变体档位" },
  { key: "derived", label: "派生公式" },
  { key: "report", label: "列 / 校验 / 扣减" },
  { key: "meta", label: "参数 / 说明 / 常量" },
  { key: "json", label: "高级 JSON" },
];

export function ProductSpecEditor({
  specJson,
  onChange,
  productKey,
}: ProductSpecEditorProps) {
  const [tab, setTab] = useState<EditorTab>("specs");
  const model = useSpecEditorModel({ specJson, onChange });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border p-0.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              tab === t.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!model.parseOk && (
        <p className="text-xs text-destructive">
          当前 JSON 无法解析（语法错误），表单已锁定 —— 请在「高级
          JSON」里修正。
        </p>
      )}

      {/* JSON 语法错时锁定表单 —— 防止表单编辑把坏 JSON 覆盖成另一份数据 */}
      {model.parseOk && tab === "specs" && (
        <SpecsTab model={model} productKey={productKey} />
      )}
      {model.parseOk && tab === "derived" && (
        <DerivedTab model={model} productKey={productKey} />
      )}
      {model.parseOk && tab === "report" && <ReportTab model={model} />}
      {model.parseOk && tab === "meta" && <MetaTab model={model} />}
      {tab === "json" && (
        <JsonTab
          specJson={specJson}
          onChange={onChange}
          parseOk={model.parseOk}
        />
      )}
    </div>
  );
}
