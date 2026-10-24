/**
 * 报价行卡 · 客户英文名（本单使用）选择（A 项 2026-10-24）。
 *
 * 钉住的验收口径：
 * 1. 产品有 **>1 个**英文名才出现下拉（单名不制造噪音），默认名带「（默认）」标注；
 * 2. 默认名 = 该客户**最近一次同产品**用过的英文名（偏好命中才采用），无历史用产品默认名；
 * 3. 手选第 2 个名后本单固定用它，且 line-to-item 产出的 item.product_name 就是该名；
 * 4. 换产品重置并按新产品默认名重新解析；
 * 5. 选中名在**行卡标题与折叠摘要**都要能看到。
 *
 * 换客户时「手动行保留 / 未手动行清空」是纯函数（lib 层单测覆盖），这里只测行卡内的
 * 默认解析与重置，不重复造状态层。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  ExportQuoteResponse,
  ProductFormulasResponse,
} from "@contracts/export-quote";

import { buildLineItem } from "../../lib/line-to-item";
import {
  QuoteLineCard,
  newLineDraft,
  type LineDraft,
} from "../quote-line-card";

/**
 * 全部 fixture 放进 vi.hoisted：vi.mock 工厂会被提升，只有 hoisted 里的值在工厂
 * 执行时一定可用（引用外层 const 会踩 TDZ）。
 */
const state = vi.hoisted(() => {
  const result = {
    meta: {
      product_key: "field_fence",
      product_name: "牛栏网",
      combo_count: 1,
    },
    view: "customer",
    customer: {
      view: "customer",
      header: ["单卷净重(kg)", "单卷长方体体积(m³)", "单卷美元售价(USD/卷)"],
      rows: [[30.5, 0.09, 301.03]],
      decimals: [4, 4, 4],
      horizontal_header: [],
      vertical_header: [],
      vertical_data: [],
    },
    customer_en: {
      view: "customer",
      header: ["单卷净重(kg)", "单卷长方体体积(m³)", "单卷美元售价(USD/卷)"],
      rows: [[30.5, 0.09, 301.03]],
      decimals: [4, 4, 4],
      horizontal_header: [],
      vertical_header: [],
      vertical_data: [],
    },
  };
  const fieldFenceFormulas = {
    product_key: "field_fence",
    name: "牛栏网",
    name_en: "Cattle Fence",
    hs_codes: ["73144100"],
    cost: {
      field: "cost_cny_per_kg",
      basis: "pretax",
      unit: "CNY/kg",
      note: "到厂未税成本",
    },
    space: {
      axes: [
        {
          name: "height_m",
          label: "网高(m)",
          label_en: "Net Height (m)",
          kind: "axis",
          options: [
            { value: 1.5, label: "1.5 m", attributes: { roll_len_m: 100 } },
          ],
        },
      ],
      variants: [],
      combo_count: 1,
      summary: "",
      formula: "",
    },
    piece_inputs: [
      {
        key: "roll_len_m",
        label: "单卷米数",
        label_en: "",
        unit: "m",
        ui_unit: "m",
        ui_scale: 1,
        variant: "height_m",
        note: "",
        unit_quantity: true,
      },
    ],
    numeric_inputs: [],
    columns: [
      {
        key: "derived.weight_per_piece_kg",
        label: "单卷净重(kg)",
        internal: false,
      },
      {
        key: "derived.volume_box_per_piece_m3",
        label: "单卷长方体体积(m³)",
        internal: false,
      },
      {
        key: "piece.price_per_piece_fx",
        label: "单卷美元售价",
        internal: false,
      },
    ],
    space_deduction: null,
    packaging: [],
  };
  const chainLinkFormulas = {
    product_key: "chain_link",
    name: "勾花网",
    name_en: "Chain Link Fence",
    hs_codes: ["7314490000"],
    cost: {
      field: "cost_cny_per_m2",
      basis: "pretax",
      unit: "CNY/㎡",
      note: "到厂未税成本",
    },
    space: { axes: [], variants: [], combo_count: 0, summary: "", formula: "" },
    piece_inputs: [],
    numeric_inputs: [],
    columns: [],
    space_deduction: null,
    packaging: [],
  };
  return {
    /** field_fence 的「其它英文名」；undefined/[] 都等价于只有一个默认名 */
    aliases: ["Field Fence"] as string[] | undefined,
    formulas: {
      field_fence: fieldFenceFormulas,
      chain_link: chainLinkFormulas,
    },
    result,
    pref: {
      product_name: null as string | null,
      isFetched: true,
      isError: false,
    },
  };
});

