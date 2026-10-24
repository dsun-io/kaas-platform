/**
 * 产品英文名（可保存 / 系统产品可改 / 多值）—— 2026-10-24 生产验收回归。
 *
 * 钉住用户报的三件事：
 * 1. 基本信息里改英文名**真的发请求**（旧版保存按钮只 PUT profile 的用途/产地/材质，
 *    英文名根本没进请求体 ⇒「看起来能改、关掉就没了」）；
 * 2. 系统产品（鹿网/牛栏网，无 tenant_products 行）也必须能改 —— 保存走团队资料，
 *    不能因为没租户行就禁用输入框；
 * 3. 一个产品可有多个英文名，第一个是默认英文名；保存时 `name_en_list` 默认名在前，
 *    租户行 `product_name_en` 跟默认名一致（报价/订单/单证用默认名）。
 * 4. UI 只说「英文名（可添加多个）」+「默认（报价/单证使用）」，
 *    **不出现**"地区 / 欧洲客户叫…"这类叫法来源文案。
 *
 * 写法照 `product-images.test.tsx`：`@/lib/api/client` 打桩 + 真 QueryClient + act。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: mocks.get,
    put: mocks.put,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  apiClient: {
    get: mocks.get,
    put: mocks.put,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { toast } from "sonner";

import { ProductDetail } from "../product-detail";
import type { WorkProduct } from "@/lib/products/tenant-products";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SPEC = {
  key: "chain_link",
  name: "勾花网",
  name_en: "Chain Link Fence",
  category_code: "gouhuawang",
  derived: [{ name: "weight", expr: "1" }],
  columns: [],
  variants: [],
  numeric_inputs: [],
  packaging: [],
  hs_codes: ["7314490000"],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
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

function buttonByText(label: string): HTMLButtonElement {
  const els = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  );
  const el = els.find((b) => (b.textContent ?? "").trim() === label);
  if (!el) {
    throw new Error(
      `没找到按钮「${label}」；现有：${els
        .map((b) => (b.textContent ?? "").trim())
        .join(" | ")}`,
    );
  }
  return el;
}

function inputByLabel(label: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`没找到输入框 aria-label="${label}"`);
  return el;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`没找到按钮 aria-label="${label}"`);
  return el;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function lastPut(path: string) {
  const call = mocks.put.mock.calls.find(([url]) => String(url) === path);
  if (!call) {
    throw new Error(
      `没有 PUT ${path}；实际：${mocks.put.mock.calls
        .map(([url]) => String(url))
        .join(", ")}`,
    );
  }
  return call[1] as Record<string, unknown>;
}

function putCalls() {
  return mocks.put.mock.calls.map(([url]) => String(url));
}

// ── 产品行（WorkProduct；与 mergeWorkProducts 的产出同形状）─────────────────

function systemProduct(): WorkProduct {
  return {
    key: "deer_net",
    name: "鹿网",
    nameEn: "Deer Net",
    nameEnList: ["Deer Net"],
    nameEnAliases: [],
    categoryCode: "luwang",
    tenant: null,
    isSystem: true,
  };
}

function tenantProduct(): WorkProduct {
  return {
    key: "chain_link",
    name: "我们的勾花网",
    nameEn: "Our Chain Link",
    nameEnList: ["Our Chain Link", "Chain Link Fence"],
    nameEnAliases: ["Chain Link Fence"],
    categoryCode: "gouhuawang",
    tenant: {
      id: 7,
      product_key: "chain_link",
      product_name: "我们的勾花网",
      product_name_en: "Our Chain Link",
      category_code: "gouhuawang",
      cost_field: "raw_price",
      cost_basis: "pretax",
      cost_unit: "CNY/㎡",
      profit_mode: "margin_on_price",
      profit_value: 0.06,
      misc_fee_rate: 0.03,
      spec: { ...SPEC, key: "chain_link", name: "我们的勾花网" },
      is_active: true,
    },
    isSystem: false,
  };
}

function mockReads(product: WorkProduct) {
  mocks.get.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u === "/auth/me") {
      return {
        data: {
          user_id: "11",
          email: "u11@kaas.local",
          account_type: "customer",
          role: "owner",
          effective_role: "customer_owner",
          is_tenant_admin: false,
          tenant_id: "default",
        },
      };
    }
    if (u === "/tenant-product-status") {
      return { data: { items: [] } };
    }
    if (u === `/products/${product.key}/profile`) {
      return { data: { product_key: product.key, info: {}, updated_at: null } };
    }
    if (u === `/products/${product.key}/media`) {
      return { data: { items: [], media_kinds: {} } };
    }
    if (u === `/export-quote/products/${product.key}/spec`) {
      return { data: { spec: { ...SPEC, key: product.key } } };
    }
    throw new Error(`unexpected GET ${u}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.put.mockResolvedValue({ data: {} });
  mocks.post.mockResolvedValue({ data: {} });
  mocks.delete.mockResolvedValue({ data: {} });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
});

describe("产品英文名 · 系统产品（无 tenant_products 行）", () => {
  it("英文名输入不再禁用；保存会真发 PUT /products/{key}/profile，且不建租户行", async () => {
    const product = systemProduct();
    mockReads(product);
    mount(
      <ProductDetail
        product={product}
        candidates={[product]}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await settle();

    // 修复前：disabled={!isTenant} ⇒ 系统产品的英文名根本改不了
    expect(inputByLabel("英文名 1").disabled).toBe(false);

    setInputValue(inputByLabel("新增英文名"), "Deer Fence EU");
    click(buttonByText("添加"));
    await settle();

    click(buttonByText("保存基本信息"));
    await settle();

    const body = lastPut("/products/deer_net/profile") as {
      info: Record<string, unknown>;
    };
    expect(body.info.name_en_list).toEqual(["Deer Net", "Deer Fence EU"]);
    expect(body.info.name_en_primary).toBe("Deer Net");
    // 系统产品不该因为「保存基本信息」被复制成租户产品
    expect(putCalls().some((u) => u.startsWith("/tenant-products"))).toBe(
      false,
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("已保存");
  });

  it("顶部「保存」对系统产品可用（不再只有「按我们的规格自定义」）", async () => {
    const product = systemProduct();
    mockReads(product);
    mount(
      <ProductDetail
        product={product}
        candidates={[product]}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await settle();
    expect(buttonByText("保存").disabled).toBe(false);
    // 「按我们的规格自定义」保留为独立动作（复制 spec），不是改英文名的前提
    expect(buttonByText("按我们的规格自定义").disabled).toBe(false);
  });
});

describe("产品英文名 · 租户产品（多值 + 主名）", () => {
  it("选第二个为主名后保存：profile 主名在前，租户行 product_name_en 同步主名", async () => {
    const product = tenantProduct();
    mockReads(product);
    mount(
      <ProductDetail
        product={product}
        candidates={[product]}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await settle();

    // 两条英文名都在（默认英文名 + 其它英文名）
    expect(inputByLabel("英文名 1").value).toBe("Our Chain Link");
    expect(inputByLabel("英文名 2").value).toBe("Chain Link Fence");

    // 换默认名：第 2 条顶到第 1 位
    click(inputByLabel("把「Chain Link Fence」设为默认英文名"));
    await settle();
    expect(inputByLabel("英文名 1").value).toBe("Chain Link Fence");
    expect(inputByLabel("英文名 2").value).toBe("Our Chain Link");

    click(buttonByText("保存"));
    await settle();

    const profileBody = lastPut("/products/chain_link/profile") as {
      info: Record<string, unknown>;
    };
    expect(profileBody.info.name_en_list).toEqual([
      "Chain Link Fence",
      "Our Chain Link",
    ]);
    expect(profileBody.info.name_en_primary).toBe("Chain Link Fence");

    const tenantBody = lastPut("/tenant-products/7") as Record<string, unknown>;
    expect(tenantBody.product_name_en).toBe("Chain Link Fence");
    expect((tenantBody.spec as Record<string, unknown>).name_en).toBe(
      "Chain Link Fence",
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("已保存");
  });

  it("英文名可删除；删空后保存 name_en_list 为空（不是把旧名悄悄留着）", async () => {
    const product = tenantProduct();
    mockReads(product);
    mount(
      <ProductDetail
        product={product}
        candidates={[product]}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await settle();

    click(buttonByLabel("删除英文名「Chain Link Fence」"));
    await settle();
    expect(document.querySelector('input[aria-label="英文名 2"]')).toBeNull();

    click(buttonByLabel("删除英文名「Our Chain Link」"));
    await settle();

    click(buttonByText("保存")); // 保存按钮仍可用（空名单是合法状态）
    await settle();

    const profileBody = lastPut("/products/chain_link/profile") as {
      info: Record<string, unknown>;
    };
    expect(profileBody.info.name_en_list).toEqual([]);
    expect(profileBody.info.name_en_primary).toBe("");

    // 空名单不覆盖既有租户英文名（避免「清空输入 = 清空旧值」这种意外副作用）
    const tenantBody = mocks.put.mock.calls
      .filter(([url]) => String(url) === "/tenant-products/7")
      .map(([, body]) => body as Record<string, unknown>)
      .at(0);
    if (tenantBody) {
      expect(tenantBody.product_name_en).toBeNull();
    }
  });
});

describe("产品英文名 · 文案去地区化", () => {
  it("只说「可添加多个 / 默认名」，不出现地区 / 欧洲客户叫法", async () => {
    const product = systemProduct();
    mockReads(product);
    mount(
      <ProductDetail
        product={product}
        candidates={[product]}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("英文名（可添加多个）");
    expect(text).toContain("第 1 个是默认英文名，报价 / 单证用它");
    expect(text).toContain("默认（报价/单证使用）");
    expect(text).not.toContain("地区");
    expect(text).not.toContain("欧洲客户");
    expect(text).not.toContain("主英文名");
    // 占位文案只给写法示例，不绑定"哪个地区怎么叫"
    expect(inputByLabel("新增英文名").placeholder).toBe("如：Cattle Fence");
  });
});

describe("产品英文名 · 添加多个英文名", () => {
  it("在编辑器里再加一条并保存：name_en_list 三条、默认英文名不变", async () => {
    const product = tenantProduct();
    mockReads(product);
    mount(
      <ProductDetail
        product={product}
        candidates={[product]}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await settle();

    setInputValue(inputByLabel("新增英文名"), "Cattle Fence EU");
    click(buttonByText("添加"));
    await settle();
    expect(inputByLabel("英文名 3").value).toBe("Cattle Fence EU");

    click(buttonByText("保存"));
    await settle();

    const profileBody = lastPut("/products/chain_link/profile") as {
      info: Record<string, unknown>;
    };
    expect(profileBody.info.name_en_list).toEqual([
      "Our Chain Link",
      "Chain Link Fence",
      "Cattle Fence EU",
    ]);
    // 新增的不抢默认名：报价/单证仍用原默认名
    expect(profileBody.info.name_en_primary).toBe("Our Chain Link");
    const tenantBody = lastPut("/tenant-products/7") as Record<string, unknown>;
    expect(tenantBody.product_name_en).toBe("Our Chain Link");
  });
});
