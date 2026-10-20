/**
 * 导出后自检面板（`doc-export-verify-panel.tsx`）交互测试。
 *
 * 钉住三种结论的展示口径（C21 的验收点）：
 * 1. **通过**：后端 200 → 绿色"自检通过（后端裁决）"+ 页数/图片/文本计数；
 * 2. **blocking**：后端 422 `EXPORT_SELF_CHECK_FAILED` → 红色阻断 + 逐条 missing texts /
 *    图片计数不符；绝不同时显示"通过"；
 * 3. **解析失败**：pdf.js 抽不出（加密/非 PDF/坏文件）→ 黄色"无法完成自检"，
 *    且**不调用后端**（没有结论 ≠ 通过）。
 *
 * 数据层整模块 mock（真实 pdf.js 不在此跑；抽取层单测见
 * `lib/trade-doc/__tests__/pdf-extract.test.ts`，真实 PDF 另有一次 Node 验证）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PdfExtractError } from "@/lib/trade-doc/pdf-extract";

const mocks = vi.hoisted(() => ({
  extractPdfFacts: vi.fn(),
  verify: vi.fn(),
  fetchBytes: vi.fn(),
  filesData: [] as unknown[],
  renderData: null as unknown,
}));

// 路径相对**测试文件**解析（面板里写的是 ../hooks/…）
vi.mock("../../hooks/use-trade-docs", () => ({
  useTradeDocFiles: () => ({ data: mocks.filesData, isError: false }),
  useTradeDocRenderData: () => ({ data: mocks.renderData }),
  fetchFileObjectBytes: (...args: unknown[]) => mocks.fetchBytes(...args),
}));

vi.mock("../../hooks/use-doc-hardening", () => ({
  useVerifyExport: () => ({ mutateAsync: mocks.verify, isPending: false }),
}));

vi.mock("@/lib/trade-doc/pdf-extract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/trade-doc/pdf-extract")>();
  return { ...actual, extractPdfFacts: mocks.extractPdfFacts };
});

// 渲染 HTML 用固定桩：本测试只关心"抽出来的文本"如何被后端裁决与展示。
// **必须部分 mock**：真实 `expectedImageCounts` 会复用 render.ts 的 `safeImageSrc`。
vi.mock("@/lib/trade-doc/render", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/trade-doc/render")>();
  return {
    ...actual,
    renderTradeDoc: () =>
      "<table><tr><th>Total</th><td>USD 100.00</td></tr></table>",
  };
});

import { DocExportVerifyPanel } from "../doc-export-verify-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function flush(times = 6): Promise<void> {
  return new Promise((resolve) => {
    let left = times;
    const tick = () => {
      if (left-- <= 0) return resolve();
      setTimeout(tick, 0);
    };
    tick();
  });
}

function renderPanel(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<DocExportVerifyPanel docId={7} />);
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((btn) =>
    (btn.textContent ?? "").includes(text),
  );
  if (!found) throw new Error(`找不到按钮「${text}」`);
  return found as HTMLButtonElement;
}

function text(): string {
  return container.textContent ?? "";
}

const ARCHIVED_FILE = {
  id: 91,
  name: "PI-2026-001.pdf",
  version: 2,
  role: "render_pdf",
  is_current: true,
  storage: "inline",
  content_type: "application/pdf",
  supersedes_id: null,
  created_at: "2026-10-21T10:00:00+00:00",
  link_id: 1,
  caption: null,
  sort_order: 0,
};

const RENDER_DATA = {
  doc: { id: 7, doc_type: "pi", doc_no: "PI-2026-001", status: "draft" },
  data: {
    company_stamp: "data:image/png;base64,AAAA",
    product_photos: [{ image: "data:image/png;base64,BBBB" }],
  },
  company_profile_configured: true,
};

const FACTS = { pageCount: 2, imageCount: 2, text: "Total USD 100.00" };

function axiosError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.filesData = [ARCHIVED_FILE];
  mocks.renderData = RENDER_DATA;
  mocks.fetchBytes.mockResolvedValue(new Uint8Array([0x25, 0x50]).buffer);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("导出后自检面板 · 三种结论", () => {
  it("① 通过：展示后端裁决结果（页数/图片/文本），并真的把抽取事实提交给后端", async () => {
    mocks.extractPdfFacts.mockResolvedValue(FACTS);
    mocks.verify.mockResolvedValue({
      doc_id: 7,
      ok: true,
      overridden: false,
      texts: 2,
      missing_texts: [],
      image_mismatches: [],
    });
    renderPanel();

    await click(buttonByText("自检最近归档的 PDF"));

    // 从归档文件取字节（不是让用户手点文件）
    expect(mocks.fetchBytes).toHaveBeenCalledWith(91);
    expect(mocks.extractPdfFacts).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    // 请求体：文本来自渲染 HTML；图片 = 抽到 2 - 期望产品图 1 ⇒ 非产品图 1 张
    const body = mocks.verify.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.pdf_text).toBe(FACTS.text);
    expect(body.texts).toEqual(["Total", "USD 100.00"]);
    expect(body.image_counts).toEqual({ stamp: 1 });
    expect(body.expected_image_counts).toEqual({ stamp: 1 });
    expect(body).not.toHaveProperty("allow_override");

    const shown = text();
    expect(shown).toContain("自检通过（后端裁决）");
    expect(shown).toContain("2 页");
    expect(shown).toContain("核对文本 2 段全部命中");
    expect(shown).not.toContain("自检未通过");
  });

  it("② blocking：422 时逐条展示缺失文本与图片计数不符，且不显示通过", async () => {
    mocks.extractPdfFacts.mockResolvedValue(FACTS);
    mocks.verify.mockRejectedValue(
      axiosError(422, {
        detail: {
          error: "validation",
          code: "EXPORT_SELF_CHECK_FAILED",
          detail: "导出后自检未通过：文本缺失或图片计数不符，请先修正版式（默认阻断导出）",
          texts: 2,
          missing_texts: ["USD 100.00"],
          image_mismatches: [{ key: "stamp", expected: 1, actual: 2 }],
          checked: {
            texts: 2,
            missing_texts: ["USD 100.00"],
            image_mismatches: [{ key: "stamp", expected: 1, actual: 2 }],
          },
        },
      }),
    );
    renderPanel();

    await click(buttonByText("自检最近归档的 PDF"));

    const shown = text();
    expect(shown).toContain("自检未通过");
    expect(shown).toContain("已阻断（后端裁决）");
    expect(shown).toContain("USD 100.00");
    expect(shown).toContain("期望 1 张 / 实际 2 张");
    expect(shown).toContain("普通界面不提供");
    expect(shown).not.toContain("自检通过");
  });

  it("③ 解析失败：pdf.js 抽不出时如实说不通过，**不调用后端裁决**", async () => {
    mocks.extractPdfFacts.mockRejectedValue(
      new PdfExtractError("NOT_PDF", "文件不是有效的 PDF"),
    );
    renderPanel();

    await click(buttonByText("自检最近归档的 PDF"));

    const shown = text();
    expect(shown).toContain("无法完成自检");
    expect(shown).toContain("文件不是有效的 PDF");
    expect(shown).toContain("未调用后端裁决");
    expect(shown).not.toContain("自检通过");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});

describe("导出后自检面板 · 入口与来源", () => {
  it("没有归档 PDF：按钮禁用 + 提示，仍可用本地文件自检", async () => {
    mocks.filesData = [];
    mocks.extractPdfFacts.mockResolvedValue(FACTS);
    mocks.verify.mockResolvedValue({
      doc_id: 7,
      ok: true,
      overridden: false,
      texts: 2,
      missing_texts: [],
      image_mismatches: [],
    });
    renderPanel();

    expect(buttonByText("自检最近归档的 PDF").disabled).toBe(true);
    expect(text()).toContain("还没有归档的导出 PDF");

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["%PDF-1.4"], "local.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([0x25, 0x50]).buffer,
    });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(mocks.fetchBytes).not.toHaveBeenCalled();
    expect(mocks.extractPdfFacts).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(text()).toContain("本地文件：local.pdf");
    expect(text()).toContain("自检通过（后端裁决）");
  });
});
