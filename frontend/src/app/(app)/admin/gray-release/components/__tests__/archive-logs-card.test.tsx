import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

// 这个 hook 用具名导入（`import { apiClient }`），只 mock default 会拿不到 client
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

import { ArchiveLogsCard } from "../archive-logs-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown) => ({ data }) as unknown as GetResp;
const PAGE_SIZE = 20;

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

function entry(month: string, path: string, archivedAt: string) {
  return {
    id: `arch-${month}`,
    month,
    path,
    status: "archived",
    archived_at: archivedAt,
  };
}

function archiveCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url) === "/admin/archive-logs");
}

function lastParams() {
  const calls = archiveCalls();
  const config = calls[calls.length - 1]?.[1] as
    | { params?: { page?: number; page_size?: number; month?: string } }
    | undefined;
  return config?.params;
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <ArchiveLogsCard />
    </QueryClientProvider>
  );
  act(() => root!.render(tree));
  await settle();
}

function button(label: string) {
  return Array.from(container!.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("ArchiveLogsCard（C30 事件归档记录）", () => {
  it("没有记录时显示空态并说明「每月自动归档上月事件」，不是报错", async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      ok({ items: [], total: 0, page: 1, page_size: PAGE_SIZE }),
    );

    await mount();

    expect(archiveCalls()).toHaveLength(1);
    expect(lastParams()).toMatchObject({ page: 1, page_size: PAGE_SIZE });
    expect(container!.textContent).toContain("暂无归档记录");
    expect(container!.textContent).toContain("每月自动归档上月事件");
    // 空列表不渲染分页条（一页装得下）
    expect(container!.querySelector("nav")).toBeNull();
  });

  it("有记录时展示 month / status / archived_at；归档文件位置默认折叠，点「查看详情」才出现", async () => {
    vi.mocked(apiClient.get).mockResolvedValue(
      ok({
        items: [
          entry(
            "2026-09",
            "kaas-events-archive/events-archive/2026/09/01/v1.jsonl.gz",
            "2026-10-01T02:00:05Z",
          ),
          entry(
            "2026-08",
            "kaas-events-archive/events-archive/2026/08/01/v1.jsonl.gz",
            "2026-09-01T02:00:03Z",
          ),
        ],
        total: 42,
        page: 1,
        page_size: PAGE_SIZE,
      }),
    );

    await mount();

    const text = container!.textContent ?? "";
    expect(text).toContain("2026-09");
    expect(text).toContain("archived");
    expect(text).toContain("2026"); // archived_at 已格式化，不吞成空
    expect(text).toContain("共 42 条");
    // 归档文件位置是内部存储路径：默认只给「查看详情（一般不需要看）」，不直接铺在表格里
    expect(text).toContain("查看详情（一般不需要看）");
    expect(text).not.toContain(
      "kaas-events-archive/events-archive/2026/09/01/v1.jsonl.gz",
    );
    await act(async () => {
      button("查看详情（一般不需要看）")!.click();
    });
    expect(container!.textContent).toContain(
      "kaas-events-archive/events-archive/2026/09/01/v1.jsonl.gz",
    );
    // 42 > 20 ⇒ 分页条出现；范围按**真实条数**算（本页 fixture 只有 2 条 ⇒ 第 1–2 条）
    expect(text).toContain("第 1–2 条 / 共 42 条");
  });

  it("翻页按 page=2 重新请求归档记录", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (_url, config) => {
      const page = Number(
        (config as { params?: { page?: number } } | undefined)?.params?.page ?? 1,
      );
      return ok({
        items: [
          entry(
            "2026-07",
            `kaas-events-archive/events-archive/2026/07/0${page}/v1.jsonl.gz`,
            "2026-08-01T02:00:07Z",
          ),
        ],
        total: 42,
        page,
        page_size: PAGE_SIZE,
      });
    });

    await mount();
    await act(async () => {
      button("下一页")!.click();
    });
    await settle();

    expect(archiveCalls()).toHaveLength(2);
    expect(lastParams()).toMatchObject({ page: 2, page_size: PAGE_SIZE });
    expect(container!.textContent).toContain("第 21–21 条 / 共 42 条");
  });
});
