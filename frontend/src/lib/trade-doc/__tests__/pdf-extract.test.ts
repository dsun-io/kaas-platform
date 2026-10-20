/**
 * 导出后自检 · 前端抽取层（`lib/trade-doc/pdf-extract.ts`）单测。
 *
 * pdf.js 用 **mock**（真实库动态 import + worker 在 jsdom 里跑不起来）：
 * 这里钉的是**我们的适配逻辑**——文本拼接、图片绘制计数口径、错误映射、
 * "要核对的文本"如何从渲染 HTML 里抽、期望图片数如何从渲染数据算、
 * 以及提交给后端的请求体形状（尤其是 `stamp` key 的"非产品图图片数"翻译）。
 *
 * 真实 PDF 的抽取已用**一次性 Node 脚本**（真 pdfjs-dist + 手写最小 PDF）验证过，
 * 结果见任务报告；CI 只跑本文件的确定性逻辑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  OPS: {
    paintImageXObject: 85,
    paintInlineImageXObject: 86,
    paintImageXObjectRepeat: 88,
    paintImageMaskXObject: 83,
    paintSolidColorImageMask: 90,
  },
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: mocks.getDocument,
  OPS: mocks.OPS,
  GlobalWorkerOptions: mocks.GlobalWorkerOptions,
}));

import {
  PdfExtractError,
  buildVerifyExportRequest,
  collectDocTexts,
  configurePdfWorker,
  expectedImageCounts,
  extractPdfFacts,
} from "../pdf-extract";

function page(texts: string[], ops: number[]) {
  return {
    getTextContent: async () => ({ items: texts.map((str) => ({ str })) }),
    getOperatorList: async () => ({ fnArray: ops }),
    cleanup: vi.fn(),
  };
}

function fakeDoc(pages: ReturnType<typeof page>[]) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => pages[number - 1]),
  };
}

/** v6：清理走 loadingTask.destroy()（PDFDocumentProxy 上没有 destroy） */
function loadingTaskOf(doc: unknown) {
  return { promise: Promise.resolve(doc), destroy: vi.fn(async () => undefined) };
}

function failedTask(error: unknown) {
  return { promise: Promise.reject(error), destroy: vi.fn(async () => undefined) };
}

function pdfOf() {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.GlobalWorkerOptions.workerSrc = "";
});

afterEach(() => {
  mocks.GlobalWorkerOptions.workerSrc = "";
});

