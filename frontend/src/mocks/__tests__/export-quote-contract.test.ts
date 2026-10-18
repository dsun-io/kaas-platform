/**
 * task-11 回归测试：**M1 最小集（P0）**的 4 个出口报价端点必须被 MSW 接住，不再放行到网络。
 *
 * ## 为什么"被接住"本身就是核心断言
 *
 * `/quotes` 默认 tab 首屏**必然**发出这 4 个请求；没有 handler 时 MSW 按
 * `onUnhandledRequest:"warn"`（`components/msw-provider.tsx:83`）放行到网络 ⇒
 * e2e 下（`playwright.config.ts:41/54`：MODE=mock 且 API_BASE 指回**页面源**）
 * 命中 Next dev 的 `/api/v1/*` rewrite（`next.config.mjs:23-30`）⇒ **自己代理自己**
 * ⇒ 请求永不结束（`msw-provider.tsx:14-19/49-53` 记录过这条链）。
 *
 * 所以本文件用 `setupServer` + **`onUnhandledRequest: "error"`**：
 * 只要有一个端点没 handler，请求就会以
 * `Cannot bypass a request when using the error strategy` 失败
 * ⇒ **"拿到 200" 就是"没有被放行到网络"的证明**。补 handler 之前本文件必然失败。
 *
 * ## 第二个断言目标：形状要能被页面渲染（字段逐个对上消费方）
 *
 * 每个 describe 都标了**消费方 file:line**，断言的就是那几个字段 ——
 * 不是照抄后端文档，而是"页面真的会读它"。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers } from "../handlers";

const server = setupServer(...handlers);
// handlers 用相对路径，MSW 按当前 origin 解析；jsdom 默认 origin 是 localhost:3000
const BASE = "http://localhost:3000/api/v1";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

describe("GET /export-quote/products ← quote-line-card.tsx:107-109（useExportProducts）", () => {
  it("200 + `products[].key/name` + `total`（页面用 products[0].key 兜底默认产品）", async () => {
    const { status, body } = await getJson<{
      products: Array<{ key: string; name: string }>;
      total: number;
    }>("/export-quote/products");

    expect(status).toBe(200);
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.products.length);

    // 消费方逐字段：`:109` 读 `key`；`:309-312` 渲染 `<option value={p.key}>{p.name}</option>`
    for (const p of body.products) {
      expect(typeof p.key).toBe("string");
      expect(p.key.length).toBeGreaterThan(0);
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
    }
  });
});

describe("GET /export-quote/products/:key/formulas ← quote-line-card.tsx:110-132", () => {
  it("200（带 ?with_columns=true，与 useProductFormulas(key, true) 一致）+ 规格空间字段", async () => {
    // 先拿默认产品（= 页面会用的那个），再带**真实的 query** 请求 —— 避免"少了 query 才通过"
    const products = await getJson<{ products: Array<{ key: string }> }>(
      "/export-quote/products",
    );
    const key = products.body.products[0]!.key;

    // use-export-quote-calc.ts:44 在 with_columns=true 时加 `?with_columns=true`
    const { status, body } = await getJson<Record<string, unknown>>(
      `/export-quote/products/${key}/formulas?with_columns=true`,
    );
    expect(status).toBe(200);

    // :117/:184-185 `isSpecComplete(formulas.data, …)` 要 `space`
    const space = body.space as { axes: unknown[]; variants: unknown[] };
    expect(Array.isArray(space.axes)).toBe(true);
    expect(Array.isArray(space.variants)).toBe(true);

    // :129-132 把 axes + variants 拼成界面分组、读 piece_inputs
    expect(Array.isArray(body.piece_inputs)).toBe(true);

    // :224-226 落库快照要 name / name_en / hs_codes
    expect(typeof body.name).toBe("string");
    expect(Array.isArray(body.hs_codes)).toBe(true);

    // :244 体积扣减口径
    expect(typeof (body.space_deduction as { mode?: unknown }).mode).toBe("string");

    // :193 `makeColumnIndexer(formulas.data, view)` 依赖列定义（with_columns=true 时后端必给）
    expect(Array.isArray(body.columns)).toBe(true);
  });

  it("未注册产品 → 404 `unknown_product`（与后端 _get_product_or_404 同语义，不是挂死）", async () => {
    const { status, body } = await getJson<{ error: string }>(
      "/export-quote/products/not_a_product/formulas",
    );
    expect(status).toBe(404);
    expect(body.error).toBe("unknown_product");
  });
});

describe("GET /export-quote/rate-sets ← quote-workbench-view.tsx:157,616-619", () => {
  it("200 + `rate_sets[].code/name`（下拉只读这两个）+ `total`", async () => {
    const { status, body } = await getJson<{
      rate_sets: Array<{ code: string; name: string }>;
      total: number;
    }>("/export-quote/rate-sets");

    expect(status).toBe(200);
    expect(body.rate_sets.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.rate_sets.length);
    for (const r of body.rate_sets) {
      expect(typeof r.code).toBe("string");
      expect(r.code.length).toBeGreaterThan(0);
      expect(typeof r.name).toBe("string");
    }
  });
});

describe("GET /export-quote/terms/template ← quote-workbench-view.tsx:158,188-204,849-866", () => {
  it("200 + quote_as / items / ladder（terms-amortize.ts:67-83 逐项读取）", async () => {
    const { status, body } = await getJson<{
      base: string;
      quote_as: string;
      weight_field: string;
      items: Record<string, { name: string; mode: string; value: null }>;
      ladder: Array<{
        code: string;
        label: string;
        label_en: string;
        items: string[];
      }>;
    }>("/export-quote/terms/template");

    expect(status).toBe(200);
    // :189 `termsTemplate?.quote_as || "CIF"`
    expect(typeof body.quote_as).toBe("string");
    expect(body.quote_as.length).toBeGreaterThan(0);
    // terms-amortize.ts:79-81 原样回传这三个
    expect(typeof body.base).toBe("string");
    expect(typeof body.weight_field).toBe("string");

    // :195 用 items 的键建金额表；:866 渲染每个费用项
    const feeKeys = Object.keys(body.items);
    expect(feeKeys.length).toBeGreaterThan(0);
    for (const k of feeKeys) {
      expect(typeof body.items[k]!.name).toBe("string");
      expect(typeof body.items[k]!.mode).toBe("string");
      // 结构与金额分离：模板里的金额一律留空（terms_template.py:40-41）
      expect(body.items[k]!.value).toBeNull();
    }

    // :859 渲染阶梯；terms-amortize.ts:83 原样带下去
    expect(body.ladder.length).toBeGreaterThan(0);
    for (const rung of body.ladder) {
      expect(typeof rung.code).toBe("string");
      expect(Array.isArray(rung.items)).toBe(true);
      // 阶梯里引用的费用项必须真实存在（否则引擎/界面会对不上）
      for (const ref of rung.items) {
        expect(feeKeys).toContain(ref);
      }
    }

    // 档位与顺序必须与后端 DEFAULT_EXPORT_TERMS 逐字一致
    // （terms_template.py: DAP / DDP 接在 CIF 之后；选项显示 `代码 · 中文（English）`）
    expect(body.ladder.map((r) => r.code)).toEqual([
      "EXW",
      "FOB",
      "CFR",
      "CIF",
      "DAP",
      "DDP",
    ]);
    // label_en 用英文全称，界面据此显示 `DAP · 到门价（Delivered at Place）`
    expect(
      body.ladder.map((r) => [r.code, r.label_en]),
    ).toEqual([
      ["EXW", "Ex Works"],
      ["FOB", "Free On Board"],
      ["CFR", "Cost and Freight"],
      ["CIF", "Cost, Insurance and Freight"],
      ["DAP", "Delivered at Place"],
      ["DDP", "Delivered Duty Paid"],
    ]);
  });
});

describe("P0 四件套一次性验证：全部被 handler 接住（无一个放行到网络）", () => {
  it("依次拿到 200/200/200/200，而不是未匹配请求的失败", async () => {
    const results = await Promise.all([
      fetch(`${BASE}/export-quote/products`),
      fetch(`${BASE}/export-quote/products/chain_link/formulas?with_columns=true`),
      fetch(`${BASE}/export-quote/rate-sets`),
      fetch(`${BASE}/export-quote/terms/template`),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });
});
