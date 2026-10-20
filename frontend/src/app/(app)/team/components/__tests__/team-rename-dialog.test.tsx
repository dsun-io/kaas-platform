/**
 * 团队改名弹窗（C36 #12）——PATCH 契约与错误透出。
 *
 * 钉住：只提交改名；同名不可提交；409 TEAM_NAME_TAKEN 用中文码表文案展示；
 * 成功后回调刷新团队上下文。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TeamRenameDialog } from "../team-rename-dialog";

const mocks = vi.hoisted(() => ({ patch: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { patch: mocks.patch },
  apiClient: { patch: mocks.patch },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

async function settle(times = 5) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setValue(value: string) {
  const input = document.querySelector<HTMLInputElement>("#team-rename-input");
  if (!input) throw new Error("没找到改名输入框");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("TeamRenameDialog", () => {
  it("提交 PATCH /teams/{id} {name}，成功后回调刷新", async () => {
    mocks.patch.mockResolvedValue({ data: { id: 7, name: "联佳外贸组" } });
    const onRenamed = vi.fn();
    const onOpenChange = vi.fn();
    mount(
      <TeamRenameDialog
        open
        onOpenChange={onOpenChange}
        teamId={7}
        currentName="联佳团队"
        onRenamed={onRenamed}
      />,
    );

    // 名称没变时保存按钮不可用
    const save = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "保存名称",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    setValue("联佳外贸组");
    clickButton("保存名称");
    await settle();

    expect(mocks.patch).toHaveBeenCalledWith(
      "/teams/7",
      { name: "联佳外贸组" },
      { silent: true },
    );
    expect(toastSuccess).toHaveBeenCalledWith("团队名称已更新");
    expect(onRenamed).toHaveBeenCalledWith("联佳外贸组");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("409 TEAM_NAME_TAKEN 用中文码表文案展示，弹窗不关闭", async () => {
    mocks.patch.mockRejectedValue(
      Object.assign(new Error("Conflict"), {
        response: {
          status: 409,
          data: {
            detail: {
              error: "conflict",
              code: "TEAM_NAME_TAKEN",
              message: "已存在同名团队「联佳外贸组」",
            },
          },
        },
      }),
    );
    const onOpenChange = vi.fn();
    mount(
      <TeamRenameDialog
        open
        onOpenChange={onOpenChange}
        teamId={7}
        currentName="联佳团队"
      />,
    );

    setValue("联佳外贸组");
    clickButton("保存名称");
    await settle();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "已存在同名团队「联佳外贸组」",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
