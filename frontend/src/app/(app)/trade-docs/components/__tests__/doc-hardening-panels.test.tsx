import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { toast } from "sonner";
import { parseConfirmBlocked } from "@/lib/trade-doc/hardening";

import { DocConfirmGate } from "../doc-confirm-gate";
import { DocConsistencyPanel } from "../doc-consistency-panel";
import { DocFactsPanel } from "../doc-facts-panel";
import { DocReceiptsPanel } from "../doc-receipts-panel";
import { DocSetPanel } from "../doc-set-panel";

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// React 18 的 act() 需要这个开关（仓库没有 testing-library / setup 文件）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC_ID = 1;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function ok(data: unknown) {
  return { data } as unknown as Awaited<ReturnType<typeof apiClient.get>>;
}

/** 按 URL 路由 GET；同一个 URL 可以给一串响应（用于"确认后重拉"）。 */
function routeGet(route: Record<string, unknown[]>) {
  const counters = new Map<string, number>();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const key = Object.keys(route).find((pattern) => url.includes(pattern));
    if (!key) throw new Error(`未预期的 GET ${url}`);
    const list = route[key] ?? [];
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    return ok(list[Math.min(index, list.length - 1)]);
  });
}

async function mount(tree: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<QueryClientProvider client={client!}>{tree}</QueryClientProvider>);
  });
  await settle();
}

function text() {
  return container?.textContent ?? "";
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container!.querySelectorAll("button"));
}

function button(label: string): HTMLButtonElement {
  const found = buttons().find((el) => (el.textContent ?? "").includes(label));
  if (!found) throw new Error(`没找到按钮：${label}`);
  return found;
}

async function click(label: string) {
  const el = button(label);
  await act(async () => {
    el.click();
  });
  await settle();
}

function inputByLabel(label: string): HTMLInputElement {
  const el = container!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!el) throw new Error(`没找到输入框：${label}`);
  return el;
}

/** React 受控 input 要用原生 setter + input 事件才会触发 onChange。 */
async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DocFactsPanel · 未确认 → 确认 → summary 变化", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  it("未确认项高亮、可全部确认，确认后统计立刻更新", async () => {
    routeGet({
      "/facts": [
        {
          doc_id: DOC_ID,
          doc_type: "pi",
          doc_no: "PI-1",
          status: "draft",
          items: [
            {
              key: "doc_no",
              value: "PI-1",
              trust: "confirmed",
              source: "payload",
              immutable: true,
              text_zh: null,
              text_en: null,
              confirmed_by: "1",
              confirmed_at: "2026-10-20T01:00:00Z",
              evidence_ref: null,
              currency: null,
            },
            {
              key: "payment_terms",
              value: "30% T/T 预付",
              trust: "unverified",
              source: "parsed:payment_terms",
              immutable: true,
              text_zh: "30% T/T 预付",
              text_en: "30% T/T in advance",
              confirmed_by: null,
              confirmed_at: null,
              evidence_ref: "合同第 5 条",
              currency: null,
            },
          ],
          summary: { total: 2, confirmed: 1, unverified: 1, inferred: 0 },
        },
        {
          doc_id: DOC_ID,
          doc_type: "pi",
          doc_no: "PI-1",
          status: "draft",
          items: [],
          summary: { total: 2, confirmed: 2, unverified: 0, inferred: 0 },
        },
      ],
    });
    vi.mocked(apiClient.post).mockResolvedValue(
      ok({ doc_id: DOC_ID, confirmed: ["payment_terms"], summary: {} }),
    );

    await mount(<DocFactsPanel docId={DOC_ID} status="draft" />);

    // 未确认项：计数 + 徽标 + 提示都要看得见（不是只有颜色）
    expect(text()).toContain("待确认 1");
    expect(text()).toContain("已确认 1");
    // 面板按后端返回的 `key` 原值展示（不含中文标签映射；label 由后端 FACT_LABELS 管）
    expect(text()).toContain("payment_terms");
    expect(text()).toContain("30% T/T 预付");
    expect(text()).toContain("未经人工核对");

    await click("全部确认");
    expect(apiClient.post).toHaveBeenCalledWith(
      `/trade-docs/${DOC_ID}/facts/confirm`,
      { keys: [] },
    );
    // 确认后重拉（invalidate）→ 统计刷新成"待确认 0"
    expect(text()).toContain("待确认 0");
    expect(toast.success).toHaveBeenCalled();
  });

  it("处置表单只给双语/证据/不可改写 —— value 不给编辑入口", async () => {
    routeGet({
      "/facts": [
        {
          doc_id: DOC_ID,
          doc_type: "pi",
          doc_no: "PI-1",
          status: "draft",
          items: [
            {
              key: "payment_terms",
              value: "30% T/T 预付",
              trust: "unverified",
              source: "parsed",
              immutable: false,
              text_zh: null,
              text_en: null,
              confirmed_by: null,
              confirmed_at: null,
              evidence_ref: null,
              currency: null,
            },
          ],
          summary: { total: 1, confirmed: 0, unverified: 1, inferred: 0 },
        },
      ],
    });

    await mount(<DocFactsPanel docId={DOC_ID} status="draft" />);
    await click("处置");

    expect(inputByLabel("中文表述")).toBeTruthy();
    expect(inputByLabel("英文表述")).toBeTruthy();
    expect(inputByLabel("证据引用")).toBeTruthy();
    // 后端 PATCH value 会 422 ⇒ UI 不能有 value 输入框，只能提示不可改
    expect(container!.querySelector('input[aria-label="值"]')).toBeNull();
    expect(text()).toContain("不可修改");
  });
});

