import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { toast } from "sonner";

import {
  ARCHIVE_NAME_MAX_LEN,
  DocPreview,
  RENDER_PDF_MAX_BYTES,
  defaultArchivePdfName,
  validateArchivePdf,
} from "../doc-preview";

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
 * 「归档本版 PDF」的守卫（用户要求「pdf 要存」）。
 *
 * 为什么这几条必须钉住
 * --------------------
 * 1. **字节是能留档的唯一凭据**：系统拿不到 `window.print()` 的产物，只能靠用户打印
 *    导出的那份 PDF 选回来。所以「服务端收到的字节 == 用户选的那份」必须被证明
 *    （同一个 File 实例 + 逐字节比对 + multipart body 里那一段字节原样在）。
 * 2. **不合规必须当场拦**：类型不是 `application/pdf`、超 32MB（内核
 *    `MAX_BYTES['render_pdf']`）、0 字节，在服务端都是 422。前端不拦，用户只会拿到
 *    「422」去猜；这里断言的是用户看得懂的中文原因，且**根本没发请求**。
 * 3. **版本语义不能写反**：`role` 必须是 `render_pdf`（后端据此做版本让位），
 *    成功文案必须说明"再归档会覆盖当前件、旧版留档"（不是物理删除）。
 * 4. **归档后要看得见**：`["trade-docs", id, "files"]` 必须失效，否则单据文件区不刷新。
 *
 * 明确没覆盖的：无头环境里**无法验证真实 PDF 的版面/分页**（那要人眼看或真出图）。
 * 本文件只证明"上传的字节与服务端收到的一致"，不声称验证过 PDF 外观。
 */
type PostResp = Awaited<ReturnType<typeof apiClient.post>>;
const ok = (data: unknown): PostResp => ({ data }) as unknown as PostResp;

const DOC_ID = 42;
const DOC_NO = "PI-2026-001";

/** 一份带非 ASCII 字节的假 PDF：既验 `%PDF-` 头，也验 0xFF/0x00 这类字节没被改写 */
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, // %PDF-1.4
  0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, // 二进制标记
  0x31, 0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x0a,
  0xff, 0x00, 0x80, 0xfe, 0x7f, 0x01, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, // %%EOF
]);

function pdfFile(): File {
  return new File([PDF_BYTES], `${DOC_NO}.pdf`, { type: "application/pdf" });
}

