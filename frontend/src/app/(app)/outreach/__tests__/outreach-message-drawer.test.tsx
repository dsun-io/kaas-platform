/**
 * X3（审计 §1.5）：外联「消息记录」的邮件正文从表格下方**内联块**改为右侧 DetailDrawer。
 *
 * 钉死：
 *  1. 点「查看」→ 抽屉里显示收件人/状态/正文（数据来源不变：/outreach/messages）；
 *  2. 关闭后正文不再停留在页面里（内联块的旧行为）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { get: mocks.get, post: mocks.post, patch: mocks.patch };
  return { default: client, apiClient: client };
});
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import OutreachPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MAILBOX = {
  id: 1,
  email: "sales@kaas.example",
  name: null,
  api_key_masked: null,
  has_own_key: true,
  is_default: true,
  daily_limit: null,
  sent_today: 0,
  enabled: true,
};
const CAMPAIGN = {
  id: 9,
  name: "秋季推广",
  subject_template: "hi {{name}}",
  body_template: "body",
  status: "draft",
  total_count: 0,
  sent_count: 0,
  failed_count: 0,
  created_at: "2026-10-01T00:00:00Z",
};
const MESSAGE = {
  id: 21,
  campaign_id: 9,
  lead_id: 5,
  to_email: "buyer@example.com",
  to_name: "王经理",
  subject: "秋季报价",
  body_rendered: "尊敬的王经理：附件是 FOB 报价，请查收。",
  status: "sent",
  error: null,
  sent_at: "2026-10-20T01:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, timeout = 5000, label = "条件") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `等待超时：${label}（页面文本：${document.body.textContent?.slice(0, 300) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function mount() {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={client!}>
        <OutreachPage />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/outreach/mailboxes") return { data: { items: [MAILBOX] } };
    if (path === "/outreach/campaigns") return { data: { items: [CAMPAIGN] } };
    // 列表 vs 单条详情：点「查看」时页面会再取一次 /outreach/messages/{id}
    if (path === `/outreach/messages/${MESSAGE.id}`) return { data: MESSAGE };
    if (path.startsWith("/outreach/messages")) {
      return { data: { items: [MESSAGE] } };
    }
    return { data: { items: [] } };
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

describe("邮件详情抽屉", () => {
  it("点「查看」在抽屉里显示正文；关闭后正文不再停留", async () => {
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("秋季报价"),
      undefined,
      "消息列表加载",
    );

    const view = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "查看",
    );
    expect(view).toBeTruthy();
    act(() => view!.click());
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("邮件正文（渲染后）");
    expect(text).toContain("尊敬的王经理：附件是 FOB 报价，请查收。");
    expect(text).toContain("收件人：王经理 <buyer@example.com>");

    const close = document.querySelector('[data-slot="sheet-close"]');
    expect(close).not.toBeNull();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    expect(document.body.textContent).not.toContain(
      "尊敬的王经理：附件是 FOB 报价，请查收。",
    );
  });
});
