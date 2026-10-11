import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { toast } from "sonner";

import { DocPreview } from "../doc-preview";

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

// React 18 的 act() 需要这个开关（仓库没有 testing-library / setup 文件）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 「自动出 PDF 并归档」的守卫（用户要求「自动出pdf字节听起来是降低工作量的设计实现它」）。
 *
 * 这条链路是：预览区按钮 → `POST /trade-docs/{id}/pdf`（body 就是**预览用的那份 HTML**）
 * → 服务端 Browser Rendering 出字节 → 走同一套落档链路（kind=render_pdf，版本让位）。
 *
 * 三条坏掉也不会报错、只会静静出错的行为：
 * 1. **送出去的 HTML 必须与预览同源**（iframe 的 srcdoc）——服务端"再渲染一次"
 *    就会变成另一套排版，正是设计文档 §四 风险 1 要避免的。
 * 2. **未配置渲染器（503 `PDF_RENDERER_NOT_CONFIGURED`）必须如实提示**后端的可执行说明
 *    （要配什么），绝不能弹"已归档"骗用户。
 * 3. **人工归档兜底必须还在**（另一条路不能用自动出 PDF 取代掉）。
 */
type PostResp = Awaited<ReturnType<typeof apiClient.post>>;
const ok = (data: unknown): PostResp => ({ data }) as unknown as PostResp;

/** 模拟 axios 错误：`normalizeApiError` 认的是 `error.response.{status,data}`。 */
function apiError(status: number, data: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data },
    isAxiosError: true,
  });
}

const DOC_ID = 42;
const DOC_NO = "PI-2026-001";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;
type Invalidations = { mock: { calls: unknown[][] } };
let invalidate: Invalidations | null = null;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(docId: number | null = DOC_ID) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  invalidate = vi.spyOn(client, "invalidateQueries") as unknown as Invalidations;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <DocPreview
        docType="pi"
        docNo={DOC_NO}
        data={{}}
        companyProfileConfigured
        docId={docId ?? undefined}
      />
    </QueryClientProvider>
  );
  act(() => {
    root!.render(tree);
  });
  await settle();
}

function buttonByText(text: string): HTMLButtonElement {
  const el = Array.from(container!.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!el) throw new Error(`没有找到按钮：${text}`);
  return el as HTMLButtonElement;
}

async function click(text: string) {
  const button = buttonByText(text);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function errorTexts(): string[] {
  return vi.mocked(toast.error).mock.calls.map(([msg]) => String(msg));
}

describe("DocPreview · 自动出 PDF 并归档", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(apiClient.post).mockResolvedValue(
      ok({ file: { id: 1 }, link: { id: 2 }, renderer: "binding", bytes: 20480, storage: "s3" }),
    );
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    client?.clear();
    root = null;
    container = null;
    client = null;
    invalidate = null;
  });

  it("成功：POST /trade-docs/{id}/pdf，body 的 html 与预览 iframe 同源", async () => {
    await mount();
    await click("自动出 PDF 并归档");

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    const post = vi.mocked(apiClient.post);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0]!;
    expect(String(url)).toBe(`/trade-docs/${DOC_ID}/pdf`);

    const payload = body as { html: string; name: string };
    // **同源**：送出去的正是 iframe 里渲染的那份 HTML（服务端不许再渲染一次）
    const iframe = container!.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(payload.html).toBe(iframe!.getAttribute("srcdoc"));
    expect(payload.html).toContain("<!DOCTYPE html>");
    // 名称默认用单证号（服务端 name 为空会回落文件名，这里给可读默认值）
    expect(payload.name).toBe(`${DOC_NO}.pdf`);

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.success).mock.calls[0]![0])).toContain("已自动生成并归档");
    // 文案要说清版本语义（不是物理覆盖）
    expect(String(vi.mocked(toast.success).mock.calls[0]![0])).toContain("旧版留档");

    // 单据文件区（「系统出的 PDF」分区）要立刻刷新
    expect(invalidate!.mock.calls.map((call) => call[0])).toContainEqual({
      queryKey: ["trade-docs", DOC_ID, "files"],
    });
  });

  it("未配置渲染器（503）：如实提示后端的可执行说明，不弹成功", async () => {
    await mount();
    vi.mocked(apiClient.post).mockRejectedValue(
      apiError(503, {
        detail: {
          error: "unavailable",
          code: "PDF_RENDERER_NOT_CONFIGURED",
          detail: "服务端未配置 PDF 渲染器。生产 Worker 需在 wrangler.jsonc 声明 browser binding…",
        },
      }),
    );

    await click("自动出 PDF 并归档");

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(errorTexts()).toHaveLength(1);
    expect(errorTexts()[0]).toContain("未配置 PDF 渲染器");
    expect(errorTexts()[0]).toContain("wrangler.jsonc");
  });

  it("其它失败（500）：走兜底文案，并指向人工归档", async () => {
    await mount();
    vi.mocked(apiClient.post).mockRejectedValue(apiError(500, { detail: "boom" }));

    await click("自动出 PDF 并归档");

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(errorTexts()).toHaveLength(1);
    expect(errorTexts()[0]).toContain("boom"); // 保留后端原文，便于定位
    expect(errorTexts()[0]).toContain("归档本版 PDF"); // 必须指向人工兜底
  });

  it("没有 docId（样板预览）：既不渲染自动按钮，也不渲染人工归档区块", async () => {
    await mount(null);

    expect(container!.textContent).not.toContain("自动出 PDF 并归档");
    expect(container!.textContent).not.toContain("归档本版 PDF");
    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();
  });

  it("两条路都在：人工归档兜底未被自动出 PDF 取代", async () => {
    await mount();

    expect(buttonByText("自动出 PDF 并归档")).toBeTruthy();
    expect(buttonByText("归档本版 PDF")).toBeTruthy();
    // 人工归档的选择框与名称输入仍在
    expect(container!.querySelector('input[type="file"]')).not.toBeNull();
    expect(container!.textContent).toContain("再归档会覆盖当前件，旧版留档");
  });
});
