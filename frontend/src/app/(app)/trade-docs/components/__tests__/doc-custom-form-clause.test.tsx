/**
 * 单证内容表单 · 条款模板回填（A5-W1）。
 *
 * 覆盖：
 * 1. 条款字段（contract 的 payment_terms）出现「选择条款模板」下拉；
 * 2. 选模板 → 单段字段按英文单证口径回填 text_en；
 * 3. 默认只填空字段：已有内容不覆盖，先弹二次确认；
 * 4. 确认「覆盖」后才替换；「取消」保留原内容；
 * 5. 非条款字段不出现模板下拉（避免把备注等自由文本也塞模板）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DocCustomForm } from "../doc-custom-form";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  apiClient: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));

const toastSuccess = vi.fn();
const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEMPLATES = [
  {
    id: 1,
    name: "30% 定金条款",
    doc_types: ["contract"],
    text_zh: "30% 定金，余款凭提单副本支付。",
    text_en: "30% deposit, balance against B/L copy.",
    sort_order: 1,
    is_active: true,
  },
  {
    id: 2,
    name: "装运条款",
    doc_types: ["contract"],
    text_zh: "装运条款：FOB 上海；允许分批装运与转运。",
    text_en:
      "Shipment Terms: FOB Shanghai; partial shipment and transhipment are allowed.",
    sort_order: 2,
    is_active: true,
  },
];

type Resp = { data: unknown };
const ok = (data: unknown): Resp => ({ data }) as unknown as Resp;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 5) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
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

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

function clickButton(text: string) {
  const target = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.replace("…", "").trim() === text,
  );
  if (!target) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** payment_terms 内容项所在 label 里的 <input>（label 上有 data-field） */
function clauseInput(): HTMLInputElement | null {
  const label = document.querySelector('label[data-field="payment_terms"]');
  return label?.querySelector<HTMLInputElement>("input") ?? null;
}

function templateSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>(
    'select[aria-label="付款方式 条款模板"]',
  );
}

function chooseTemplate(id: number) {
  const select = templateSelect();
  if (!select) throw new Error("没找到条款模板下拉");
  act(() => {
    select.value = String(id);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((url: string) => {
    if (url === "/clause-templates") return Promise.resolve(ok({ items: TEMPLATES }));
    if (url === "/products")
      return Promise.resolve(ok({ items: [], media_kinds: {} }));
    return Promise.resolve(ok({}));
  });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

function renderForm(custom: Record<string, unknown> = {}) {
  return (
    <DocCustomForm
      docId={1}
      docType="contract"
      status="draft"
      payload={{ custom }}
      // A5-W3 起 DocCustomForm 需要装配后的数据（金额摘要条数据源）；本用例不关心金额
      data={{}}
    />
  );
}

describe("DocCustomForm · 条款模板回填", () => {
  it("条款字段出现模板下拉（本单证适用模板），非条款字段没有", async () => {
    mount(renderForm());
    await settle();

    const select = templateSelect();
    expect(select).not.toBeNull();
    const optionText = Array.from(select!.options)
      .map((o) => o.textContent)
      .join("|");
    expect(optionText).toContain("30% 定金条款");
    expect(optionText).toContain("装运条款");

    // remarks 不是条款字段 → 不应有模板下拉
    expect(
      document.querySelector('select[aria-label="备注 条款模板"]'),
    ).toBeNull();
  });

  it("空字段：选模板直接回填英文 text_en（单段字段英文单证口径）", async () => {
    mount(renderForm());
    await settle();

    expect(clauseInput()?.value).toBe("");
    chooseTemplate(1);
    await settle();

    expect(clauseInput()?.value).toBe("30% deposit, balance against B/L copy.");
    expect(document.body.textContent ?? "").toContain(
      "该字段是单段文本（英文单证口径）：已回填英文",
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "已用「30% 定金条款」回填（英文）",
    );
    // 默认只填空字段 ⇒ 不应出现覆盖确认
    expect(document.body.textContent ?? "").not.toContain("覆盖已填内容？");
  });

  it("已填字段：先弹二次确认；取消保留原内容，覆盖才替换", async () => {
    mount(renderForm({ payment_terms: "EXISTING TERMS" }));
    await settle();
    expect(clauseInput()?.value).toBe("EXISTING TERMS");

    chooseTemplate(1);
    await settle();
    expect(document.body.textContent ?? "").toContain("覆盖已填内容？");
    expect(document.body.textContent ?? "").toContain("30% 定金条款");

    clickButton("取消（保留原内容）");
    await settle();
    expect(clauseInput()?.value).toBe("EXISTING TERMS");
    expect(document.body.textContent ?? "").not.toContain("覆盖已填内容？");

    chooseTemplate(1);
    await settle();
    clickButton("覆盖");
    await settle();
    expect(clauseInput()?.value).toBe("30% deposit, balance against B/L copy.");
    expect(toastSuccess).toHaveBeenCalledWith(
      "已用「30% 定金条款」覆盖回填（英文）",
    );
  });

  it("内容与模板一致：noop 提示，不弹覆盖确认", async () => {
    mount(
      renderForm({ payment_terms: "30% deposit, balance against B/L copy." }),
    );
    await settle();
    chooseTemplate(1);
    await settle();
    expect(document.body.textContent ?? "").not.toContain("覆盖已填内容？");
    expect(toastInfo).toHaveBeenCalled();
  });
});
