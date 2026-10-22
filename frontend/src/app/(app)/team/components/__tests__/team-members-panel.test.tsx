/**
 * 团队成员面板（U-P0B5）：移除/转让从 window.confirm 换成共享 ConfirmDialog。
 *
 * 钉死"未确认不调用"：点行内按钮只打开弹窗，确认前绝不发请求；
 * 确认后才打对接口；失败原因留在弹窗里（原生 confirm 做不到）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { apiMock, toastMock, reloadMock, MEMBERS } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn() },
  reloadMock: vi.fn(),
  MEMBERS: [
    {
      user_id: 1,
      email: "me@example.com",
      display_name: "我",
      is_admin: true,
      console_access: true,
    },
    {
      user_id: 2,
      email: "li@example.com",
      display_name: "李四",
      is_admin: false,
      console_access: false,
    },
  ],
}));

vi.mock("@/lib/api/client", () => ({ default: apiMock }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("../../hooks/use-team-admin", () => ({
  useTeamMembers: () => ({
    items: MEMBERS,
    loading: false,
    error: null,
    reload: reloadMock,
  }),
}));

import { TeamMembersPanel } from "../team-members-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<TeamMembersPanel teamId={9} currentUserId={1} />);
  });
}

/**
 * 按精确文案找可点按钮（弹窗在 portal，查 document.body）。
 * 行内「移除」同时存在于管理员行（disabled）与普通成员行，优先取可点的那个。
 */
function findButton(
  label: string,
  scope: ParentNode = document.body,
): HTMLButtonElement {
  const candidates = Array.from(scope.querySelectorAll("button")).filter(
    (el) => (el.textContent ?? "").trim() === label,
  );
  const button = candidates.find((el) => !(el as HTMLButtonElement).disabled);
  if (!button) throw new Error(`没找到可点按钮「${label}」`);
  return button as HTMLButtonElement;
}

async function click(label: string, scope: ParentNode = document.body) {
  await act(async () => {
    findButton(label, scope).click();
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.delete.mockResolvedValue({});
  apiMock.post.mockResolvedValue({});
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("TeamMembersPanel 危险操作确认（U-P0B5）", () => {
  it("移除成员：未确认不调用，确认后打对接口并刷新", async () => {
    mount();

    await click("移除", container!);
    expect(apiMock.delete).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("把「李四」移出团队？");

    // 取消：不发请求，弹窗关闭
    await click("取消");
    expect(apiMock.delete).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("把「李四」移出团队？");

    // 再次打开并确认
    await click("移除", container!);
    await click("移除成员");

    expect(apiMock.delete).toHaveBeenCalledWith("/teams/9/members/2", {
      silent: true,
    });
    expect(toastMock.success).toHaveBeenCalledWith("已移除「李四」");
    expect(reloadMock).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("把「李四」移出团队？");
  });

  it("转让管理权：未确认不调用，确认后打对接口", async () => {
    mount();

    await click("转让", container!);
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("把团队管理权转让给「李四」？");

    await click("确认转让");
    expect(apiMock.post).toHaveBeenCalledWith(
      "/teams/9/transfer",
      { user_id: 2 },
      { silent: true },
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "已把团队管理权转让给「李四」",
    );
  });

  it("提交失败：原因留在弹窗里（不静默），弹窗保持可重试", async () => {
    apiMock.delete.mockRejectedValueOnce(new Error("boom"));
    mount();

    await click("移除", container!);
    await click("移除成员");

    expect(document.body.textContent).toContain("移除成员失败，请稍后重试");
    expect(toastMock.error).toHaveBeenCalledWith("移除成员失败，请稍后重试");
    // 弹窗仍开着（可重试），没有被误关
    expect(document.body.textContent).toContain("把「李四」移出团队？");
  });
});