describe("DocConsistencyPanel · 三档渲染 + 预检", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  it("冲突/等价措辞/缺失三档文案不同、可触发 lint 展示阻断", async () => {
    routeGet({
      "/consistency": [
        {
          ok: false,
          domain: { root: "order:9", doc_ids: ["1", "2"] },
          items: [
            {
              severity: "error",
              code: "FACT_CONFLICT",
              key: "total_amount",
              status: "conflict",
              baseline_doc: "1",
              values: { "1": "12300", "2": "9800" },
              detail: "单证 2 与基线取值不同",
            },
            {
              severity: "warning",
              code: "FACT_EQUIVALENT_WORDING",
              key: "payment_terms",
              status: "equivalent",
              baseline_doc: "1",
              values: { "1": "30% T/T 预付", "2": "30%T/T预付" },
              detail: "语义等价",
            },
            {
              severity: "error",
              code: "FACT_MISSING",
              key: "incoterm",
              status: "missing",
              baseline_doc: "1",
              values: { "1": "FOB Ningbo" },
              detail: "单证 2 没有承继不可改写事实",
            },
          ],
        },
      ],
    });
    vi.mocked(apiClient.post).mockResolvedValue(
      ok({
        doc_id: DOC_ID,
        ok: false,
        blocking: [
          {
            code: "FACT_UNVERIFIED",
            keys: ["payment_terms"],
            detail: "存在未确认事实：payment_terms",
          },
        ],
        warnings: [
          { code: "FACT_CONFLICT", key: "total_amount", detail: "合计不一致" },
        ],
        summary: { blocking: 1, warnings: 1, facts: { total: 2 } },
      }),
    );

    await mount(<DocConsistencyPanel docId={DOC_ID} />);

    expect(text()).toContain("冲突 1 / 等价 1 / 缺失 1");
    expect(text()).toContain("冲突");
    expect(text()).toContain("等价措辞");
    expect(text()).toContain("缺失");
    // 各方值都要显示（否则用户不知道差在哪）
    expect(text()).toContain("12300");
    expect(text()).toContain("9800");

    await click("签发前预检");
    expect(apiClient.post).toHaveBeenCalledWith(`/trade-docs/${DOC_ID}/lint`);
    expect(text()).toContain("1 项阻断");
    expect(text()).toContain("1 项提示");
    expect(text()).toContain("FACT_UNVERIFIED");
    expect(text()).toContain("合计不一致");
  });
});