vi.mock("../../hooks/use-export-quote-import", () => ({
  useExportProducts: () => ({
    data: {
      products: [
        {
          key: "field_fence",
          name: "牛栏网",
          name_en: "Cattle Fence",
          name_en_aliases: state.aliases,
        },
        // 第二个产品只有一个英文名：换产品后默认名 / 下拉是否消失都靠它验证
        { key: "chain_link", name: "勾花网", name_en: "Chain Link Fence" },
      ],
    },
    isLoading: false,
  }),
}));

vi.mock("../../hooks/use-export-quote-calc", () => ({
  useCalcQuote: () => ({
    isPending: false,
    mutateAsync: async () => state.result,
  }),
  // data 必须是按产品**稳定引用**：组件用 [formulas.data] 做 effect 依赖
  useProductFormulas: (key: string | null) => ({
    data: key ? state.formulas[key as "field_fence" | "chain_link"] : undefined,
    isLoading: false,
  }),
}));

vi.mock("../../hooks/use-product-name-preference", () => ({
  useProductNamePreference: () => ({
    data: { product_name: state.pref.product_name },
    isFetched: state.pref.isFetched,
    isError: state.pref.isError,
  }),
}));

vi.mock("../../hooks/use-reference-price", () => ({
  useReferencePrice: () => ({ data: null }),
}));