/** 造一个"大小是 N 字节"的文件：真分配 32MB 太浪费，只改 size 读数即可（校验只看 size/type） */
function fileWithSize(name: string, size: number, type = "application/pdf"): File {
  const file = new File([PDF_BYTES], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/**
 * 把 FormData 按 multipart 语义摊成 latin1 字符串。
 * 这不是要模拟 axios 的边界细节，只为了证明**那段 PDF 字节确实原样进了请求体**
 * （而不是"我们以为传了"）。
 */
async function formPayload(form: FormData): Promise<string> {
  const entries: [string, FormDataEntryValue][] = [];
  form.forEach((value, key) => entries.push([key, value]));
  const rendered: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      rendered.push(`${key}=${value}`);
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    rendered.push(
      `name="${key}"; filename="${value.name}"; type="${value.type}"\r\n\r\n${latin1(bytes)}`,
    );
  }
  return rendered.join("\r\n");
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;
/** 只取"调用记录"：`vi.spyOn` 的返回类型太宽（隐式 any），这里收窄成够用的形状 */
type Invalidations = { mock: { calls: unknown[][] } };
let invalidate: Invalidations | null = null;

/** 等 react-query 的异步 mutation 落地并让 React 提交（两轮宏任务足够） */
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

function fileInput(): HTMLInputElement {
  const el = container!.querySelector('input[type="file"]');
  if (!el) throw new Error("没有找到 PDF 选择框");
  return el as HTMLInputElement;
}

function nameInput(): HTMLInputElement {
  const el = Array.from(container!.querySelectorAll("input")).find(
    (i) => i.type !== "file",
  );
  if (!el) throw new Error("没有找到归档名称输入框");
  return el as HTMLInputElement;
}

function archiveButton(): HTMLButtonElement {
  const el = Array.from(container!.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("归档本版 PDF"),
  );
  if (!el) throw new Error("没有找到「归档本版 PDF」按钮");
  return el as HTMLButtonElement;
}

async function pick(file: File) {
  const input = fileInput();
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function typeName(value: string) {
  const input = nameInput();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickArchive() {
  const button = archiveButton();
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function errorTexts(): string[] {
  return vi.mocked(toast.error).mock.calls.map(([msg]) => String(msg));
}

describe("DocPreview · 归档本版 PDF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(apiClient.post).mockResolvedValue(ok({ file: { id: 1 }, link: { id: 2 } }));
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

  it("选了非 PDF：当场提示原因，且不发任何上传请求", async () => {
    await mount();
    await pick(new File(["not-a-pdf"], "scan.png", { type: "image/png" }));

    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();
    expect(errorTexts()).toHaveLength(1);
    expect(errorTexts()[0]).toContain("只接受 PDF");
    expect(errorTexts()[0]).toContain("image/png");
    // 没进入"已选"状态 ⇒ 界面上不能出现"已选："
    expect(container!.textContent).not.toContain("已选：");

    // 即便这时点按钮，也只是"先选一份"，绝不把不合规文件发出去
    await clickArchive();
    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();
    expect(errorTexts()[1]).toContain("先选一份 PDF");
  });

  it("选了超过 32MB 的 PDF：当场提示 32MB 上限，且不发请求", async () => {
    await mount();
    await pick(fileWithSize("huge.pdf", RENDER_PDF_MAX_BYTES + 1));

    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();
    expect(errorTexts()).toHaveLength(1);
    expect(errorTexts()[0]).toContain("32MB");
    expect(container!.textContent).not.toContain("已选：");
  });

  it("边界与内核一致：正好 32MB 通过、多 1 字节被拦、0 字节被拦", () => {
    expect(RENDER_PDF_MAX_BYTES).toBe(32 * 1024 * 1024);

    expect(validateArchivePdf(fileWithSize("at.pdf", RENDER_PDF_MAX_BYTES))).toBeNull();
    expect(
      validateArchivePdf(fileWithSize("over.pdf", RENDER_PDF_MAX_BYTES + 1)),
    ).toContain("32MB");
    expect(validateArchivePdf(fileWithSize("empty.pdf", 0))).toContain("空的");
    expect(
      validateArchivePdf(new File(["x"], "a.pdf", { type: "" })),
    ).toContain("只接受 PDF");
  });

  it("正常归档：POST /trade-docs/{id}/files/upload，role=render_pdf，同一 File 实例，字节逐字节一致", async () => {
    await mount();
    const file = pdfFile();
    await pick(file);
    expect(container!.textContent).toContain("已选：PI-2026-001.pdf");

    await clickArchive();

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    const post = vi.mocked(apiClient.post);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0]!;
    expect(String(url)).toBe(`/trade-docs/${DOC_ID}/files/upload`);
    expect(
      (config as { headers?: Record<string, string> }).headers?.["Content-Type"],
    ).toBe("multipart/form-data");

    const form = body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // 后端把 role 直接当 kind 用；写错这里就没有版本让位（旧 PDF 不会挂 _superseded）
    expect(form.get("role")).toBe("render_pdf");
    // name 留空时回落单证号（服务端 name 为空会回落文件名，这里给可读默认值）
    expect(form.get("name")).toBe(`${DOC_NO}.pdf`);

    // ① 同一个 File 实例（不是复制/重新包装）
    const sent = form.get("file");
    expect(sent).toBeInstanceOf(File);
    expect(sent).toBe(file);
    expect((sent as File).type).toBe("application/pdf");
    expect((sent as File).size).toBe(PDF_BYTES.length);

    // ② 逐字节比对：第一段头、中段、尾段都被覆盖
    const sentBytes = new Uint8Array(await (sent as File).arrayBuffer());
    expect(sentBytes.length).toBe(PDF_BYTES.length);
    expect(Array.from(sentBytes)).toEqual(Array.from(PDF_BYTES));
    expect(Array.from(sentBytes.slice(0, 8))).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    ]);
    expect(Array.from(sentBytes.slice(-6))).toEqual(
      Array.from(PDF_BYTES.slice(-6)),
    );

    // ③ 字节确实在 multipart 请求体里（服务端收到的就是这一段）
    const payload = await formPayload(form);
    expect(payload).toContain("%PDF-1.4");
    expect(payload).toContain(latin1(PDF_BYTES));
    expect(payload).toContain('filename="PI-2026-001.pdf"');
    // 只能有一个 file 条目：多传一份就等于归档了两份不同字节
    const fileEntries: string[] = [];
    form.forEach((_v, k) => fileEntries.push(k));
    expect(fileEntries.filter((k) => k === "file")).toHaveLength(1);

    // ④ 成功提示说清版本语义（不是"物理覆盖"）
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "已归档；再归档会覆盖当前件，旧版留档",
    );

    // ⑤ 单据文件区（DocStampReturn 的 role=render_pdf 分区）要能刷新
    expect(invalidate!.mock.calls.map((call) => call[0])).toContainEqual({
      queryKey: ["trade-docs", DOC_ID, "files"],
    });

    // 归档成功后清空选择与名称，避免"再点一次"重复归档同一份
    expect(container!.textContent).not.toContain("已选：");
    expect(nameInput().value).toBe("");
  });

  it("自定义归档名称生效；名称超长时当场拦下（不发请求）", async () => {
    await mount();
    await pick(pdfFile());
    await typeName("BABAN KORI 归档 PI");
    await clickArchive();

    const form = vi.mocked(apiClient.post).mock.calls[0]![1] as FormData;
    expect(form.get("name")).toBe("BABAN KORI 归档 PI");

    // 超长名称：服务端是 NAME_TOO_LONG 422，前端先拦
    // （归档成功后选择已被清空，这里要重新选一份，否则测到的是"先选一份 PDF"那条分支）
    vi.mocked(apiClient.post).mockClear();
    vi.mocked(toast.error).mockClear();
    await pick(pdfFile());
    await typeName("x".repeat(ARCHIVE_NAME_MAX_LEN + 1));
    await clickArchive();
    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();
    expect(errorTexts()[0]).toContain(`最长 ${ARCHIVE_NAME_MAX_LEN} 个字符`);
  });

  it("上传失败：提示失败分支，不发成功提示", async () => {
    await mount();
    vi.mocked(apiClient.post).mockRejectedValue(new Error("422 BAD_CONTENT_TYPE"));
    await pick(pdfFile());
    await clickArchive();

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(errorTexts()).toHaveLength(1);
    expect(errorTexts()[0]).toContain("归档失败");
    // 失败后选择保留，用户可以重试（不能静默清空）
    expect(container!.textContent).toContain("已选：PI-2026-001.pdf");
  });

  it("没有 docId（样板预览没有真实单据）：归档区块完全不渲染", async () => {
    await mount(null);

    expect(container!.textContent).not.toContain("归档本版 PDF");
    expect(container!.querySelector('input[type="file"]')).toBeNull();
    expect(vi.mocked(apiClient.post)).not.toHaveBeenCalled();
    // 打印/下载这两个不依赖单据 id 的按钮仍在
    expect(container!.textContent).toContain("打印 / 导出 PDF");
    expect(container!.textContent).toContain("下载 HTML");
  });

  it("默认归档名称：空单证号兜底、超长截断但保留 .pdf 后缀", () => {
    expect(defaultArchivePdfName(DOC_NO, "pi")).toBe(`${DOC_NO}.pdf`);
    expect(defaultArchivePdfName("", "pi")).toBe("pi.pdf");
    expect(defaultArchivePdfName("盖章件.pdf", "pi")).toBe("盖章件.pdf");

    const long = defaultArchivePdfName("N".repeat(200), "pi");
    expect(long.length).toBeLessThanOrEqual(ARCHIVE_NAME_MAX_LEN);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(validateArchivePdf(fileWithSize(long, 1024))).toBeNull();
  });
});
