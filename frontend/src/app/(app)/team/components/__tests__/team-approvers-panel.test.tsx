/**
 * 团队页「审批设置」：读名单回填 / 多选 / 整表保存 / 空名单=管理员审批。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

const toastSuccess = vi.fn();
const toastError = vi.fn();

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
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: vi.fn(),
  },
}));

import { TeamApproversPanel } from "../team-approvers-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
type PutResp = Awaited<ReturnType<typeof apiClient.put>>;
const okGet = (data: unknown) => ({ data }) as unknown as GetResp;
const okPut = (data: unknown) => ({ data }) as unknown as PutResp;

const MEMBERS = [
  {
    user_id: 1,
    display_name: "管理员甲",
    email: "a@example.com",
    role: "admin",
    is_admin: true,
    console_access: false,
  },
  {
    user_id: 2,
    display_name: "张三",
    email: "z@example.com",
    role: "admin",
    is_admin: true,
    console_access: false,
  },
  {
    user_id: 3,
    display_name: "李四",
    email: "l@example.com",
    role: "user",
    is_admin: false,
    console_access: false,
  },
];

function approvers(items: number[], fallback = "team_admins") {
  return {
    team_id: 1,
    items: items.map((userId) => ({
      user_id: userId,
      display_name:
        MEMBERS.find((m) => m.user_id === userId)?.display_name ?? null,
      email: MEMBERS.find((m) => m.user_id === userId)?.email ?? null,
      created_by: 1,
      created_at: "2026-10-22T10:00:00+08:00",
    })),
    fallback,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function checkbox(label: string): HTMLInputElement {
  const input = document.querySelector(
    `input[aria-label="把 ${label} 设为指定审批人"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error(`没找到「${label}」的勾选框`);
  return input;
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").trim().includes(label),
  );
  if (!button) throw new Error(`没找到按钮「${label}」`);
  return button;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function mount() {
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
        <TeamApproversPanel teamId={1} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  vi.resetAllMocks();
  toastSuccess.mockClear();
  toastError.mockClear();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path === "/teams/1/members") {
      return okGet({
        items: MEMBERS,
        total: MEMBERS.length,
        page: 1,
        page_size: 100,
      });
    }
    if (path === "/team/approvers") return okGet(approvers([2]));
    return okGet({ items: [], total: 0, page: 1, page_size: 20 });
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

describe("团队审批设置", () => {
  it("回填已保存名单，并说明空名单回退规则", async () => {
    await mount();
    expect(checkbox("张三").checked).toBe(true);
    expect(checkbox("李四").checked).toBe(false);
    const text = container!.textContent ?? "";
    expect(text).toContain("审批设置");
    expect(text).toContain("未指定审批人时：由团队管理员审批");
    // 未修改时保存按钮禁用（不能重复提交同一份名单）
    expect(buttonByText("保存审批设置").disabled).toBe(true);
  });

  it("多选后保存：PUT /team/approvers user_ids 升序去重，成功 toast", async () => {
    vi.mocked(apiClient.put).mockResolvedValue(okPut(approvers([2, 3])));
    await mount();

    click(checkbox("李四"));
    await settle();
    const save = buttonByText("保存审批设置");
    expect(save.disabled).toBe(false);
    click(save);
    await settle(6);

    expect(vi.mocked(apiClient.put)).toHaveBeenCalledWith(
      "/team/approvers",
      { user_ids: [2, 3] },
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("2 名指定审批人"),
    );
  });

  it("清空名单 = 管理员审批：PUT user_ids: [] 并给出明确提示", async () => {
    vi.mocked(apiClient.put).mockResolvedValue(okPut(approvers([])));
    await mount();

    click(checkbox("张三")); // 取消唯一指定审批人
    await settle();
    click(buttonByText("保存审批设置"));
    await settle(6);

    expect(vi.mocked(apiClient.put)).toHaveBeenCalledWith(
      "/team/approvers",
      { user_ids: [] },
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("团队管理员审批"),
    );
  });

  it("保存失败：把后端中文原因原样显示，并弹错误 toast", async () => {
    vi.mocked(apiClient.put).mockRejectedValue(
      Object.assign(new Error("Validation"), {
        response: {
          status: 422,
          data: {
            detail: {
              error: "validation",
              code: "APPROVER_NOT_IN_TEAM",
              detail: "指定审批人必须是本团队成员",
            },
          },
        },
      }),
    );
    await mount();

    click(checkbox("李四"));
    await settle();
    click(buttonByText("保存审批设置"));
    await settle(6);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("指定审批人必须是本团队成员");
  });
});
