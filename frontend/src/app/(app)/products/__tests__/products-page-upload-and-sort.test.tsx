/**
 * 产品工位页面级测试：图片上传 `doUpload` + 图片排序（C2 文件存储收尾 · task-15）。
 *
 * 为什么要有这一层（hook 测试已经覆盖了分叉，但页面还有自己的责任）：
 * - **doUpload 的 toast 口径**：hook 会如实返回 `fellBackToProxy` / `fallbackReason`，
 *   页面必须把它说出来（直传失败却是"已上传"= 对象存储配错了永远没人发现）；
 *   没有回退（configured=false 或直传成功）时**不能**编造"回退"提示。
 * - **register 失败不回退**：字节已直传成功但登记失败时，hook 会抛可执行错误；
 *   页面必须原样提示，且**不许**自动重试/自动改走代理（否则同一份字节写两次）。
 * - **排序的位次语义**：页面负责"整体压成 0..n-1、只 PATCH 位次真的变了的图"，
 *   并把 `sort_order` 越界（后端 422，0–9999）的原因带给用户。
 *
 * 测试方式与仓库其它页面测试一致：没装 testing-library，用 react-dom createRoot + act
 * 直接驱动 DOM；数据层整模块 mock（`@/lib/products/use-products`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { toast } from "sonner";

import ProductsWorkstationPage from "../page";
import { sortErrorMessage, uploadErrorMessage } from "../upload-errors";

// ── 数据层 mock ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  uploadMutateAsync: vi.fn(),
  reorderMutate: vi.fn(),
  patchMutate: vi.fn(),
  retireMutate: vi.fn(),
  saveMutate: vi.fn(),
  fetchDirectUrl: vi.fn(),
  reorderOptions: null as null | {
    onSuccess?: () => void;
    onError?: (err: unknown) => void;
  },
  mediaItems: [] as Record<string, unknown>[],
  // 引用必须**稳定**：组件里 `useEffect(..., [profile.data])` 会对新对象再跑一次
  // setInfo → 新 data 又变 → 无限重渲染（vitest 会直接挂住）。这是 mock 的坑，不是组件的。
  profile: { product_key: "field_fence", info: {} as Record<string, unknown> },
}));

vi.mock("@/lib/products/use-products", () => ({
  useProducts: () => ({
    data: {
      items: [
        {
          product_key: "field_fence",
          name: "勾花网",
          name_en: "chain link fence",
          media_count: 0,
          profile: {},
        },
      ],
      media_kinds: {
        production: "生产图片",
        size: "尺寸图片",
        weight: "重量图片",
        finished: "成品图片",
        other: "其它",
      },
    },
    isLoading: false,
    isError: false,
  }),
  useProductMedia: () => ({
    data: { items: mocks.mediaItems, media_kinds: {} },
    isLoading: false,
  }),
  useProductProfile: () => ({ data: mocks.profile }),
  useSaveProductProfile: () => ({ mutate: mocks.saveMutate, isPending: false }),
  useUploadProductMedia: () => ({
    mutateAsync: mocks.uploadMutateAsync,
    isPending: false,
  }),
  useReorderProductMedia: () => ({
    mutate: (
      patches: { id: number; sort_order: number }[],
      options: { onSuccess?: () => void; onError?: (err: unknown) => void },
    ) => {
      mocks.reorderOptions = options;
      mocks.reorderMutate(patches);
    },
    isPending: false,
  }),
  usePatchFile: () => ({ mutate: mocks.patchMutate, isPending: false }),
  useRetireFile: () => ({ mutate: mocks.retireMutate, isPending: false }),
  useFileObjectUrl: () => ({ data: null, isError: false }),
  fetchFileDirectUrl: (...args: unknown[]) => mocks.fetchDirectUrl(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// 定义区（规格/利润/包装）与本次测试无关：页面级测试只关心"图片与基础信息"这一块。
vi.mock("../tabs/products-definitions-tab", () => ({
  ProductsDefinitionsTab: () => <div data-testid="stub-definitions">定义</div>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ── 渲染 / 驱动工具 ──────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

function flush(times = 3): Promise<void> {
  return new Promise((resolve) => {
    let left = times;
    const tick = () => {
      if (left-- <= 0) return resolve();
      setTimeout(tick, 0);
    };
    tick();
  });
}

function renderPage(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<ProductsWorkstationPage />);
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
  const found = Array.from(container.querySelectorAll("button")).find(
    (btn) => (btn.textContent ?? "").trim() === text,
  );
  if (!found) throw new Error(`找不到按钮「${text}」`);
  return found as HTMLButtonElement;
}

function buttonByAria(label: string): HTMLButtonElement {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`找不到 aria-label=「${label}」的按钮`);
  return found as HTMLButtonElement;
}

function nameInput(): HTMLInputElement {
  const found = container.querySelector(
    'input[placeholder^="如：勾花网"]',
  ) as HTMLInputElement | null;
  if (!found) throw new Error("找不到图片名称输入框");
  return found;
}

function fileInput(): HTMLInputElement {
  const found = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!found) throw new Error("找不到文件选择框");
  return found;
}

function setTextInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("拿不到 input.value setter");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setFileInput(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function selectProduct(): Promise<void> {
  const card = Array.from(container.querySelectorAll("button")).find((btn) =>
    (btn.textContent ?? "").includes("勾花网"),
  );
  if (!card) throw new Error("找不到产品卡片「勾花网」");
  await click(card);
}

/** 选好产品 + 填好文件名/类型/图片 —— 上传用例的公共前置。 */
async function prepareUpload(name = "主图"): Promise<File> {
  await selectProduct();
  const file = new File(["hello"], "hello.png", { type: "image/png" });
  setFileInput(fileInput(), file);
  setTextInput(nameInput(), name);
  return file;
}

