"use client";

/**
 * 规格编辑器 · 状态与全部变更回调（U-P1D2 拆出）。
 *
 * `specJson` 仍是**唯一真源**（P14）：表单每次改动 → 生成新 JSON 写回 onChange；
 * 各页签组件只拿自己需要的字段（见 SpecEditorModel），不再直接碰 spec 对象。
 */
import { useMemo } from "react";

import {
  EMPTY_COLUMN,
  EMPTY_DERIVED,
  EMPTY_INVARIANT,
  EMPTY_NUMERIC,
  EMPTY_SPACE_DEDUCTION,
  EMPTY_VARIANT,
  parseSpec,
  stringifySpec,
  type ColumnItem,
  type DerivedItem,
  type InvariantItem,
  type NumericInputItem,
  type ParamRow,
  type SpaceDeductionItem,
  type SpecShape,
  type VariantGroupItem,
} from "./types";

export interface UseSpecEditorModelArgs {
  /** P14 保留的真源 JSON 文本（stringify 出来的） */
  specJson: string;
  onChange: (next: string) => void;
}

export interface SpecEditorModel {
  spec: SpecShape | null;
  parseOk: boolean;
  commit: (next: SpecShape) => void;
  numerics: NumericInputItem[];
  patchNumeric: (index: number, patch: Partial<NumericInputItem>) => void;
  addNumeric: () => void;
  removeNumeric: (index: number) => void;
  variants: VariantGroupItem[];
  patchVariant: (index: number, patch: Partial<VariantGroupItem>) => void;
  addVariant: () => void;
  removeVariant: (index: number) => void;
  derived: DerivedItem[];
  patchDerived: (index: number, patch: Partial<DerivedItem>) => void;
  addDerived: () => void;
  removeDerived: (index: number) => void;
  columns: ColumnItem[];
  patchColumn: (index: number, patch: Partial<ColumnItem>) => void;
  addColumn: () => void;
  removeColumn: (index: number) => void;
  invariants: InvariantItem[];
  patchInvariant: (index: number, patch: Partial<InvariantItem>) => void;
  addInvariant: () => void;
  removeInvariant: (index: number) => void;
  spaceDeduction: SpaceDeductionItem | undefined;
  patchSpaceDeduction: (patch: Partial<SpaceDeductionItem>) => void;
  params: ParamRow[];
  patchParam: (index: number, col: 0 | 1 | 2 | 3, value: string) => void;
  addParam: () => void;
  removeParam: (index: number) => void;
  notes: string[];
  patchNote: (index: number, text: string) => void;
  addNote: () => void;
  removeNote: (index: number) => void;
  constants: Record<string, number | string>;
  constantEntries: [string, number | string][];
  patchConstant: (key: string, value: string) => void;
  removeConstant: (key: string) => void;
}

