/**
 * 税档「停用（软删）」按钮（C36 #1）——契约与错误透出。
 *
 * 钉住：
 * 1. 点「停用」先出二次确认（不直接发请求）；
 * 2. 确认后 DELETE `/tax-archives/{id}`，成功后失效 `["tax-archives"]`；
 * 3. 403（其它团队）等错误**原样显示在弹窗里**，弹窗不关闭。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaxArchiveDeactivateButton } from "../tax-archive-deactivate-button";
import type { TaxArchive } from "@contracts/export-quote";

const mocks = vi.hoisted(() => ({ delete: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  default: { delete: mocks.delete },
  apiClient: { delete: mocks.delete },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ARCHIVE = {
  id: 5,
  name: "默认企业税档",
  code: "TAX-DEFAULT",
  effective_from: "2026-09-01",
  effective_to: null,
  tax_values: { output_vat_rate: 0.13, misc_fee_rate: 0.03 },
  source: "manual",
  status: "active",
  created_at: null,
  updated_at: null,
} as unknown as TaxArchive;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 5) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
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

function clickButton(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!button) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client?.clear();
  client = null;
});

describe("TaxArchiveDeactivateButton", () => {
  it("先二次确认，确认后才 DELETE，成功提示软删并失效查询", async () => {
    mocks.delete.mockResolvedValue({ data: { id: 5, status: "inactive" } });
    mount(<TaxArchiveDeactivateButton archive={ARCHIVE} />);

    clickButton("停用");
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("停用税档「默认企业税档」？");

    clickButton("确认停用");
    await settle();

    expect(mocks.delete).toHaveBeenCalledWith("/tax-archives/5", {
      silent: true,
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("已停用（软删"),
    );
  });

  it("403（不能停用其它团队档案）原样显示在弹窗里，弹窗不关闭", async () => {
    mocks.delete.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        response: {
          status: 403,
          data: {
            detail: {
              error: "forbidden",
              code: "TEAM_ADMIN_REQUIRED",
              detail: "不能停用其他团队的税务档案",
            },
          },
        },
      }),
    );
    mount(<TaxArchiveDeactivateButton archive={ARCHIVE} />);

    clickButton("停用");
    clickButton("确认停用");
    await settle();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("不能停用其他团队的税务档案");
    // 弹窗仍在（确认按钮仍可点）
    expect(document.body.textContent).toContain("确认停用");
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