function mediaRow(
  overrides: Partial<{
    id: number;
    name: string;
    sort_order: number;
    is_primary: boolean;
    media_kind: string;
  }> = {},
): Record<string, unknown> {
  const id = overrides.id ?? 11;
  return {
    id,
    name: overrides.name ?? `图 ${id}`,
    media_kind: overrides.media_kind ?? "production",
    kind: "product_photo",
    storage: "inline",
    object_key: null,
    content_type: "image/png",
    file_size: 5,
    is_primary: overrides.is_primary ?? false,
    sort_order: overrides.sort_order ?? 0,
    version: 1,
    created_at: "2026-10-21T00:00:00+00:00",
  };
}

function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reorderOptions = null;
  mocks.mediaItems = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ── A. doUpload 页面级行为 ───────────────────────────────────────────────────

describe("产品图上传 · doUpload 页面级行为", () => {
  it("① 直传成功：提示「已上传」（不得出现「直传失败/兜底」字样），并清空名称", async () => {
    mocks.uploadMutateAsync.mockResolvedValue({
      id: 1,
      name: "主图",
      fellBackToProxy: false,
    });
    renderPage();
    const file = await prepareUpload();

    await click(buttonByText("上传"));

    expect(mocks.uploadMutateAsync).toHaveBeenCalledTimes(1);
    // 页面把「文件 / 名称 / 类型」原样交给 hook（它是唯一的上传入口）
    expect(mocks.uploadMutateAsync).toHaveBeenCalledWith({
      file,
      name: "主图",
      mediaKind: "production",
    });
    expect(toast.success).toHaveBeenCalledWith("已上传");
    expect(toast.error).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast.success).mock.calls[0]![0])).not.toContain(
      "直传失败",
    );
    expect(nameInput().value).toBe("");
  });

  it("② 直传失败 → 服务端代理兜底：如实提示原因，且算上传成功", async () => {
    mocks.uploadMutateAsync.mockResolvedValue({
      id: 2,
      name: "主图",
      storage: "r2_binding",
      fellBackToProxy: true,
      fallbackReason: "直传被拒：HTTP 400",
    });
    renderPage();
    await prepareUpload();

    await click(buttonByText("上传"));

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(toast.success).mock.calls[0]![0]);
    expect(message).toContain("已上传");
    expect(message).toContain("直传失败");
    expect(message).toContain("直传被拒：HTTP 400");
    expect(message).toContain("已走服务端兜底");
    // 兜底成功也是一次成功上传 ⇒ 名称清空、可继续传下一张
    expect(nameInput().value).toBe("");
  });

  it("③ configured=false（没配对象存储）≠ 回退：只提示「已上传」", async () => {
    // hook 契约：没配对象存储时走服务端代传，但**不带**回退标记（设计如此）。
    mocks.uploadMutateAsync.mockResolvedValue({
      id: 3,
      name: "主图",
      storage: "inline",
      fellBackToProxy: false,
    });
    renderPage();
    await prepareUpload();

    await click(buttonByText("上传"));

    expect(toast.success).toHaveBeenCalledWith("已上传");
    const message = String(vi.mocked(toast.success).mock.calls[0]![0]);
    expect(message).not.toContain("直传失败");
    expect(message).not.toContain("兜底");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("④ 直传成功但登记失败：抛错不回退 —— 页面只上传一次、透出可执行原因、保留输入", async () => {
    mocks.uploadMutateAsync.mockRejectedValue(
      new Error(
        "图片已直传成功，但登记失败（HTTP 500）—— 请重试上传（字节不会重复写）",
      ),
    );
    renderPage();
    await prepareUpload();

    await click(buttonByText("上传"));

    // **只调一次**：页面没有自动重试、也没有自动改走代理（同一份字节写两次 = 重复对象）
    expect(mocks.uploadMutateAsync).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(toast.error).mock.calls[0]![0]);
    expect(message).toContain("登记失败");
    expect(message).toContain("HTTP 500");
    // 输入不清空：用户点「上传」就能重试（object_key 由 sha256 决定，重试幂等）
    expect(nameInput().value).toBe("主图");
  });

  it("前置校验：没选图 / 没命名时不上传，提示可执行的原因", async () => {
    mocks.uploadMutateAsync.mockResolvedValue({ id: 4, fellBackToProxy: false });
    renderPage();
    await selectProduct();

    await click(buttonByText("上传"));
    expect(toast.error).toHaveBeenCalledWith("先选一张图");
    expect(mocks.uploadMutateAsync).not.toHaveBeenCalled();

    setFileInput(fileInput(), new File(["x"], "x.png", { type: "image/png" }));
    await click(buttonByText("上传"));
    expect(toast.error).toHaveBeenCalledWith(
      "给图片起个名字（要求：上传后可命名）",
    );
    expect(mocks.uploadMutateAsync).not.toHaveBeenCalled();
  });
});