vi.mock("@/lib/products/use-products", () => ({
  useProductProfile: () => ({ data: undefined }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

/** 受控壳：把 onChange 的 patch 合并回 line；probe 暴露行状态，便于断言写回值。 */
function Harness({
  spy,
  initial,
  customerId = "1",
}: {
  spy: (patch: Partial<LineDraft>) => void;
  initial?: Partial<LineDraft>;
  customerId?: string | null;
}) {
  const [line, setLine] = useState<LineDraft>(() => ({
    ...newLineDraft("field_fence"),
    ...initial,
  }));
  const onChange = (patch: Partial<LineDraft>) => {
    spy(patch);
    setLine((prev) => ({ ...prev, ...patch }));
  };
  return (
    <>
      <div data-testid="line-state">
        {JSON.stringify({
          nameEn: line.nameEn,
          nameEnManual: line.nameEnManual,
          builtName: line.built?.item.product_name ?? null,
          builtPrice: line.built?.item.unit_price ?? null,
        })}
      </div>
      <QuoteLineCard
        index={0}
        line={line}
        shared={{ quoteCurrency: "USD", fxRate: "7.2" } as never}
        view="customer"
        lineCount={1}
        customerId={customerId}
        onChange={onChange}
        onRemove={() => {}}
      />
    </>
  );
}

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

/** 同一个 root 重渲染（模拟父组件换 prop，例如换客户）。 */
function rerender(element: ReactNode) {
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

/** 让 effect 里的 set-state 级联跑完（默认名解析 → 重渲染 → 再判定）。 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function nameSelect(): HTMLSelectElement | null {
  return container!.querySelector(
    'select[id$="-name-en"]',
  ) as HTMLSelectElement | null;
}

function optionTexts(select: HTMLSelectElement): string[] {
  return Array.from(select.querySelectorAll("option")).map(
    (o) => o.textContent ?? "",
  );
}

function lineState(): {
  nameEn: string;
  nameEnManual: boolean;
  builtName: string | null;
  builtPrice: number | null;
} {
  const el = container!.querySelector('[data-testid="line-state"]')!;
  return JSON.parse(el.textContent ?? "{}") as never;
}

/** 原生 input/select 设值 + 触发 React onChange（jsdom 下必须走原生 setter）。 */
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 行卡顶部的**产品**下拉（选项值是产品 key）。 */
function productSelect(): HTMLSelectElement {
  const found = Array.from(container!.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === "chain_link"),
  );
  expect(found).toBeDefined();
  return found as HTMLSelectElement;
}

/** 用某个英文名走一遍 line-to-item（与行卡 compute 同参数），验证落库名。 */
function itemForName(nameEn: string) {
  return buildLineItem({
    product: {
      key: "field_fence",
      name: "牛栏网",
      name_en: "Cattle Fence",
      hs_codes: ["73144100"],
    },
    formulas: state.formulas.field_fence as unknown as ProductFormulasResponse,
    spec: { height_m: 1.5 },
    pieceBase: { roll_len_m: 100 },
    result: state.result as unknown as ExportQuoteResponse,
    view: "customer",
    pieces: 1,
    rollLengthM: 100,
    nameEn,
  });
}

describe("客户英文名下拉（多英文名才出现）", () => {
  beforeEach(() => {
    state.aliases = ["Field Fence", "Cattle Fence", "  "];
    state.pref = { product_name: null, isFetched: true, isError: false };
  });
  afterEach(unmount);

  it("多个英文名 → 出现下拉：默认名在前、标注（默认）、大小写去重", async () => {
    mount(<Harness spy={() => {}} />);
    await flush();
    const select = nameSelect();
    expect(select).not.toBeNull();
    // 第三个别名是空白；第二个别名 "Cattle Fence" 与默认名大小写无关地重复 ⇒ 去重
    expect(optionTexts(select!)).toEqual([
      "Cattle Fence（默认）",
      "Field Fence",
    ]);
    expect(container!.textContent ?? "").toContain("客户英文名（本单使用）");
    // 文案中性：只讲"默认英文名 / 客户历史"，不出现地区/国家措辞
    expect(container!.textContent ?? "").toContain("默认英文名");
    expect(container!.textContent ?? "").not.toContain("欧洲");
    expect(container!.textContent ?? "").not.toContain("地区");
  });

  it("只有一个英文名 → 不渲染下拉（避免噪音）", async () => {
    state.aliases = [];
    mount(<Harness spy={() => {}} />);
    await flush();
    expect(nameSelect()).toBeNull();
  });
});

describe("默认名解析（客户历史偏好优先，无历史用产品默认名）", () => {
  beforeEach(() => {
    state.aliases = ["Field Fence"];
  });
  afterEach(unmount);

  it("偏好命中 → 默认用客户上次用的名（大小写不敏感）", async () => {
    state.pref = {
      product_name: "field fence",
      isFetched: true,
      isError: false,
    };
    const spy = vi.fn();
    mount(<Harness spy={spy} />);
    await flush();
    expect(lineState().nameEn).toBe("Field Fence");
    expect(nameSelect()!.value).toBe("Field Fence");
    expect(spy.mock.calls.some(([p]) => p.nameEn === "Field Fence")).toBe(true);
  });

  it("无历史（product_name=null）→ 产品默认英文名", async () => {
    state.pref = { product_name: null, isFetched: true, isError: false };
    mount(<Harness spy={() => {}} />);
    await flush();
    expect(lineState().nameEn).toBe("Cattle Fence");
  });

  it("偏好名已不在本产品英文名里（改过名）→ 回落默认名，不写不存在的名", async () => {
    state.pref = { product_name: "Old Fence", isFetched: true, isError: false };
    mount(<Harness spy={() => {}} />);
    await flush();
    expect(lineState().nameEn).toBe("Cattle Fence");
  });

  it("偏好查询未结束 → 不写默认名（等结果，避免先闪默认名再被覆盖）", async () => {
    state.pref = {
      product_name: "Field Fence",
      isFetched: false,
      isError: false,
    };
    const spy = vi.fn();
    mount(<Harness spy={spy} />);
    await flush();
    expect(lineState().nameEn).toBe("");
    expect(spy.mock.calls.some(([p]) => p.nameEn)).toBe(false);
  });
});

describe("手选英文名 → 本单落库名 / built 同步 / 折叠摘要", () => {
  beforeEach(() => {
    state.aliases = ["Field Fence"];
    state.pref = { product_name: null, isFetched: true, isError: false };
  });
  afterEach(unmount);

  it("选第 2 个名：nameEn + nameEnManual 写回，buildLineItem 的 item.product_name = 该名", async () => {
    mount(<Harness spy={() => {}} />);
    await flush();
    act(() => setSelect(nameSelect()!, "Field Fence"));
    await flush();
    const st = lineState();
    expect(st.nameEn).toBe("Field Fence");
    expect(st.nameEnManual).toBe(true);
    expect(itemForName(st.nameEn).item.product_name).toBe("Field Fence");
    // 对照：默认名仍产出产品默认英文名
    expect(itemForName("Cattle Fence").item.product_name).toBe("Cattle Fence");
  });

  it("已有算价结果时换名 → built.item.product_name 同步，单价不重算", async () => {
    const built = itemForName("Cattle Fence");
    mount(<Harness spy={() => {}} initial={{ built }} />);
    await flush();
    act(() => setSelect(nameSelect()!, "Field Fence"));
    await flush();
    const st = lineState();
    expect(st.builtName).toBe("Field Fence");
    expect(st.builtPrice).toBe(301.03);
  });

  it("选中名展示在行卡标题与折叠摘要（DOM）", async () => {
    state.pref = {
      product_name: "Field Fence",
      isFetched: true,
      isError: false,
    };
    mount(<Harness spy={() => {}} />);
    await flush();
    const titleName = container!.querySelector('[data-testid="line-name-en"]');
    expect(titleName?.textContent).toBe("Field Fence");

    // 选规格 + 件数 + 成本 → 计算本行（算完收起，摘要出现）
    const specSelect = Array.from(container!.querySelectorAll("select")).find(
      (s) => Array.from(s.options).some((o) => o.value === "1.5"),
    ) as HTMLSelectElement;
    act(() => setSelect(specSelect, "1.5"));
    const piecesInput = container!.querySelector(
      'input[placeholder="请填写卷数"]',
    ) as HTMLInputElement;
    act(() => setInput(piecesInput, "3"));
    const costInput = container!.querySelector(
      'input[placeholder="请填写成本"]',
    ) as HTMLInputElement;
    act(() => setInput(costInput, "8.75"));
    const submit = Array.from(container!.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("计算本行"),
    );
    expect(submit).toBeDefined();
    await act(async () => {
      submit!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const productRow = container!.querySelector(
      '[data-testid="line-summary-product"]',
    );
    expect(productRow).not.toBeNull();
    expect(productRow!.textContent ?? "").toContain("英文名 Field Fence");
  });
});

describe("换产品 → 重置并按新产品默认名重新解析", () => {
  beforeEach(() => {
    state.aliases = ["Field Fence"];
    // 客户历史名只属于 field_fence；chain_link 不在选项里 ⇒ 换过去应回落其默认名
    state.pref = {
      product_name: "Field Fence",
      isFetched: true,
      isError: false,
    };
  });
  afterEach(unmount);

  it("换产品：nameEn/nameEnManual 重置，默认名变成新产品默认名", async () => {
    const spy = vi.fn();
    mount(<Harness spy={spy} />);
    await flush();
    expect(lineState().nameEn).toBe("Field Fence");

    act(() => setSelect(productSelect(), "chain_link"));
    await flush();

    // ① 换产品的补丁里就带重置（不等 formulas 回来）
    expect(
      spy.mock.calls.some(([p]) => p.nameEn === "" && p.nameEnManual === false),
    ).toBe(true);
    // ② 按新产品默认英文名重新解析（旧偏好 Field Fence 不属于它）
    expect(lineState().nameEn).toBe("Chain Link Fence");
    expect(lineState().nameEnManual).toBe(false);
    // ③ 新产品的英文名只有一个 ⇒ 下拉消失
    expect(nameSelect()).toBeNull();
  });
});

describe("换客户 → 未手动行按新客户偏好重新解析，手动行保留", () => {
  beforeEach(() => {
    state.aliases = ["Field Fence"];
  });
  afterEach(unmount);

  it("未手动行：换客户后默认名变成新客户的历史名", async () => {
    // 客户 1 的历史：Cattle Fence（默认名）；客户 2 的历史：Field Fence（第 2 个名）
    state.pref = {
      product_name: "Cattle Fence",
      isFetched: true,
      isError: false,
    };
    mount(<Harness spy={() => {}} customerId="1" />);
    await flush();
    expect(lineState().nameEn).toBe("Cattle Fence");

    state.pref = {
      product_name: "Field Fence",
      isFetched: true,
      isError: false,
    };
    rerender(<Harness spy={() => {}} customerId="2" />);
    await flush();
    expect(lineState().nameEn).toBe("Field Fence");
    expect(lineState().nameEnManual).toBe(false);
  });

  it("手动选过的行：换客户也不覆盖（这是业务对该客户的明确选择）", async () => {
    state.pref = { product_name: null, isFetched: true, isError: false };
    mount(<Harness spy={() => {}} customerId="1" />);
    await flush();
    act(() => setSelect(nameSelect()!, "Field Fence"));
    await flush();
    expect(lineState().nameEnManual).toBe(true);

    state.pref = {
      product_name: "Cattle Fence",
      isFetched: true,
      isError: false,
    };
    rerender(<Harness spy={() => {}} customerId="2" />);
    await flush();
    expect(lineState().nameEn).toBe("Field Fence");
    expect(lineState().nameEnManual).toBe(true);
  });
});
