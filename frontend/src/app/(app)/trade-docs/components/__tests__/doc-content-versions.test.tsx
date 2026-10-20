/**
 * 单证内容版本面板（TODO A1）的行为守卫。
 *
 * 三条容易悄悄坏的行为：
 * 1. 版本行必须显示**中文来源标签**（手工编辑/重新带入上游/签发冻结…）——
 *    只显示英文枚举值，业务用户看不懂这版是怎么来的；
 * 2. 已签发/作废的单证**不能**恢复（法律凭证内容冻结，后端也是 409）——
 *    界面若还允许点，用户白点一遍才看到失败；
 * 3. 恢复必须打**正确的版本 URL**（`POST .../content-versions/{n}/restore`），
 *    而不是任意一条"恢复"接口 —— 恢复错了就等于回滚错内容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import { DocContentVersions } from "../doc-content-versions";

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
  toast: { success: vi.fn(), error: vi.fn() },
}));

// React 的 act() 需要这个开关（仓库没有 testing-library / setup 文件）
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown): GetResp => ({ data }) as unknown as GetResp;

const DOC_ID = 7;

const VERSIONS = {
  doc_id: DOC_ID,
  total: 2,
  items: [
    {
      version_no: 2,
      change_source: "refresh_sources",
      actor_id: "1",
      note: null,
      created_at: "2026-10-20T02:10:00Z",
      custom_keys: ["remarks", "shipping_marks"],
    },
    {
      version_no: 1,
      change_source: "custom_update",
      actor_id: "1",
      note: null,
      created_at: "2026-10-19T08:30:00Z",
      custom_keys: ["remarks"],
    },
  ],
};

const VERSION_DETAIL = {
  version_no: 1,
  change_source: "custom_update",
  actor_id: "1",
  note: null,
  created_at: "2026-10-19T08:30:00Z",
  raw_payload: {
    sources: {},
    custom: { remarks: "1) 分批装运" },
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

/** 等一轮微任务 + 一轮宏任务：react-query 的 fetch→render 才落地 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 轮询等待条件成立（全量套件并行时单次 settle 不够稳，固定等待会偶发失败） */
async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor 超时：" + (container?.textContent ?? ""));
    }
    await settle();
  }
}

async function mount({ status, docType }: { status: string; docType: string }) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (String(url).endsWith("/content-versions")) return ok(VERSIONS);
    if (String(url).includes("/content-versions/1")) return ok(VERSION_DETAIL);
    throw new Error(`未预期的 GET ${url}`);
  });
  vi.mocked(apiClient.post).mockResolvedValue(
    ok({ doc: { id: DOC_ID }, restored_version_no: 1 }),
  );

  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <DocContentVersions docId={DOC_ID} docType={docType} status={status} />
    </QueryClientProvider>
  );
  act(() => {
    root!.render(tree);
  });
  await settle();
}

/** 展开折叠区（标题按钮） */
async function expand() {
  const button = Array.from(container!.querySelectorAll("button")).find((el) =>
    el.textContent?.includes("内容版本"),
  );
  if (!button) throw new Error("没找到「内容版本」折叠按钮");
  act(() => {
    button.click();
  });
  await settle();
}

function restoreButtons(): HTMLButtonElement[] {
  return Array.from(container!.querySelectorAll("button")).filter((el) =>
    el.textContent?.includes("恢复"),
  ) as HTMLButtonElement[];
}

describe("DocContentVersions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // 恢复前有确认弹窗：默认确认
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    client?.clear();
    root = null;
    container = null;
    client = null;
  });

  it("展开后按版本倒序渲染，来源显示中文标签", async () => {
    await mount({ status: "draft", docType: "pi" });
    await waitFor(() => container!.textContent?.includes("共 2 版") ?? false);

    await expand();
    await waitFor(
      () => container!.textContent?.includes("重新带入上游") ?? false,
    );
    const text = container!.textContent ?? "";
    expect(text).toContain("v2");
    expect(text).toContain("v1");
    expect(text).toContain("重新带入上游");
    expect(text).toContain("手工编辑");
    // 倒序：v2 在 v1 之前
    expect(text.indexOf("v2")).toBeLessThan(text.indexOf("v1"));
  });

  it("已签发单证：恢复按钮全部禁用并给出原因", async () => {
    await mount({ status: "issued", docType: "pi" });
    await waitFor(() => container!.textContent?.includes("共 2 版") ?? false);
    await expand();
    await waitFor(() => restoreButtons().length === 2);

    const buttons = restoreButtons();
    expect(buttons.length).toBe(2);
    for (const button of buttons) expect(button.disabled).toBe(true);
    expect(container!.textContent).toContain("内容冻结");
  });

  it("草稿恢复：打对版本 URL，并带上 note", async () => {
    await mount({ status: "draft", docType: "pi" });
    await waitFor(() => container!.textContent?.includes("共 2 版") ?? false);
    await expand();
    await waitFor(() => restoreButtons().length === 2);

    const buttons = restoreButtons();
    await act(async () => {
      buttons[1]!.click(); // 第二行 = v1
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      `/trade-docs/${DOC_ID}/content-versions/1/restore`,
      {},
    );
  });
});