describe("DocReceiptsPanel · 核销三档徽标 + 登记", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  function receipt(over: Record<string, unknown>) {
    return {
      id: 1,
      schedule_type: "deposit",
      schedule_amount: "1000",
      received_amount: "1000",
      currency: "USD",
      received_at: "2026-10-15T03:00:00Z",
      bank_ref: null,
      notes: null,
      diff: "0",
      diff_reason: "fx_rounding",
      fx_rate_used: null,
      status: "reconciled",
      created_by: "1",
      created_at: "2026-10-15T03:00:00Z",
      ...over,
    };
  }

  it("fx_rounding 绿 / short_paid 红 / manual 灰 三档文案都渲染", async () => {
    routeGet({
      "/receipts": [
        {
          doc_id: DOC_ID,
          total: 3,
          items: [
            receipt({ id: 1 }),
            receipt({
              id: 2,
              diff_reason: "short_paid",
              status: "short_paid",
              diff: "-610",
              received_amount: "8000",
              schedule_amount: "8610",
            }),
            receipt({
              id: 3,
              diff_reason: "manual",
              status: "manual",
              schedule_amount: null,
              schedule_type: null,
            }),
          ],
        },
      ],
    });

    await mount(<DocReceiptsPanel docId={DOC_ID} docCurrency="USD" />);

    expect(text()).toContain("汇率尾差·自动核销");
    expect(text()).toContain("短收挂账");
    expect(text()).toContain("手工登记");
    expect(text()).toContain("610");
  });

  it("登记收款提交后调用后端并展示 verdict 文案", async () => {
    routeGet({
      "/receipts": [{ doc_id: DOC_ID, total: 0, items: [] }],
    });
    vi.mocked(apiClient.post).mockResolvedValue(
      ok({
        doc_id: DOC_ID,
        item: receipt({ id: 9 }),
        verdict: {
          diff: "-0.01",
          tolerance: "0.05",
          auto_cleared: true,
          diff_reason: "fx_rounding",
        },
      }),
    );

    await mount(<DocReceiptsPanel docId={DOC_ID} docCurrency="USD" />);
    await click("登记收款");
    await type(inputByLabel("账期金额"), "1000");
    await type(inputByLabel("实收金额"), "999.99");
    await click("保存并核销");

    expect(apiClient.post).toHaveBeenCalledWith(
      `/trade-docs/${DOC_ID}/receipts`,
      expect.objectContaining({
        received_amount: "999.99",
        schedule_amount: "1000",
        currency: "USD",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("汇率尾差·自动核销"),
    );
  });
});

describe("DocSetPanel · 清单编辑与回执", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  const CO = {
    doc_type: "co",
    role: "not_by_us",
    issuer: "third_party:ccpit",
    trigger_expr: null,
    evidence_required: true,
    status: "pending",
    waived_reason: null,
    received_doc_id: null,
    received_at: null,
  };
  const PL = {
    doc_type: "pl",
    role: "required",
    issuer: "ours",
    trigger_expr: null,
    evidence_required: false,
    status: "pending",
    waived_reason: null,
    received_doc_id: null,
    received_at: null,
  };

  it("not_by_us 项有登记回执入口；保存清单走 PUT 全量替换", async () => {
    routeGet({ "/doc-set": [{ doc_id: DOC_ID, items: [PL, CO], total: 2 }] });
    vi.mocked(apiClient.post).mockResolvedValue(
      ok({ doc_id: DOC_ID, item: { ...CO, status: "received" } }),
    );
    vi.mocked(apiClient.put).mockResolvedValue(
      ok({ doc_id: DOC_ID, items: [PL, CO] }),
    );

    await mount(<DocSetPanel docId={DOC_ID} status="draft" />);
    expect(text()).toContain("对方出具（需回执）");
    expect(button("登记回执")).toBeTruthy();

    await click("登记回执");
    expect(apiClient.post).toHaveBeenCalledWith(
      `/trade-docs/${DOC_ID}/doc-set/co/receipt`,
      { action: "receive", waived_reason: null },
    );

    await click("编辑清单");
    await click("保存清单");
    expect(apiClient.put).toHaveBeenCalledWith(`/trade-docs/${DOC_ID}/doc-set`, {
      items: [
        { doc_type: "pl", role: "required", issuer: "ours", evidence_required: false },
        {
          doc_type: "co",
          role: "not_by_us",
          issuer: "third_party:ccpit",
          evidence_required: true,
        },
      ],
    });
  });

  it("豁免必须填原因：不填不发请求，填了才提交 waive", async () => {
    routeGet({ "/doc-set": [{ doc_id: DOC_ID, items: [CO], total: 1 }] });
    vi.mocked(apiClient.post).mockResolvedValue(
      ok({ doc_id: DOC_ID, item: { ...CO, status: "waived" } }),
    );

    await mount(<DocSetPanel docId={DOC_ID} status="draft" />);
    await click("豁免");
    await click("确认豁免");
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("豁免必须填写原因");

    await type(inputByLabel("豁免原因"), "客户自办产地证");
    await click("确认豁免");
    expect(apiClient.post).toHaveBeenCalledWith(
      `/trade-docs/${DOC_ID}/doc-set/co/receipt`,
      { action: "waive", waived_reason: "客户自办产地证" },
    );
  });
});