// ── B. 排序页面级行为 ────────────────────────────────────────────────────────

describe("产品图排序 · 页面级交互", () => {
  const PRIMARY = mediaRow({ id: 11, name: "主图", sort_order: 0, is_primary: true });
  const MIDDLE = mediaRow({ id: 12, name: "中间图", sort_order: 1 });
  const LAST = mediaRow({ id: 13, name: "末尾图", sort_order: 2 });

  beforeEach(() => {
    mocks.mediaItems = [PRIMARY, MIDDLE, LAST];
  });

  it("下移主图：把整体顺序压成 0..n-1，只 PATCH 位次真的变了的图，body 只有 sort_order", async () => {
    renderPage();
    await selectProduct();

    await click(buttonByAria("下移 主图"));

    expect(mocks.reorderMutate).toHaveBeenCalledTimes(1);
    // 移动后的顺序：[中间图, 主图, 末尾图] ⇒ 前两条位次变了，第三条没变不发
    expect(mocks.reorderMutate.mock.calls[0]![0]).toEqual([
      { id: 12, sort_order: 0 },
      { id: 11, sort_order: 1 },
    ]);
    // 请求体只带 sort_order（多带字段会被后端当成改别的属性）
    for (const patch of mocks.reorderMutate.mock.calls[0]![0] as {
      id: number;
      sort_order: number;
    }[]) {
      expect(Object.keys(patch).sort()).toEqual(["id", "sort_order"]);
    }
  });

  it("上移边界：主图恒排最前（第一张不能上移、第二张也不能越过主图），最后一张不能下移", async () => {
    renderPage();
    await selectProduct();

    expect(buttonByAria("上移 主图").disabled).toBe(true);
    expect(buttonByAria("上移 中间图").disabled).toBe(true);
    expect(buttonByAria("上移 末尾图").disabled).toBe(false);
    expect(buttonByAria("下移 末尾图").disabled).toBe(true);
  });

  it("设主图：PATCH body 只有 is_primary=true（不带无关字段）", async () => {
    renderPage();
    await selectProduct();

    const setPrimary = Array.from(container.querySelectorAll("button"))
      .filter((btn) => (btn.textContent ?? "").trim() === "设主图");
    // 主图那张的「设主图」是 disabled，能点的第一张是中间图
    const enabled = setPrimary.find((btn) => !(btn as HTMLButtonElement).disabled);
    if (!enabled) throw new Error("没有可点的「设主图」按钮");
    await click(enabled);

    expect(mocks.patchMutate).toHaveBeenCalledTimes(1);
    const [payload] = mocks.patchMutate.mock.calls[0]!;
    expect(payload).toEqual({ id: 12, is_primary: true });
    expect(Object.keys(payload as object)).not.toContain("sort_order");
  });

  it("排序成功：提示「顺序已更新」", async () => {
    renderPage();
    await selectProduct();
    await click(buttonByAria("下移 主图"));

    act(() => {
      mocks.reorderOptions?.onSuccess?.();
    });
    expect(toast.success).toHaveBeenCalledWith("顺序已更新");
  });

  it("sort_order 越界 422：把后端「0 ~ 9999」的原因带给用户（不是一句含糊的排序失败）", async () => {
    renderPage();
    await selectProduct();
    await click(buttonByAria("下移 主图"));

    act(() => {
      mocks.reorderOptions?.onError?.(
        httpError(422, {
          error: "validation",
          code: "SORT_ORDER_OUT_OF_RANGE",
          detail: "排序值需在 0 ~ 9999 之间",
        }),
      );
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(toast.error).mock.calls[0]![0]);
    expect(message).toContain("排序失败");
    expect(message).toContain("0 ~ 9999");
    expect(message).toContain("排序值需在");
  });

  it("其它排序错误（网络/5xx）：给可重试的通用提示", async () => {
    renderPage();
    await selectProduct();
    await click(buttonByAria("下移 主图"));

    act(() => {
      mocks.reorderOptions?.onError?.(httpError(500, { error: "internal" }));
    });
    expect(toast.error).toHaveBeenCalledWith("排序失败，请重试");
  });
});

// ── 错误文案口径纯函数（页面 catch 分支的规则）────────────────────────────────

describe("uploadErrorMessage / sortErrorMessage", () => {
  it("后端 400 detail（嵌套对象）原样透出：类型/大小/命名不合规时用户知道怎么改", () => {
    const err = httpError(400, {
      error: "validation",
      code: "UNSUPPORTED_MIME",
      detail: "只支持 PNG / JPG / WebP",
    });
    expect(uploadErrorMessage(err)).toBe("只支持 PNG / JPG / WebP");
  });

  it("扁平错误体（{error_code,message}）也认", () => {
    const err = httpError(413, {
      error_code: "FILE_TOO_LARGE",
      message: "文件超过 8MB 上限",
    });
    expect(uploadErrorMessage(err)).toBe("文件超过 8MB 上限");
  });

  it("axios 通用文案没有信息量 ⇒ 换成可执行兜底提示", () => {
    expect(uploadErrorMessage(httpError(400, {}))).toBe(
      "上传失败（类型/大小/命名不合规时后端会明确拒绝）",
    );
    expect(uploadErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "上传失败（类型/大小/命名不合规时后端会明确拒绝）",
    );
  });

  it("我方 hook 抛的可执行 Error 优先于兜底文案", () => {
    expect(
      uploadErrorMessage(new Error("图片已直传成功，但登记失败（HTTP 500）")),
    ).toBe("图片已直传成功，但登记失败（HTTP 500）");
  });

  it("排序 422 带后端原因；非 422 / 422 无 detail 用通用提示", () => {
    expect(
      sortErrorMessage(
        httpError(422, { code: "SORT_ORDER_OUT_OF_RANGE", detail: "排序值需在 0 ~ 9999 之间" }),
      ),
    ).toBe("排序失败：排序值需在 0 ~ 9999 之间");
    expect(sortErrorMessage(httpError(500, { error: "internal" }))).toBe(
      "排序失败，请重试",
    );
    expect(sortErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "排序失败，请重试",
    );
  });
});
