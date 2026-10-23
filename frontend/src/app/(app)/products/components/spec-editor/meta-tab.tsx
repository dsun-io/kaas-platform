"use client";

/**
 * 「参数 / 说明 / 常量」页签（U-P1D2 从 product-spec-editor 拆出）。
 *
 * S6.3 三段：参考参数（4 元组，不参与计算）、说明（逐行）、常量（KV，公式引用）。
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { TextField } from "./fields";
import type { SpecEditorModel } from "./use-spec-editor-model";

export function MetaTab({ model }: { model: SpecEditorModel }) {
  const {
    spec,
    commit,
    params,
    patchParam,
    addParam,
    removeParam,
    notes,
    patchNote,
    addNote,
    removeNote,
    constants,
    constantEntries,
    patchConstant,
    removeConstant,
  } = model;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs">参考参数（说明性参数表，不参与计算）</Label>
        <Button type="button" size="sm" variant="outline" onClick={addParam}>
          <Plus className="size-3" /> 加参数
        </Button>
      </div>
      {params.length === 0 && (
        <p className="text-xs text-muted-foreground">
          还没有参考参数 —— 「原料进货成本 / 客户每单填写 / 元/㎡」这类
          说明性的参数表放这里（只做展示与备忘）。
        </p>
      )}
      {params.map((row, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <TextField
            label="参数"
            value={row[0]}
            onChange={(v) => patchParam(index, 0, v)}
          />
          <TextField
            label="取值"
            value={row[1]}
            onChange={(v) => patchParam(index, 1, v)}
          />
          <TextField
            label="单位"
            value={row[2]}
            onChange={(v) => patchParam(index, 2, v)}
          />
          <TextField
            label="说明"
            value={row[3]}
            onChange={(v) => patchParam(index, 3, v)}
          />
          <div className="flex items-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 text-xs text-muted-foreground"
              onClick={() => removeParam(index)}
            >
              <Trash2 className="size-3" /> 删除
            </Button>
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between pt-2">
        <Label className="text-xs">说明（notes：产品口径/计算说明）</Label>
        <Button type="button" size="sm" variant="outline" onClick={addNote}>
          <Plus className="size-3" /> 加一行
        </Button>
      </div>
      {notes.length === 0 && (
        <p className="text-xs text-muted-foreground">
          还没有说明 —— 重量公式口径、装柜体积来源这类要给业务看的说明放这里。
        </p>
      )}
      {notes.map((n, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={n}
            onChange={(e) => patchNote(index, e.target.value)}
            placeholder="一行说明"
            className="h-7 text-xs"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="删除该备注"
            onClick={() => removeNote(index)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}

      <div className="flex items-center justify-between pt-2">
        <Label className="text-xs">常量（公式里用到的常数）</Label>
      </div>
      {constantEntries.length === 0 && (
        <p className="text-xs text-muted-foreground">
          还没有常量 —— 公式里的 1.28（重量经验系数）这类常数放这里，
          改值时公式自动跟着变。
        </p>
      )}
      {constantEntries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <Input
            value={k}
            readOnly
            className="h-7 w-40 font-mono text-xs"
            title="常量名（改名请在高级 JSON 里改）"
          />
          <Input
            value={String(v)}
            onChange={(e) => patchConstant(k, e.target.value)}
            className="h-7 text-xs"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="删除该常量"
            onClick={() => removeConstant(k)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <AddConstantRow
        onAdd={(key) => {
          commit({
            ...(spec ?? {}),
            constants: { ...constants, [key]: 0 },
          });
        }}
      />
    </div>
  );
}

/**
 * 新增常量行：常量名输入 + 加号。改名只允许在新增时定（避免 key 冲突静默覆盖）。
 */
function AddConstantRow({ onAdd }: { onAdd: (key: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="新常量名（如 wire_factor）"
        className="h-7 w-40 font-mono text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7"
        onClick={() => {
          const key = draft.trim();
          if (!key) return;
          onAdd(key);
          setDraft("");
        }}
      >
        <Plus className="size-3" /> 加常量
      </Button>
    </div>
  );
}