export function useSpecEditorModel({
  specJson,
  onChange,
}: UseSpecEditorModelArgs): SpecEditorModel {
  // 表单与 JSON 同步：specJson 是唯一真源（P14 约束）
  const spec = useMemo(() => parseSpec(specJson), [specJson]);
  const parseOk = spec !== null;

  // 表单改动 → 生成新 JSON 写回 specJson（不引入"未应用的草稿"——
  // 那会让人改完 JSON 忘点应用，保存时把改动静默丢掉）。
  const commit = (next: SpecShape) => {
    onChange(stringifySpec(next));
  };

  // ── 数值参数 ──────────────────────────────────────────────────────────────
  const numerics = spec?.numeric_inputs ?? [];
  const patchNumeric = (index: number, patch: Partial<NumericInputItem>) => {
    const next = numerics.map((n, i) => (i === index ? { ...n, ...patch } : n));
    commit({ ...(spec ?? {}), numeric_inputs: next });
  };
  const addNumeric = () =>
    commit({
      ...(spec ?? {}),
      numeric_inputs: [...numerics, { ...EMPTY_NUMERIC }],
    });
  const removeNumeric = (index: number) =>
    commit({
      ...(spec ?? {}),
      numeric_inputs: numerics.filter((_, i) => i !== index),
    });

  // ── 变体档位 ──────────────────────────────────────────────────────────────
  const variants = spec?.variants ?? [];
  const patchVariant = (index: number, patch: Partial<VariantGroupItem>) => {
    const next = variants.map((v, i) => (i === index ? { ...v, ...patch } : v));
    commit({ ...(spec ?? {}), variants: next });
  };
  const addVariant = () =>
    commit({
      ...(spec ?? {}),
      variants: [...variants, { ...EMPTY_VARIANT, options: [{ name: "" }] }],
    });
  const removeVariant = (index: number) =>
    commit({
      ...(spec ?? {}),
      variants: variants.filter((_, i) => i !== index),
    });

  // ── 派生公式 ──────────────────────────────────────────────────────────────
  const derived = spec?.derived ?? [];
  const patchDerived = (index: number, patch: Partial<DerivedItem>) => {
    const next = derived.map((d, i) => (i === index ? { ...d, ...patch } : d));
    commit({ ...(spec ?? {}), derived: next });
  };
  const addDerived = () =>
    commit({ ...(spec ?? {}), derived: [...derived, { ...EMPTY_DERIVED }] });
  const removeDerived = (index: number) =>
    commit({ ...(spec ?? {}), derived: derived.filter((_, i) => i !== index) });

  // ── S6.2：报表列 / 校验规则 / 空间扣减 ───────────────────────────────────
  const columns = spec?.columns ?? [];
  const patchColumn = (index: number, patch: Partial<ColumnItem>) => {
    const next = columns.map((c, i) => (i === index ? { ...c, ...patch } : c));
    commit({ ...(spec ?? {}), columns: next });
  };
  const addColumn = () =>
    commit({ ...(spec ?? {}), columns: [...columns, { ...EMPTY_COLUMN }] });
  const removeColumn = (index: number) =>
    commit({
      ...(spec ?? {}),
      columns: columns.filter((_, i) => i !== index),
    });

  const invariants = spec?.invariants ?? [];
  const patchInvariant = (index: number, patch: Partial<InvariantItem>) => {
    const next = invariants.map((v, i) =>
      i === index ? { ...v, ...patch } : v,
    );
    commit({ ...(spec ?? {}), invariants: next });
  };
  const addInvariant = () =>
    commit({
      ...(spec ?? {}),
      invariants: [...invariants, { ...EMPTY_INVARIANT }],
    });
  const removeInvariant = (index: number) =>
    commit({
      ...(spec ?? {}),
      invariants: invariants.filter((_, i) => i !== index),
    });

  const spaceDeduction = spec?.space_deduction;
  const patchSpaceDeduction = (patch: Partial<SpaceDeductionItem>) => {
    commit({
      ...(spec ?? {}),
      space_deduction: {
        ...(spaceDeduction ?? EMPTY_SPACE_DEDUCTION),
        ...patch,
      },
    });
  };

  // ── S6.3：params（4 元组）/ notes（行文本）/ constants（KV）──────────────
  const params = spec?.params ?? [];
  const patchParam = (index: number, col: 0 | 1 | 2 | 3, value: string) => {
    const next = params.map((row, i) => {
      if (i !== index) return row;
      const copy = [...row] as ParamRow;
      copy[col] = value;
      return copy;
    });
    commit({ ...(spec ?? {}), params: next });
  };
  const addParam = () =>
    commit({ ...(spec ?? {}), params: [...params, ["", "", "", ""]] });
  const removeParam = (index: number) =>
    commit({ ...(spec ?? {}), params: params.filter((_, i) => i !== index) });

  const notes = spec?.notes ?? [];
  const patchNote = (index: number, text: string) => {
    commit({
      ...(spec ?? {}),
      notes: notes.map((n, i) => (i === index ? text : n)),
    });
  };
  const addNote = () => commit({ ...(spec ?? {}), notes: [...notes, ""] });
  const removeNote = (index: number) =>
    commit({ ...(spec ?? {}), notes: notes.filter((_, i) => i !== index) });

  const constants = spec?.constants ?? {};
  const constantEntries = Object.entries(constants);
  const patchConstant = (key: string, value: string) => {
    commit({ ...(spec ?? {}), constants: { ...constants, [key]: value } });
  };
  const removeConstant = (key: string) => {
    const next = { ...constants };
    delete next[key];
    commit({ ...(spec ?? {}), constants: next });
  };

  return {
    spec,
    parseOk,
    commit,
    numerics,
    patchNumeric,
    addNumeric,
    removeNumeric,
    variants,
    patchVariant,
    addVariant,
    removeVariant,
    derived,
    patchDerived,
    addDerived,
    removeDerived,
    columns,
    patchColumn,
    addColumn,
    removeColumn,
    invariants,
    patchInvariant,
    addInvariant,
    removeInvariant,
    spaceDeduction,
    patchSpaceDeduction,
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
  };
}
