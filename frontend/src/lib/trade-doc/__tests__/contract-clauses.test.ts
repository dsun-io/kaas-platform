/**
 * A6-2 合同双语条款数据层单测。
 *
 * 锁三件事：
 *   1. 12 条内置条款齐全、key 唯一稳定、中英双语都非空（双语合同的基本前提）；
 *   2. 默认措辞不带真实样例的成交信息（金额/汇率/单号/地址/公司名），
 *      避免把客户商业数据写进仓库、也避免默认模板被误认为「已填好」；
 *   3. `resolveContractClauses` 的覆盖/追加/回退语义 —— 纯函数、不抛、不修改入参。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTRACT_CLAUSES,
  resolveContractClauses,
  type ContractClause,
} from "../contract-clauses";

const EXPECTED_KEYS = [
  "quality",
  "packing",
  "payment",
  "delivery",
  "documents",
  "tax",
  "price_basis",
  "inspection_claims",
  "force_majeure",
  "arbitration",
  "governing_law",
  "effectiveness_annexes",
] as const;

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

function byKey(clauses: ContractClause[], key: string): ContractClause | undefined {
  return clauses.find((clause) => clause.key === key);
}

describe("DEFAULT_CONTRACT_CLAUSES", () => {
  it("内置 12 条、顺序与合同条款顺序一致", () => {
    expect(DEFAULT_CONTRACT_CLAUSES).toHaveLength(12);
    expect(DEFAULT_CONTRACT_CLAUSES.map((clause) => clause.key)).toEqual([
      ...EXPECTED_KEYS,
    ]);
  });

  it("key 唯一且为稳定的 snake_case 标识", () => {
    const keys = DEFAULT_CONTRACT_CLAUSES.map((clause) => clause.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("每条都有中英标题与中英正文（双语合同不允许单边空白）", () => {
    for (const clause of DEFAULT_CONTRACT_CLAUSES) {
      expect(clause.label_zh.trim(), `${clause.key} label_zh`).not.toBe("");
      expect(clause.label_en.trim(), `${clause.key} label_en`).not.toBe("");
      expect(clause.text_zh.trim(), `${clause.key} text_zh`).not.toBe("");
      expect(clause.text_en.trim(), `${clause.key} text_en`).not.toBe("");
    }
  });

  it("默认措辞不含真实样例的成交信息（金额/汇率/单号/地址/公司名）", () => {
    const serialized = snapshot(DEFAULT_CONTRACT_CLAUSES);
    const sampleValues = [
      "Tim Lyons",
      "LJ-PI-20260929-01",
      "LJ-CI-20261012-01",
      "6.7029",
      "847.95",
      "1,978.54",
      "5,683.70",
      "13,261.96",
      "2026-09-28",
      "lianjiafence",
      "91131125MA0GA4242U",
      "Guangling Road",
      "江苏钧骋",
      "孙嘉泽",
    ];
    for (const value of sampleValues) {
      expect(serialized, `默认条款泄露样例值：${value}`).not.toContain(value);
    }
  });
});

describe("resolveContractClauses — 回退", () => {
  it("无入参返回内置条款的深副本（不是同一个数组/对象引用）", () => {
    const resolved = resolveContractClauses();
    expect(resolved).toEqual(DEFAULT_CONTRACT_CLAUSES);
    expect(resolved).not.toBe(DEFAULT_CONTRACT_CLAUSES);
    for (let index = 0; index < resolved.length; index += 1) {
      expect(resolved[index]).not.toBe(DEFAULT_CONTRACT_CLAUSES[index]);
    }
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["非对象", "not-an-object"],
    ["空对象", {}],
    ["数组本身", [1, 2, 3]],
    ["clauses 非数组", { clauses: "quality" }],
    ["clauses 是对象", { clauses: { key: "quality" } }],
    ["clauses 空数组", { clauses: [] }],
  ])("非法/空输入（%s）回退内置", (_label, custom) => {
    expect(resolveContractClauses(custom)).toEqual(DEFAULT_CONTRACT_CLAUSES);
  });

  it("数组里的非法条目被逐个忽略，不抛错也不产生空 key 条款", () => {
    const resolved = resolveContractClauses({
      clauses: [
        null,
        undefined,
        42,
        "quality",
        [],
        {},
        { key: "" },
        { key: "   " },
        { key: 123 },
        { key: null, text_en: "no key" },
      ],
    });
    expect(resolved).toEqual(DEFAULT_CONTRACT_CLAUSES);
    expect(resolved.every((clause) => clause.key !== "")).toBe(true);
  });
});

describe("resolveContractClauses — 覆盖", () => {
  it("按 key 覆盖已知条款：只改显式字段，其余字段与其它条款保持不变", () => {
    const resolved = resolveContractClauses({
      clauses: [
        {
          key: "quality",
          label_zh: "品质（定制）",
          text_en: "Custom quality clause.",
        },
      ],
    });

    expect(resolved).toHaveLength(12);
    const quality = byKey(resolved, "quality");
    expect(quality?.label_zh).toBe("品质（定制）");
    expect(quality?.text_en).toBe("Custom quality clause.");
    // 未给出的字段保留内置值
    expect(quality?.label_en).toBe(
      byKey(DEFAULT_CONTRACT_CLAUSES, "quality")?.label_en,
    );
    expect(quality?.text_zh).toBe(
      byKey(DEFAULT_CONTRACT_CLAUSES, "quality")?.text_zh,
    );
    // 其它条款不受影响
    expect(byKey(resolved, "packing")).toEqual(
      byKey(DEFAULT_CONTRACT_CLAUSES, "packing"),
    );
  });

  it("text_* 传空串是合法覆盖（= 隐藏该语种）", () => {
    const resolved = resolveContractClauses({
      clauses: [{ key: "packing", text_zh: "" }],
    });
    const packing = byKey(resolved, "packing");
    expect(packing?.text_zh).toBe("");
    expect(packing?.text_en).toBe(
      byKey(DEFAULT_CONTRACT_CLAUSES, "packing")?.text_en,
    );
  });

  it("同一已知 key 出现多次时后者覆盖前者（结果仍 12 条）", () => {
    const resolved = resolveContractClauses({
      clauses: [
        { key: "tax", text_en: "first" },
        { key: "tax", text_en: "second" },
      ],
    });
    expect(resolved).toHaveLength(12);
    expect(byKey(resolved, "tax")?.text_en).toBe("second");
  });

  it("key 前后空白按 trim 归一（' quality ' 覆盖 quality）", () => {
    const resolved = resolveContractClauses({
      clauses: [{ key: "  quality  ", text_en: "trimmed key override" }],
    });
    expect(resolved).toHaveLength(12);
    expect(byKey(resolved, "quality")?.text_en).toBe("trimmed key override");
    expect(byKey(resolved, "  quality  ")).toBeUndefined();
  });

  it("非字符串字段被忽略（不把 number/null 写进文本）", () => {
    const resolved = resolveContractClauses({
      clauses: [
        {
          key: "quality",
          label_zh: null,
          label_en: 42,
          text_zh: ["not", "string"],
          text_en: { nope: true },
        },
      ],
    });
    expect(byKey(resolved, "quality")).toEqual(
      byKey(DEFAULT_CONTRACT_CLAUSES, "quality"),
    );
  });
});

describe("resolveContractClauses — 追加", () => {
  it("未知 key 追加到末尾，完整字段原样保留", () => {
    const extra = {
      key: "confidentiality",
      label_zh: "保密",
      label_en: "Confidentiality",
      text_zh: "双方应对本合同内容保密。",
      text_en: "Both parties shall keep the terms of this Contract confidential.",
    };
    const resolved = resolveContractClauses({ clauses: [extra] });

    expect(resolved).toHaveLength(13);
    expect(resolved[12]).toEqual(extra);
    expect(resolved.slice(0, 12)).toEqual(DEFAULT_CONTRACT_CLAUSES);
  });

  it("追加多条时保持入参顺序", () => {
    const resolved = resolveContractClauses({
      clauses: [
        { key: "z_first", text_zh: "一", text_en: "one" },
        { key: "a_second", text_zh: "二", text_en: "two" },
      ],
    });
    expect(resolved.map((clause) => clause.key).slice(-2)).toEqual([
      "z_first",
      "a_second",
    ]);
  });

  it("追加条目缺 label 时用 key 兜底、缺正文用空串", () => {
    const resolved = resolveContractClauses({ clauses: [{ key: "warranty" }] });
    expect(resolved).toHaveLength(13);
    expect(resolved[12]).toEqual({
      key: "warranty",
      label_zh: "warranty",
      label_en: "warranty",
      text_zh: "",
      text_en: "",
    });
  });

  it("重复的未知 key 合并为一条（后者覆盖前者），结果 key 唯一", () => {
    const resolved = resolveContractClauses({
      clauses: [
        { key: "warranty", text_zh: "第一版", text_en: "v1" },
        { key: "warranty", text_zh: "第二版" },
      ],
    });
    expect(resolved).toHaveLength(13);
    const warranty = resolved.find((clause) => clause.key === "warranty");
    expect(warranty).toEqual({
      key: "warranty",
      label_zh: "warranty",
      label_en: "warranty",
      text_zh: "第二版",
      text_en: "v1",
    });
    expect(new Set(resolved.map((clause) => clause.key)).size).toBe(
      resolved.length,
    );
  });
});

describe("纯函数约束", () => {
  it("不修改入参（custom 与其中 clauses 条目保持原样）", () => {
    const custom = {
      clauses: [
        { key: "quality", label_zh: "被覆盖", text_en: "override" },
        { key: "confidentiality", label_zh: "保密", text_zh: "正文" },
      ],
    };
    const before = snapshot(custom);
    resolveContractClauses(custom);
    expect(snapshot(custom)).toBe(before);
  });

  it("不修改 DEFAULT_CONTRACT_CLAUSES（返回副本可自由修改）", () => {
    const defaultsBefore = snapshot(DEFAULT_CONTRACT_CLAUSES);
    const resolved = resolveContractClauses({
      clauses: [{ key: "quality", text_en: "changed" }],
    });
    const first = resolved[0];
    if (!first) throw new Error("expected at least one clause");
    first.text_en = "mutated by caller";
    resolved.push({
      key: "extra",
      label_zh: "额外",
      label_en: "Extra",
      text_zh: "",
      text_en: "",
    });
    expect(snapshot(DEFAULT_CONTRACT_CLAUSES)).toBe(defaultsBefore);
  });
});
