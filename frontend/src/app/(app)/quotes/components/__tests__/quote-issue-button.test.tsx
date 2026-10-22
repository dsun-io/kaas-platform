/**
 * 签发报价单（P0-B1 / 审计 Q2）—— 二次确认 + 防重复 PATCH 回归。
 *
 * 为什么钉这么死：签发 = draft→sent，后端会向报价台账入账一条，签发后是法律凭证。
 * 点一下即生效 + 连点两次 PATCH = 台账多一条，这不是"重复提交"，是账目错。
 *
 * 钉住：
 * 1. 点「签发」只开确认弹窗，**不发 PATCH**；确认后才 PATCH status=sent；
 * 2. 提交中连点两次只发一次 PATCH；
 * 3. 失败原因显示在弹窗里且弹窗不关；
 * 4. 非 draft / 未保存时按钮禁用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { patch: mocks.patch };
  return { default: client, apiClient: client };
});

import { QuoteIssueButton } from "../quote-issue-button";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUED = {
  id: 7,
  quote_no: "QUO-202610-0007",
  status: "sent",
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
        `等待超时：${label}（当前文本：${document.body.textContent?.slice(0, 400) ?? ""}）`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function mount(element: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
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
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

async function doubleClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("QuoteIssueButton", () => {
  it("未确认不发 PATCH；确认后 PATCH status=sent 一次并回调", async () => {
    mocks.patch.mockResolvedValue({ data: ISSUED });
    const onIssued = vi.fn();
    mount(
      <QuoteIssueButton
        quoteOrderId={7}
        quoteNo="QUO-202610-0007"
        status="draft"
        onIssued={onIssued}
      />,
    );

    await click(findButton("签发报价单"));
    expect(document.body.textContent).toContain("签发报价单 QUO-202610-0007？");
    expect(mocks.patch).not.toHaveBeenCalled();

    await click(findButton("确认签发"));
    await waitFor(() => mocks.patch.mock.calls.length > 0, undefined, "PATCH");

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith("/quotes/7", { status: "sent" });
    expect(onIssued).toHaveBeenCalledWith(ISSUED);
    // 成功后弹窗关闭
    expect(document.body.textContent).not.toContain("确认签发");
  });

  it("提交中连点两次只发一次 PATCH（pending 防重）", async () => {
    mocks.patch.mockImplementation(() => new Promise(() => {}));
    mount(
      <QuoteIssueButton
        quoteOrderId={7}
        quoteNo="QUO-202610-0007"
        status="draft"
      />,
    );

    await click(findButton("签发报价单"));
    await doubleClick(findButton("确认签发"));
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("提交中…");
  });

  it("PATCH 失败时错误显示在弹窗里且弹窗不关", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "QUOTE_DOWNSTREAM_LOCKED",
              message: "该报价已生成单证，不能回退状态",
            },
          },
        },
      }),
    );
    mount(
      <QuoteIssueButton
        quoteOrderId={7}
        quoteNo="QUO-202610-0007"
        status="draft"
      />,
    );

    await click(findButton("签发报价单"));
    await click(findButton("确认签发"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("该报价已生成单证，不能回退状态");
    expect(document.body.textContent).toContain("确认签发");
  });

  it("未保存（id=null）或非 draft 时签发按钮禁用", async () => {
    mount(
      <QuoteIssueButton quoteOrderId={null} quoteNo={null} status={null} />,
    );
    expect(findButton("签发报价单").disabled).toBe(true);
    unmount();

    mount(
      <QuoteIssueButton
        quoteOrderId={7}
        quoteNo="QUO-202610-0007"
        status="sent"
      />,
    );
    expect(findButton("签发报价单").disabled).toBe(true);
  });
});
