/**
 * 属性提案审核（/admin/spec-proposals）—— P0-B2/SP1：审批/驳回/合并失败反馈 + pending。
 *
 * 旧行为：review mutation 无 onError —— 三个动作失败完全静默。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api/client", () => {
  const client = { get: mocks.get, patch: mocks.patch, post: vi.fn() };
  return { default: client, apiClient: client };
});
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), info: vi.fn() },
}));

import SpecProposalsPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROPOSAL = {
  id: 21,
  tenant_id: "default",
  category_id: 3,
  proposed_name: "镀锌层厚度",
  proposed_type: "number",
  group_code: "spec",
  status: "pending",
  occurrence_count: 4,
  recommended_for_promotion: true,
  recommendation_score: 0.87,
  created_at: "2026-10-01T00:00:00Z",
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
        <SpecProposalsPage />
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

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  return button;
}

/** 行内动作按钮（「晋升」不能被 tab 的「推荐晋升 (1)」抢先匹配）。 */
function findExactButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: { items: [PROPOSAL] } });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe("属性提案审核 · 审批动作", () => {
  it("审批失败 → 弹窗内显示后端原因，弹窗不关", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "PROPOSAL_ALREADY_REVIEWED",
              message: "该提案已被其他人处理",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("镀锌层厚度"),
      undefined,
      "提案列表加载",
    );
    await click(findExactButton("晋升"));
    await waitFor(
      () => (document.body.textContent ?? "").includes("确认晋升"),
      undefined,
      "审核弹窗",
    );
    await click(findButton("确认晋升"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("操作失败");
    expect(alert?.textContent).toContain("该提案已被其他人处理");
    expect(document.body.textContent).toContain("确认晋升");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("pending 期间不重复提交（确认/取消都禁用）", async () => {
    mocks.patch.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("镀锌层厚度"),
      undefined,
      "提案列表加载",
    );
    await click(findExactButton("晋升"));
    await click(findButton("确认晋升"));
    await settle();

    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.calls[0]![0]).toBe(
      "/admin/spec/attribute-proposals/21",
    );
    const pendingButton = findButton("处理中...");
    expect(pendingButton.disabled).toBe(true);
    expect(findButton("取消").disabled).toBe(true);
    await click(pendingButton);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });

  it("驳回失败同样有出口（action=reject 走同一 review 动作）", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("NotFound"), {
        response: {
          status: 404,
          data: {
            detail: {
              error: "not_found",
              code: "PROPOSAL_NOT_FOUND",
              message: "提案不存在或已删除",
            },
          },
        },
      }),
    );
    mount();
    await waitFor(
      () => (document.body.textContent ?? "").includes("镀锌层厚度"),
      undefined,
      "提案列表加载",
    );
    await click(findExactButton("驳回"));
    await click(findButton("确认驳回"));
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("提案不存在或已删除");
    expect(mocks.patch.mock.calls[0]![1]).toMatchObject({
      action: "reject",
    });
  });
});
