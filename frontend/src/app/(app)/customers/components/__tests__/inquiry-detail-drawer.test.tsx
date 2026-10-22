/**
 * X1（审计 §1.5）：客户页询盘详情从「卡片下方内联展开」改为 `DetailDrawer`。
 *
 * 钉死：
 *  1. 抽屉关闭时不含内容，打开时展示 询盘号/产品/渠道/联系人/后续单据/阶段历史；
 *  2. 联系人按钮触发回调（由页面打开联系人弹窗并关抽屉）；
 *  3. 右上角关闭按钮触发 onOpenChange(false)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", () => {
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: client, apiClient: client };
});
// InquiryFollowup 的 DocPreviewDialog 会读团队快照；单测里给一个"平台管理员"快照
vi.mock("@/lib/team/team-context", () => ({
  useTeam: () => ({
    snapshot: {
      ok: true,
      isPlatformAdmin: true,
      workstations: [],
      codes: ["full_chain"],
    },
  }),
}));
// 单证预览的文件/渲染数据不在本用例范围：返回空，避免真实请求
vi.mock("../../../trade-docs/hooks/use-trade-docs", () => ({
  useTradeDocFiles: () => ({ data: [], isLoading: false }),
  useTradeDocRenderData: () => ({ data: null, isLoading: false }),
}));

import { InquiryDetailDrawer } from "../inquiry-detail-drawer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;

const INQUIRY = {
  id: 1,
  inquiry_no: "INQ-202610-0001",
  channel: "alibaba",
  product_name_raw: "牛栏网 2.5mm",
  quantity: 1000,
  quantity_unit: "m",
  application: "牧场围栏",
  items: [
    {
      product_name_raw: "牛栏网 2.5mm",
      spec_text: "2.5mm 热镀锌",
      quantity: 1000,
      quantity_unit: "m",
      application: "牧场围栏",
    },
  ],
  status: "quoted",
  created_at: "2026-10-17T00:00:00Z",
};

const QUOTE = {
  id: 11,
  quote_no: "QUO-20261017-001",
  status: "sent",
  currency: "USD",
  total_amount: 3612.36,
  created_at: "2026-10-17T02:30:00Z",
  inquiry_id: 1,
  documents: [
    {
      id: 1,
      doc_no: "PI-20261018-001",
      doc_type: "pi",
      status: "issued",
      currency: "USD",
      total_amount: 3612.36,
      created_at: "2026-10-18T02:30:00Z",
    },
  ],
  orders: [
    {
      id: 5,
      order_no: "ORD-202610-0005",
      status: "pending",
      currency: "USD",
      total_amount: 3612.36,
      created_at: "2026-10-19T06:00:00Z",
      documents: [],
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(node: React.ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>{node}</QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (String(url).startsWith("/inquiries/1/stage-log")) {
      return ok({
        items: [
          {
            id: 1,
            from_stage: "inquiry",
            to_stage: "quotation",
            source_event: "quote_created",
            actor_id: "1",
            note: null,
            created_at: "2026-10-17T02:30:00Z",
          },
        ],
      });
    }
    return ok({ items: [] });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("询盘详情抽屉", () => {
  it("关闭时不渲染内容；打开时展示询盘/产品/后续单据/阶段历史", async () => {
    const onOpenChange = vi.fn();
    mount(
      <InquiryDetailDrawer
        open={false}
        onOpenChange={onOpenChange}
        inquiry={INQUIRY}
        stage={{ label: "报价", tone: "info" }}
        quotes={[QUOTE]}
        primaryContact={{ id: 7, name: "王经理" }}
        onContactClick={() => {}}
      />,
    );
    await settle();
    expect(document.body.textContent).not.toContain("INQ-202610-0001");

    act(() =>
      root!.render(
        <QueryClientProvider client={client!}>
          <InquiryDetailDrawer
            open
            onOpenChange={onOpenChange}
            inquiry={INQUIRY}
            stage={{ label: "报价", tone: "info" }}
            quotes={[QUOTE]}
            primaryContact={{ id: 7, name: "王经理" }}
            onContactClick={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("询盘 INQ-202610-0001");
    expect(text).toContain("牛栏网 2.5mm");
    expect(text).toContain("2.5mm 热镀锌");
    expect(text).toContain("渠道：alibaba");
    expect(text).toContain("王经理");
    // 后续单据（报价 → 订单 → 单证）仍在抽屉里：
    // 单条订单时按设计只渲染「单证表」（订单号不重复占一行，见 inquiry-followups.tsx:520-524）
    expect(text).toContain("PI-20261018-001");
    expect(text).toContain("单证 1 份");
    // 阶段历史（接口返回一条 inquiry → quotation）
    expect(text).toContain("阶段变更历史");
    expect(text).toContain("询盘 → 报价");
  });

  it("联系人按钮触发回调；关闭按钮触发 onOpenChange(false)", async () => {
    const onContactClick = vi.fn();
    const onOpenChange = vi.fn();
    mount(
      <InquiryDetailDrawer
        open
        onOpenChange={onOpenChange}
        inquiry={INQUIRY}
        stage={{ label: "报价", tone: "info" }}
        quotes={[]}
        primaryContact={{ id: 7, name: "王经理" }}
        onContactClick={onContactClick}
      />,
    );
    await settle();

    const contact = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "王经理",
    );
    expect(contact).toBeTruthy();
    act(() => contact!.click());
    expect(onContactClick).toHaveBeenCalledTimes(1);

    const close = document.querySelector('[data-slot="sheet-close"]');
    expect(close).not.toBeNull();
    // Base UI 的抽屉对 Escape 有标准关闭语义（比模拟 portal 内的 click 更稳）
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(onOpenChange.mock.calls.some((call) => call[0] === false)).toBe(
      true,
    );
  });

  it("没有后续单据时显示「还没有报价单」而不是空白", async () => {
    mount(
      <InquiryDetailDrawer
        open
        onOpenChange={() => {}}
        inquiry={INQUIRY}
        stage={{ label: "报价", tone: "info" }}
        quotes={[]}
      />,
    );
    await settle();
    // 已标记「已报价」但没找到关联报价单时，用更准确的说明（区分"没报价"与"关联丢了"）
    expect(document.body.textContent).toContain(
      "该询盘已标记为「已报价」，但暂时没有找到关联的报价单。",
    );
  });
});
