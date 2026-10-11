import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { toast } from "sonner";

import type { TradeDocFile } from "../../hooks/use-trade-docs";
import { DocStampReturn } from "../doc-stamp-return";

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
 * 客户盖章回传的**版本化展示**守卫。
 *
 * 语义（内核 `next_version`）：再次上传 = 新版本上位（`role=stamp_scan`），
 * 旧版本保留但改挂 `role=stamp_scan_superseded` —— 界面上必须**分区**：
 * 当前件是"对外那张"，历史件只是留档。若分区写错（历史件混进当前件），
 * 用户会把已被取代的旧盖章件当成现行版本发出去。
 *
 * 另外两条易悄悄坏的行为：PDF 不能当图片渲染（`<img>` 去读 PDF 会得到破图），
 * 以及空态文案（没有附件时页面不能是空白）。
 */
type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown): GetResp => ({ data }) as unknown as GetResp;

const DOC_ID = 7;

function docFile(over: Partial<TradeDocFile> & { link_id: number; name: string }): TradeDocFile {
  return {
    id: over.link_id + 100,
    storage: "r2",
    content_type: "application/pdf",
    version: 1,
    supersedes_id: null,
    is_current: true,
    created_at: null,
    role: "stamp_scan",
    caption: null,
    sort_order: 0,
    ...over,
  };
}

/**
 * 版本链的真源是**后继件的 `supersedes_id`**（不是"版本号 +1"）：
 * 下面两个当前件分别 `supersedes_id` 指向两条历史件 ⇒ 历史件应显示后继的**真实 version**。
 */
const CURRENT_PDF = docFile({
  id: 101,
  link_id: 11,
  name: "盖章回传-v2.pdf",
  role: "stamp_scan",
  content_type: "application/pdf",
  version: 2,
  supersedes_id: 103, // ← 后继是 HISTORY_V1
});
const CURRENT_IMAGE = docFile({
  id: 102,
  link_id: 12,
  name: "盖章回传-v3.png",
  role: "stamp_scan",
  content_type: "image/png",
  version: 3,
  supersedes_id: 104, // ← 后继是 HISTORY_V2
});
const HISTORY_V1 = docFile({
  id: 103,
  link_id: 13,
  name: "盖章回传-v1.pdf",
  role: "stamp_scan_superseded",
  content_type: "application/pdf",
  version: 1,
  is_current: false,
});
const HISTORY_V2 = docFile({
  id: 104,
  link_id: 14,
  name: "盖章回传-v2-old.pdf",
  role: "stamp_scan_superseded",
  content_type: "application/pdf",
  version: 2,
  is_current: false,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

/** 等 react-query 的异步查询落地并让 React 提交（两轮宏任务足够覆盖 queryFn → setState） */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(files: TradeDocFile[]) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url === `/trade-docs/${DOC_ID}/files`) return ok({ items: files });
    if (/^\/file-objects\/\d+\/content$/.test(url)) {
      return ok(new Blob(["img-bytes"], { type: "image/png" }));
    }
    throw new Error(`未预期的 GET ${url}`);
  });

  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  // 这里用 JSX 字面量依赖 vitest.config.ts 的 `oxc.jsx` 转换：
  // 没有它（tsconfig 是 `"jsx": "preserve"`）连导入本组件所在的 .tsx 都会解析失败。
  const tree: ReactNode = (
    <QueryClientProvider client={client}>
      <DocStampReturn docId={DOC_ID} />
    </QueryClientProvider>
  );
  act(() => {
    root!.render(tree);
  });
  // 两轮：第一轮拿文件清单（这时才 mount 出图片卡片），第二轮才是图片 blob 查询
  await settle();
  await settle();
}

/** 找到某个分区标题所在的容器（FileRow / 历史版本块） */
function section(label: string): HTMLElement {
  const p = Array.from(container!.querySelectorAll("p")).find((el) =>
    el.textContent?.includes(label),
  );
  if (!p?.parentElement) throw new Error(`没找到分区：${label}`);
  return p.parentElement;
}

/** 找到某个文件名的卡片（StampCard 的根 div） */
function card(name: string): HTMLElement {
  const p = Array.from(container!.querySelectorAll("p")).find(
    (el) => el.textContent === name,
  );
  if (!p?.parentElement) throw new Error(`没找到文件卡片：${name}`);
  return p.parentElement;
}

function contentCalls() {
  return vi
    .mocked(apiClient.get)
    .mock.calls.filter(([url]) => String(url).includes("/content"));
}

