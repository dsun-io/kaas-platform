/**
 * 邮件外联（/outreach）—— P0-B1 危险操作止血回归。
 *
 * 钉住三件事：
 * 1. 批量群发**未确认不发请求**；确认后才 POST　/outreach/campaigns/{id}/send；
 * 2. 提交中连点（同一 tick 两次 click）只发一次请求；
 * 3. 测试邮件收件人从 `window.prompt` 改为弹窗（不再调用 prompt），同样带防重。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { get: mocks.get, post: mocks.post, patch: mocks.patch };
  return { default: client, apiClient: client };
});
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

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
const LEAD = {
  id: 5,
  company_name: "德克萨斯围栏公司",
  city: "Houston",
  country: "US",
  email: "buyer@example.com",
  outreach_status: "new",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 6) {
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
        `等待超时：${label}（当前页面文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
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
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>
        <OutreachPage />
      </QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
}

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button"));
}

function findButton(text: string, exact = false): HTMLButtonElement {
  const button = buttons().find((b) => {
    const label = (b.textContent ?? "").trim();
    return exact ? label === text : label.includes(text);
  });
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

async function click(text: string, exact = false) {
  await act(async () => {
    findButton(text, exact).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
  await settle(2);
}

/** 同一个 act 内连点两次：模拟"按钮还没变 disabled 时的重复点击"。 */
async function doubleClick(text: string) {
  await act(async () => {
    const button = findButton(text);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

function clickCheckboxIn(labelText: string) {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    (l.textContent ?? "").includes(labelText),
  );
  const box = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`没找到「${labelText}」的复选框`);
  act(() => box.click());
}

function setInputByPlaceholder(placeholder: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  );
  if (!el) throw new Error(`没找到输入框 placeholder=${placeholder}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function postCalls(url: string) {
  return mocks.post.mock.calls.filter((call) => String(call[0]) === url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (url === "/outreach/mailboxes") return { data: { items: [MAILBOX] } };
    if (url === "/outreach/campaigns") return { data: { items: [CAMPAIGN] } };
    if (String(url).startsWith("/outreach/messages"))
      return { data: { items: [] } };
    if (String(url).startsWith("/leads")) return { data: { items: [LEAD] } };
    return { data: { items: [] } };
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("邮件外联 · 批量群发二次确认", () => {
  it("未确认不调用发送 API；确认后只发一次", async () => {
    mocks.post.mockResolvedValue({
      data: { total: 1, sent: 1, failed: 0 },
    });
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("秋季推广"),
      undefined,
      "活动列表加载",
    );

    await click("发送…");
    await waitFor(
      () => (document.body.textContent ?? "").includes(LEAD.company_name),
      undefined,
      "潜在客户列表加载",
    );
    clickCheckboxIn(LEAD.company_name);
    await settle();
    await click("发送给 1 个潜在客户");

    // 弹窗出现，但请求还没发
    expect(document.body.textContent).toContain("向 1 个潜在客户群发邮件？");
    expect(postCalls("/outreach/campaigns/9/send")).toHaveLength(0);

    await click("确认发送");
    await waitFor(
      () => postCalls("/outreach/campaigns/9/send").length > 0,
      undefined,
      "发送请求",
    );
    expect(postCalls("/outreach/campaigns/9/send")).toHaveLength(1);
    expect(mocks.post.mock.calls[0]).toEqual([
      "/outreach/campaigns/9/send",
      { lead_ids: [5] },
    ]);
  });

  it("提交中连点两次只发一次请求（pending 防重）", async () => {
    // 永不 resolve：保持在 pending 态
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("秋季推广"),
      undefined,
      "活动列表加载",
    );
    await click("发送…");
    await waitFor(
      () => (document.body.textContent ?? "").includes(LEAD.company_name),
      undefined,
      "潜在客户加载",
    );
    clickCheckboxIn(LEAD.company_name);
    await settle();
    await click("发送给 1 个潜在客户");
    await doubleClick("确认发送");
    await settle();

    expect(postCalls("/outreach/campaigns/9/send")).toHaveLength(1);
    // 弹窗仍在 pending（按钮文案变成"提交中…"）
    expect(document.body.textContent).toContain("提交中…");
  });
});

describe("邮件外联 · AI 起草 pending 防重（P0-B4）", () => {
  it("起草中连点两次只发一次请求", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("秋季推广"),
      undefined,
      "活动列表加载",
    );

    await doubleClick("AI 起草");
    await settle();

    expect(postCalls("/outreach/generate")).toHaveLength(1);
    expect(document.body.textContent).toContain("起草中…");
  });
});

describe("邮件外联 · 测试邮件收件人弹窗（替代 window.prompt）", () => {
  it("不再调用 window.prompt；未确认不发请求，确认后只发一次", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("x@y.com");
    mocks.post.mockResolvedValue({ data: { status: "sent" } });
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(MAILBOX.email),
      undefined,
      "邮箱列表加载",
    );

    await click("测试");
    expect(promptSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("发送测试邮件");
    expect(mocks.post).toHaveBeenCalledTimes(0);

    setInputByPlaceholder("name@example.com", "qa@example.com");
    await settle(2);
    await click("发送测试");

    await waitFor(
      () =>
        postCalls("/outreach/mailboxes/1/test?to=qa%40example.com").length > 0,
      undefined,
      "测试邮件请求",
    );
    expect(
      postCalls("/outreach/mailboxes/1/test?to=qa%40example.com"),
    ).toHaveLength(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("测试邮件已发送");
  });

  it("测试邮件提交中连点两次只发一次请求", async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(MAILBOX.email),
      undefined,
      "邮箱列表加载",
    );
    await click("测试");
    setInputByPlaceholder("name@example.com", "qa@example.com");
    await settle(2);
    await doubleClick("发送测试");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("发送中…");
  });
});
describe("邮件外联 · 设为默认发件人（P0-B2/O35-O40）", () => {
  const SECOND_MAILBOX = {
    id: 2,
    email: "ops@kaas.example",
    name: "运营邮箱",
    api_key_masked: null,
    has_own_key: false,
    is_default: false,
    daily_limit: null,
    sent_today: 0,
    enabled: true,
  };

  beforeEach(() => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/outreach/mailboxes")
        return { data: { items: [MAILBOX, SECOND_MAILBOX] } };
      if (url === "/outreach/campaigns") return { data: { items: [CAMPAIGN] } };
      if (String(url).startsWith("/outreach/messages"))
        return { data: { items: [] } };
      if (String(url).startsWith("/leads")) return { data: { items: [LEAD] } };
      return { data: { items: [] } };
    });
  });

  it("设为默认失败 → 页内显示原因", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "TEAM_ADMIN_REQUIRED",
              message: "仅团队管理员可切换默认发件邮箱",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(SECOND_MAILBOX.email),
      undefined,
      "邮箱列表加载",
    );
    await click("设为默认");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("设为默认失败");
    expect(alert?.textContent).toContain("仅团队管理员可切换默认发件邮箱");
    expect(mocks.patch).toHaveBeenCalledWith("/outreach/mailboxes/2", {
      is_default: true,
    });
  });

  it("pending 期间不重复提交", async () => {
    mocks.patch.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes(SECOND_MAILBOX.email),
      undefined,
      "邮箱列表加载",
    );
    await click("设为默认");
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    const pending = findButton("设置中…");
    expect(pending.disabled).toBe(true);
    await click("设置中…");
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
});