describe("签发闸门 · 422 阻断清单（不是只弹 toast）", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  const BLOCKED = {
    code: "FACT_UNVERIFIED",
    message: "签发前存在未确认事实",
    blocking: [
      {
        code: "FACT_UNVERIFIED",
        keys: ["payment_terms", "incoterm"],
        detail: "存在未确认事实：payment_terms、incoterm",
        evidence_ref: "合同第 5 条",
      },
      {
        code: "DOC_REF_BROKEN",
        doc_no: "PI-202610-0001",
        detail: "引用的单证不存在或未签发",
      },
    ],
  };

  it("逐条列出阻断项，并能跳到事实面板", async () => {
    const onGoToFacts = vi.fn();
    await mount(
      <DocConfirmGate blocked={BLOCKED} onGoToFacts={onGoToFacts} />,
    );

    expect(text()).toContain("签发被阻断");
    expect(text()).toContain("存在未确认事实");
    expect(text()).toContain("payment_terms、incoterm");
    expect(text()).toContain("合同第 5 条");
    expect(text()).toContain("DOC_REF_BROKEN");
    expect(text()).toContain("PI-202610-0001");

    await click("去确认事实");
    expect(onGoToFacts).toHaveBeenCalledTimes(1);
  });

  it("parseConfirmBlocked：认后端 422 的 detail.blocking，普通错误返回 null", () => {
    const gateError = {
      response: {
        status: 422,
        data: {
          detail: {
            error: "validation",
            code: "FACT_UNVERIFIED",
            detail: "签发前存在未确认事实",
            blocking: [{ code: "FACT_UNVERIFIED", keys: ["payment_terms"], detail: "x" }],
          },
        },
      },
    };
    const parsed = parseConfirmBlocked(gateError);
    expect(parsed?.code).toBe("FACT_UNVERIFIED");
    expect(parsed?.blocking).toHaveLength(1);
    expect(parsed?.blocking[0]?.keys).toEqual(["payment_terms"]);

    // 不是闸门（含网络错误 / 普通校验错误）⇒ null，调用方按原逻辑提示
    expect(parseConfirmBlocked({ response: { status: 500, data: {} } })).toBeNull();
    expect(
      parseConfirmBlocked({
        response: { status: 422, data: { detail: { code: "OTHER" } } },
      }),
    ).toBeNull();
    expect(parseConfirmBlocked(new Error("Network Error"))).toBeNull();
  });
});

function cleanup() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}