describe("extractPdfFacts · 文本与图片计数", () => {
  it("文本按页拼接；图片只数内容图（遮罩/纯色填充不算）", async () => {
    const first = page(["Total: ", "USD 100.00"], [
      mocks.OPS.paintImageXObject,
      1,
      mocks.OPS.paintInlineImageXObject,
    ]);
    const second = page(["Page 2"], [
      mocks.OPS.paintImageXObjectRepeat,
      mocks.OPS.paintImageMaskXObject,
      mocks.OPS.paintSolidColorImageMask,
    ]);
    const doc = fakeDoc([first, second]);
    const task = loadingTaskOf(doc);
    mocks.getDocument.mockReturnValue(task);

    const facts = await extractPdfFacts(pdfOf());

    expect(facts.pageCount).toBe(2);
    // 85 + 86 + 88 = 3；83（遮罩）与 90（纯色填充）不计
    expect(facts.imageCount).toBe(3);
    expect(facts.text).toBe("Total: USD 100.00\nPage 2\n");
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("空白/超大文件在解析前就被拒（不触发 pdf.js）", async () => {
    await expect(extractPdfFacts(new ArrayBuffer(0))).rejects.toMatchObject({
      code: "NOT_PDF",
    });
    await expect(
      extractPdfFacts(new ArrayBuffer(8), { maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("pdf.js 的错误映射成可读的 PdfExtractError（加密/非 PDF/其它）", async () => {
    mocks.getDocument.mockReturnValue(
      failedTask(
        Object.assign(new Error("password"), { name: "PasswordException" }),
      ),
    );
    await expect(extractPdfFacts(pdfOf())).rejects.toMatchObject({
      code: "ENCRYPTED",
      message: expect.stringContaining("密码"),
    });

    mocks.getDocument.mockReturnValue(
      failedTask(
        Object.assign(new Error("bad"), { name: "InvalidPDFException" }),
      ),
    );
    const notPdf = await extractPdfFacts(pdfOf()).catch((err) => err);
    expect(notPdf).toBeInstanceOf(PdfExtractError);
    expect(notPdf.code).toBe("NOT_PDF");

    mocks.getDocument.mockReturnValue(failedTask(new Error("boom")));
    await expect(extractPdfFacts(pdfOf())).rejects.toMatchObject({
      code: "EXTRACT_FAILED",
      message: expect.stringContaining("boom"),
    });
  });

  it("页面读取失败也要 destroy，并报 EXTRACT_FAILED", async () => {
    const doc = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getTextContent: async () => ({ items: [] }),
        getOperatorList: async () => {
          throw new Error("op list failed");
        },
        cleanup: vi.fn(),
      })),
    };
    const task = loadingTaskOf(doc);
    mocks.getDocument.mockReturnValue(task);

    await expect(extractPdfFacts(pdfOf())).rejects.toMatchObject({
      code: "EXTRACT_FAILED",
      message: expect.stringContaining("op list failed"),
    });
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("配置 worker：未设置时补上；已设置不覆盖", async () => {
    mocks.GlobalWorkerOptions.workerSrc = "";
    configurePdfWorker({
      GlobalWorkerOptions: mocks.GlobalWorkerOptions,
    } as never);
    const first = mocks.GlobalWorkerOptions.workerSrc;
    expect(first).not.toBe("");

    // 幂等：再次调用不改写已设置的值
    configurePdfWorker({
      GlobalWorkerOptions: mocks.GlobalWorkerOptions,
    } as never);
    expect(mocks.GlobalWorkerOptions.workerSrc).toBe(first);

    // 手工指定的地址优先（不覆盖）
    const custom = { workerSrc: "/custom.worker.mjs" };
    configurePdfWorker({ GlobalWorkerOptions: custom } as never);
    expect(custom.workerSrc).toBe("/custom.worker.mjs");
  });
});

describe("collectDocTexts · 从渲染 HTML 抽应出现的文本", () => {
  it("按段落元素取文本、去重、忽略 style/script", () => {
    const html = `<!doctype html><html><head>
      <style>.a{color:red}</style><script>var x = 1;</script></head>
      <body>
        <h1>COMMERCIAL INVOICE</h1>
        <table>
          <tr><th>Total</th><td><span>USD</span> 100.00</td></tr>
          <tr><td>Total</td><td>USD 100.00</td></tr>
        </table>
        <p>Amount in words: ONE HUNDRED</p>
      </body></html>`;
    expect(collectDocTexts(html)).toEqual([
      "COMMERCIAL INVOICE",
      "Total",
      "USD 100.00",
      "Amount in words: ONE HUNDRED",
    ]);
  });

  it("空 HTML / 无段落元素时返回空数组（调用方会当解析失败处理）", () => {
    expect(collectDocTexts("")).toEqual([]);
    expect(collectDocTexts("<html><body></body></html>")).toEqual([]);
  });
});

describe("expectedImageCounts · 从渲染数据算期望图片数", () => {
  it("公章 1 张 + 可渲染产品图 N 张（被白名单挡掉的不算）", () => {
    expect(
      expectedImageCounts({
        company_stamp: "data:image/png;base64,AAAA",
        product_photos: [
          { image: "data:image/png;base64,AAAA" },
          { image: "https://cdn.example.com/a.png" },
          { image: "javascript:alert(1)" }, // 白名单挡掉 ⇒ 不会渲染
          { caption: "缺图" },
        ],
      }),
    ).toEqual({ photos: 2, stamp: 1, total: 3 });
  });

  it("没有公章/没有产品图时为 0", () => {
    expect(expectedImageCounts({})).toEqual({ photos: 0, stamp: 0, total: 0 });
    expect(
      expectedImageCounts({ company_stamp: "", product_photos: [] }),
    ).toEqual({ photos: 0, stamp: 0, total: 0 });
  });
});

describe("buildVerifyExportRequest · 只组装事实、不裁决", () => {
  const base = {
    pdfText: "COMMERCIAL INVOICE Total USD 100.00",
    texts: ["COMMERCIAL INVOICE", "Total", "USD 100.00"],
    expected: { photos: 2, stamp: 1, total: 3 },
  };

  it("图片数相符：非产品图图片数（stamp）= 1，期望 = 1", () => {
    const body = buildVerifyExportRequest({ ...base, imageCount: 3 });
    expect(body).toEqual({
      texts: base.texts,
      pdf_text: base.pdfText,
      image_counts: { stamp: 1 },
      expected_image_counts: { stamp: 1 },
    });
    // 普通 UI 不提交越权开关
    expect(body).not.toHaveProperty("allow_override");
  });

  it("抽到多一张图：stamp 残差 = 2 ⇒ 交给后端判不符（前端不自己拦）", () => {
    const body = buildVerifyExportRequest({ ...base, imageCount: 4 });
    expect(body.image_counts).toEqual({ stamp: 2 });
    expect(body.expected_image_counts).toEqual({ stamp: 1 });
  });

  it("没有公章的单据：期望 0，残差 0（多出任何非产品图都会被后端判不符）", () => {
    const body = buildVerifyExportRequest({
      ...base,
      imageCount: 2,
      expected: { photos: 2, stamp: 0, total: 2 },
    });
    expect(body.image_counts).toEqual({ stamp: 0 });
    expect(body.expected_image_counts).toEqual({ stamp: 0 });
  });
});