describe("DocStampReturn · 当前件与历史版本分区", () => {
  beforeAll(() => {
    // jsdom 没有 URL.createObjectURL（实测），图片取 blob 后由它转 objectURL
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = vi.fn(
      () => "blob:mock-image",
    );
  });

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

  it("当前盖章件与历史版本分开渲染，历史条数与取代表述正确", async () => {
    await mount([CURRENT_PDF, CURRENT_IMAGE, HISTORY_V1, HISTORY_V2]);

    const current = section("当前盖章件");
    expect(current.textContent).toContain("当前盖章件 2 件");
    expect(current.textContent).toContain("盖章回传-v2.pdf");
    expect(current.textContent).toContain("盖章回传-v3.png");
    // 历史件绝不能混进当前件那一区
    expect(current.textContent).not.toContain("盖章回传-v1.pdf");
    expect(current.textContent).not.toContain("盖章回传-v2-old.pdf");

    const history = section("历史版本");
    expect(history.textContent).toContain("历史版本 2 件");
    expect(history.textContent).toContain("留档");
    const items = Array.from(history.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("盖章回传-v1.pdf");
    expect(items[0]).toContain("v1");
    // 取代表述来自**后继件的真实 version**（这里后继是 CURRENT_PDF，version=2）
    expect(items[0]).toContain("已被 v2 取代");
    expect(items[1]).toContain("盖章回传-v2-old.pdf");
    expect(items[1]).toContain("已被 v3 取代");

    // 两个分区是并列的兄弟块，不是互相嵌套
    expect(current.contains(history)).toBe(false);
    expect(history.contains(current)).toBe(false);

    // 没有 product_photo / render_pdf 时不凭空出现那两块
    expect(container!.textContent).not.toContain("产品图引用");
    expect(container!.textContent).not.toContain("系统出的 PDF");

    // 曾把 Markdown 字面量当文本渲染（界面出现 `**覆盖当前件**`）—— 钉住不再出现
    expect(container!.textContent).toContain("再次上传会覆盖当前件");
    expect(container!.textContent).not.toContain("**");
  });

  it("取代表述用后继件的真实 version：跳号不推算；没有后继件时兜底为「已被新版取代」", async () => {
    // 孤立历史件：全表里没有任何 `supersedes_id` 指向它（例如后继件被摘除/还没同步过来）
    const orphan = docFile({
      id: 301,
      link_id: 31,
      name: "孤立历史件.pdf",
      role: "stamp_scan_superseded",
      version: 5,
      is_current: false,
    });
    // 跳号版本链：v1 的后继是 v7（不是 v2）
    const jumped = docFile({
      id: 302,
      link_id: 32,
      name: "跳号历史件.pdf",
      role: "stamp_scan_superseded",
      version: 1,
      is_current: false,
    });
    const jumpedSuccessor = docFile({
      id: 303,
      link_id: 33,
      name: "跳号后继件.pdf",
      role: "stamp_scan",
      version: 7,
      supersedes_id: 302,
    });

    await mount([orphan, jumped, jumpedSuccessor]);

    const history = section("历史版本");
    const items = Array.from(history.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(2);

    // 跳号：写后继的 v7，而不是 version+1 推出来的 v2
    expect(items[1]).toContain("跳号历史件.pdf");
    expect(items[1]).toContain("已被 v7 取代");
    expect(items[1]).not.toContain("已被 v2 取代");

    // 没有后继件：兜底文案，绝不能凭空推算 version+1（那会指向不存在的版本）
    expect(items[0]).toContain("孤立历史件.pdf");
    expect(items[0]).toContain("v5");
    expect(items[0]).toContain("已被新版取代");
    expect(container!.textContent).not.toContain("已被 v6 取代");
  });

  it("没有任何附件时给出空状态文案（不是一片空白）", async () => {
    await mount([]);

    expect(container!.textContent).toContain("还没有附件");
    expect(container!.textContent).not.toContain("当前盖章件");
    expect(container!.textContent).not.toContain("历史版本");
  });

  it("PDF 不渲染 <img>（显示 PDF 占位），只有图片才取 blob 渲染", async () => {
    await mount([CURRENT_PDF, CURRENT_IMAGE, HISTORY_V1]);

    const pdfCard = card("盖章回传-v2.pdf");
    expect(pdfCard.querySelector("img")).toBeNull();
    expect(pdfCard.textContent).toContain("PDF");

    const imageCard = card("盖章回传-v3.png");
    const img = imageCard.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("alt")).toBe("盖章回传-v3.png");
    expect(img!.getAttribute("src")).toBe("blob:mock-image");

    // 整页只有图片那一张 <img>；PDF 连 blob 都不去取（只请求了图片那个 id）
    expect(container!.querySelectorAll("img")).toHaveLength(1);
    const calls = contentCalls();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toBe(`/file-objects/${CURRENT_IMAGE.id}/content`);
  });

  it("上传回传件：POST /trade-docs/{id}/files/upload，multipart 里 role=stamp_scan", async () => {
    await mount([]);
    const post = vi.mocked(apiClient.post);
    post.mockResolvedValue(ok({ id: 900, name: "BABAN 盖章回传" }));

    const file = new File(["scan-bytes"], "stamp.png", { type: "image/png" });
    const fileInput = container!.querySelector('input[type="file"]') as HTMLInputElement;
    const nameInput = Array.from(container!.querySelectorAll("input")).find(
      (el) => el.type !== "file",
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    expect(nameInput).toBeTruthy();

    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(nameInput, "BABAN 盖章回传");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const button = Array.from(container!.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("上传回传件"),
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0]!;
    expect(String(url)).toBe(`/trade-docs/${DOC_ID}/files/upload`);

    const form = body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("role")).toBe("stamp_scan");
    expect(form.get("name")).toBe("BABAN 盖章回传");
    const uploaded = form.get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe("stamp.png");
    expect((config as { headers?: Record<string, string> }).headers?.["Content-Type"]).toBe(
      "multipart/form-data",
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });
});
