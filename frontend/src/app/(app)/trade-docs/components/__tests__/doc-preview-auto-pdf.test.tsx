import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { toast } from "sonner";

import { DocPreview, fingerprintVerdict, renderMetaOf, type RenderFingerprintMeta } from "../doc-preview";
import type {
  RenderFingerprintCheck,
  RenderFingerprintReason,
} from "../../hooks/use-trade-docs";

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

async function mount(
  docId: number | null = DOC_ID,
  renderMeta?: RenderFingerprintMeta | null,
) {
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
        renderMeta={renderMeta}
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

/**
 * 签发时冻结的渲染指纹（C 方案）在预览区的那一行。
 *
 * 后端只在 `confirm` 成功时把 `raw_payload._render` 写进去 ⇒ "有这个键"就等价于"已签发"，
 * 所以前端不需要再判状态。三条断言对应三种坏法：显示不出来（功能白做）、
 * 草稿单据凭空多一行（样例场景被污染）、坏形状被渲染成 `vundefined`（看起来像真的）。
 */
describe("DocPreview · 渲染指纹（签发时冻结）", () => {
  const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef01";
  const FROZEN_AT = "2026-10-12T09:30:00+00:00";
  const META: RenderFingerprintMeta = {
    render_version: 1,
    input_sha256: SHA,
    frozen_at: FROZEN_AT,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(apiClient.post).mockResolvedValue(ok({ file: { id: 1 } }));
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

  it("有 renderMeta ⇒ 一行 `v1 · a1b2c3d4`，title 带完整 sha 与 frozen_at", async () => {
    await mount(DOC_ID, META);

    expect(container!.textContent).toContain("渲染指纹 v1 ·");
    expect(container!.textContent).toContain("a1b2c3d4");
    // 只显示前 8 位（完整值走 title，不糊在界面上）
    expect(container!.textContent).not.toContain(SHA);

    const line = Array.from(container!.querySelectorAll("p")).find((el) =>
      el.textContent?.includes("渲染指纹"),
    );
    expect(line).toBeTruthy();
    const title = line!.getAttribute("title") ?? "";
    expect(title).toContain(SHA);
    expect(title).toContain(FROZEN_AT);
    expect(title).toContain("v1");
  });

  it("没传 renderMeta（草稿 / 样板预览）⇒ 整行不出现", async () => {
    await mount();

    expect(container!.textContent).not.toContain("渲染指纹");
  });

  it("坏形状不渲染成 vundefined：renderMetaOf 一律返回 null", () => {
    // 没有 `_render` 键 / 值形状不对 ⇒ 不显示（而不是拼出 `vundefined · undefined`）
    expect(renderMetaOf(null)).toBeNull();
    expect(renderMetaOf(undefined)).toBeNull();
    expect(renderMetaOf({ sources: {}, custom: {} })).toBeNull();
    expect(renderMetaOf({ _render: "a1b2c3d4" })).toBeNull();
    expect(renderMetaOf({ _render: null })).toBeNull();
    expect(renderMetaOf({ _render: [1, 2] })).toBeNull();   // 数组的 typeof 也是 object
    expect(renderMetaOf({ _render: {} })).toBeNull();        // 没有 render_version ⇒ 不是指纹
    expect(renderMetaOf("{\"_render\":{}}")).toBeNull();
    // 正常形状原样取出
    expect(renderMetaOf({ _render: META })).toEqual(META);
  });

  it("装配失败时如实显示「未冻结」，不假装有摘要", async () => {
    await mount(DOC_ID, {
      render_version: 1,
      input_sha256: null,
      frozen_at: FROZEN_AT,
      note: "input_unavailable",
    });

    expect(container!.textContent).toContain("渲染指纹 v1 ·");
    expect(container!.textContent).toContain("未冻结");
  });
});

/**
 * 指纹对账（C 方案的消费者）：**点了才查**，按服务端 `reason` 显示一行结论。
 *
 * 三条不能坏的东西：
 * 1. **不能自动查**：对账要重新装配一遍渲染输入（含 data URI 图片/公章），成本不低 ——
 *    预览时就发请求等于每次打开单据都白花一次；
 * 2. **区分必须用 `reason`**，前端不自己比 sha（模板升级 ≠ 数据被改，只有服务端能区分）；
 * 3. **查不成 ≠ 有结论**：404/500 只能显示"核对失败"，绝不能显示成"已变更"或"一致"。
 */
describe("DocPreview · 指纹对账（点击才查）", () => {
  const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef01";
  const FROZEN_AT = "2026-10-12T09:30:00+00:00";
  const META: RenderFingerprintMeta = {
    render_version: 1,
    input_sha256: SHA,
    frozen_at: FROZEN_AT,
  };

  function checkResponse(
    reason: RenderFingerprintReason,
    over: Partial<RenderFingerprintCheck> = {},
  ): RenderFingerprintCheck {
    return {
      has_fingerprint: true,
      frozen: META,
      current_sha256: SHA,
      matches: reason === "matched",
      render_version_frozen: 1,
      render_version_current: 1,
      render_version_drift: reason === "version_drift",
      reason,
      checked_at: FROZEN_AT,
      current_note: null,
      frozen_note: null,
      ...over,
    };
  }

  const okGet = (data: unknown) =>
    ({ data }) as unknown as Awaited<ReturnType<typeof apiClient.get>>;

  /** 挂载（已签发）→ 设好端点返回 → 点「核对指纹」 */
  async function mountAndCheck(response: RenderFingerprintCheck) {
    await mount(DOC_ID, META);
    vi.mocked(apiClient.get).mockResolvedValue(okGet(response));
    await click("核对指纹");
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
    invalidate = null;
  });

  it("预览时不自动调对账端点（入口在，但一次请求都不发）", async () => {
    await mount(DOC_ID, META);

    expect(buttonByText("核对指纹")).toBeTruthy();
    expect(vi.mocked(apiClient.get)).not.toHaveBeenCalled();
    expect(container!.textContent).not.toContain("与签发时一致");
  });

  it("没有 renderMeta（草稿/样板预览）⇒ 连入口都不渲染", async () => {
    await mount();

    expect(container!.textContent).not.toContain("核对指纹");
    expect(vi.mocked(apiClient.get)).not.toHaveBeenCalled();
  });

  it("reason=matched ⇒「与签发时一致」", async () => {
    await mountAndCheck(checkResponse("matched"));

    expect(vi.mocked(apiClient.get)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(apiClient.get).mock.calls[0]![0])).toBe(
      `/trade-docs/${DOC_ID}/render-fingerprint-check`,
    );
    expect(container!.textContent).toContain("与签发时一致");
    expect(container!.textContent).not.toContain("已被修改");
  });

  it("reason=data_changed ⇒ 红色「签发后数据已被修改」（最重要的信号）", async () => {
    await mountAndCheck(
      checkResponse("data_changed", { matches: false, current_sha256: "ff".repeat(32) }),
    );

    expect(container!.textContent).toContain("签发后数据已被修改");
    const line = Array.from(container!.querySelectorAll("span")).find((el) =>
      el.textContent?.includes("签发后数据已被修改"),
    );
    expect(line?.className).toContain("text-destructive");
    expect(container!.textContent).not.toContain("与签发时一致");
  });

  it("reason=version_drift ⇒ 黄色「渲染模板已升级（数据未变）」", async () => {
    await mountAndCheck(
      checkResponse("version_drift", {
        render_version_frozen: 1,
        render_version_current: 2,
      }),
    );

    expect(container!.textContent).toContain("渲染模板已升级（数据未变）");
    const line = Array.from(container!.querySelectorAll("span")).find((el) =>
      el.textContent?.includes("渲染模板已升级"),
    );
    expect(line?.className).toContain("text-warning");
    // 模板升级 ≠ 数据被改：不能显示成"已被修改"
    expect(container!.textContent).not.toContain("签发后数据已被修改");
  });

  it("reason=current_unavailable ⇒ 灰色「无法判定（<note>）」，不说成一致/被改", async () => {
    await mountAndCheck(
      checkResponse("current_unavailable", {
        current_sha256: null,
        matches: false,
        current_note: "RuntimeError",
      }),
    );

    expect(container!.textContent).toContain("无法判定（RuntimeError）");
    expect(container!.textContent).not.toContain("与签发时一致");
    expect(container!.textContent).not.toContain("签发后数据已被修改");
  });

  it("reason=frozen_unavailable ⇒ 灰色「无法判定（签发时未冻结成功：…）」", async () => {
    await mountAndCheck(
      checkResponse("frozen_unavailable", {
        matches: false,
        frozen_note: "input_unavailable",
      }),
    );

    expect(container!.textContent).toContain("无法判定（签发时未冻结成功：input_unavailable）");
  });

  it("端点失败（500）⇒ 只说「核对失败，请重试」，且可以再点一次重试", async () => {
    await mount(DOC_ID, META);
    vi.mocked(apiClient.get).mockRejectedValueOnce(apiError(500, { detail: "boom" }));

    await click("核对指纹");

    expect(container!.textContent).toContain("核对失败，请重试");
    // 失败绝不能被说成结论
    expect(container!.textContent).not.toContain("签发后数据已被修改");
    expect(container!.textContent).not.toContain("与签发时一致");

    // 重试：再点一次会再发一次请求（失败不粘住入口）
    vi.mocked(apiClient.get).mockResolvedValue(okGet(checkResponse("matched")));
    await click("核对指纹");
    expect(vi.mocked(apiClient.get)).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain("与签发时一致");
    expect(container!.textContent).not.toContain("核对失败");
  });

  it("先成功后失败：不把上一次的「一致」当现状挂着", async () => {
    await mount(DOC_ID, META);
    vi.mocked(apiClient.get).mockResolvedValue(okGet(checkResponse("matched")));
    await click("核对指纹");
    expect(container!.textContent).toContain("与签发时一致");

    vi.mocked(apiClient.get).mockRejectedValueOnce(apiError(500, { detail: "boom" }));
    await click("核对指纹");

    expect(container!.textContent).toContain("核对失败，请重试");
    // 过期结论必须消失（否则等于拿上一次的结论当这一次的现状）
    expect(container!.textContent).not.toContain("与签发时一致");
  });

  it("结论映射是纯函数：覆盖全部 reason + 未知码兜底为「无法判定」", () => {
    expect(fingerprintVerdict(checkResponse("matched"))).toEqual({
      tone: "matched", text: "与签发时一致",
    });
    expect(fingerprintVerdict(checkResponse("data_changed")).tone).toBe("changed");
    expect(fingerprintVerdict(checkResponse("version_drift")).tone).toBe("drift");
    expect(fingerprintVerdict(checkResponse("no_fingerprint")).text).toContain("无法比对");
    expect(fingerprintVerdict(checkResponse("frozen_unavailable")).tone).toBe("unknown");
    expect(fingerprintVerdict(checkResponse("current_unavailable")).tone).toBe("unknown");
    // 服务端将来新增 reason：宁可"无法判定"，也不能猜一个结论
    const unknown = fingerprintVerdict({
      ...checkResponse("matched"), reason: "brand_new_reason" as RenderFingerprintReason,
    });
    expect(unknown).toEqual({ tone: "unknown", text: "无法判定（未知结论）" });
  });
});
