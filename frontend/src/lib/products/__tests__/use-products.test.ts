import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { webcrypto } from "node:crypto";

import apiClient from "@/lib/api/client";

import {
  usePatchFile,
  useReorderProductMedia,
  useUploadProductMedia,
} from "../use-products";

vi.mock("@/lib/api/client", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

/**
 * 上传传输层替身（2026-10-22 起 hook 改用 XHR 拿进度）。
 *
 * 这里**不测 XHR 本身**（真实现的进度/头/错误形状在
 * `lib/api/__tests__/xhr-upload.test.ts` 里单独钉），只把 `xhrSend`/`xhrPostForm`
 * 映射回 fetch/axios 的既有形状 —— 这样本文件所有「字节到底发去哪、带了什么」的
 * 契约断言（PUT 预签名 URL、multipart 三件套、回退标记）一行都不用改，
 * 仍然在证明 hook 的分叉逻辑没走错。
 */
vi.mock("@/lib/api/xhr-upload", () => ({
  xhrSend: async (opts: {
    method: string;
    url?: string;
    path?: string;
    body: BodyInit;
    headers?: Record<string, string>;
  }) => {
    const res = await fetch(opts.url ?? opts.path ?? "", {
      method: opts.method,
      body: opts.body,
      headers: opts.headers,
    });
    return { ok: res.ok, status: res.status, text: "" };
  },
  xhrPostForm: async (path: string, form: FormData) => {
    const { data } = await apiClient.post(path, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return data;
  },
  XhrHttpError: class XhrHttpError extends Error {
    response: { status: number; data: unknown };
    constructor(status: number, data: unknown, message: string) {
      super(message);
      this.response = { status, data };
    }
  },
}));

/**
 * 产品图上传的**双路径**守卫。
 *
 * 这是"字节过不过服务端"的唯一分叉点：
 * - 配了对象存储（presign.configured=true）⇒ 字节直传预签名 URL，服务端只登记元数据；
 * - 没配 ⇒ 退回 multipart 让服务端代传（功能不缺失，只是字节经服务端中转）。
 *
 * 静默走错方向不会有任何报错：直传失败却仍登记元数据 ⇒ 库里有一条指向空对象
 * 的记录（图片永远打不开）；该直传时走了 multipart ⇒ 大文件把服务端当流量中转站。
 * 所以这里把三条路径都钉死在断言上。
 *
 * 生产验收补的一课（task-14）：直传**被拒**（S3 密钥填错 ⇒ R2 `400 InvalidArgument`）
 * 不能让用户的上传整体失败 —— 代理那条路（Worker `_store_bytes` 会回退 R2 binding/inline）
 * 本来就更能扛配错。回退可以，但**不许静默**：返回体必须带 `fellBackToProxy` + 原因。
 */
type GetResp = Awaited<ReturnType<typeof apiClient.get>>;
const ok = (data: unknown): GetResp => ({ data }) as unknown as GetResp;

/** 内容 "hello" 的 SHA-256（固定值，防止断言被改成"随便 64 位"） */
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const UPLOAD_URL = "https://r2.example.com/put/field_fence/hello.png?X-Amz-Signature=abc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function helloFile(): File {
  return new File(["hello"], "hello.png", { type: "image/png" });
}

const INPUT = { name: "主图", mediaKind: "production" } as const;

/**
 * 用 React 18 自带的 createRoot + act 渲染 hook（仓库没装 testing-library，
 * 见 vitest.config.ts：环境是 jsdom，无 setupFiles）。
 */
function renderHook<T>(useHook: () => T) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref: { current: T | null } = { current: null };

  function Probe() {
    ref.current = useHook();
    return null;
  }

  act(() => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });

  function hook() {
    const h = ref.current;
    if (!h) throw new Error("hook 还没渲染出来");
    return h;
  }

  return {
    hook,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      let out: T | undefined;
      await act(async () => {
        out = await fn();
      });
      return out as T;
    },
    /** 跑一次预期失败的 mutation，把错误原样带出来（不吞异常、不打印未处理拒绝） */
    async runCatching(fn: () => Promise<unknown>): Promise<unknown> {
      let caught: unknown;
      await act(async () => {
        try {
          await fn();
        } catch (err) {
          caught = err;
        }
      });
      return caught;
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
      client.clear();
    },
  };
}

function renderUploadHook() {
  return renderHook(() => useUploadProductMedia("field_fence"));
}

function renderReorderHook() {
  return renderHook(() => useReorderProductMedia());
}

function renderPatchFileHook() {
  return renderHook(() => usePatchFile());
}

/** 取第 n 次 POST 的 URL / body / config（调用序号本身就是契约的一部分） */
function posted(index: number) {
  const call = vi.mocked(apiClient.post).mock.calls[index];
  if (!call) throw new Error(`没有第 ${index} 次 POST`);
  return {
    url: String(call[0]),
    body: call[1] as Record<string, unknown>,
    form: call[1] as FormData,
    config: call[2] as { headers?: Record<string, string> },
  };
}

const MEDIA_RE = /\/media$/;

/** 造一个"服务端拒绝"的错误（带 response.status，让回退原因能带出 HTTP 码） */
function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

describe("产品图上传 · 直传优先与失败回退（字节不过服务端）", () => {
  let view: ReturnType<typeof renderUploadHook> | undefined;

  beforeAll(() => {
    // jsdom 的 crypto 没有 subtle（实测），sha256 走 node 的 webcrypto
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, "crypto", {
        value: webcrypto,
        configurable: true,
        writable: true,
      });
    }
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    view?.cleanup();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("configured=true：先 PUT 预签名 URL，再 register，且绝不走 multipart", async () => {
    const file = helloFile();
    const post = vi.mocked(apiClient.post);
    post.mockResolvedValueOnce(ok({ configured: true, upload_url: UPLOAD_URL }));
    post.mockResolvedValueOnce(ok({ id: 91, name: "主图", version: 1 }));

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    view = renderUploadHook();
    const v = view;
    const result = await v.run(() => v.hook().mutateAsync({ file, ...INPUT }));

    expect(result).toMatchObject({ id: 91, name: "主图" });
    // 直传走成了就不能报"已回退"
    expect(result.fellBackToProxy).toBe(false);
    expect(result.fallbackReason).toBeUndefined();

    // ① presign → ② PUT 直传 → ③ register（顺序固定）
    expect(post).toHaveBeenCalledTimes(2);
    expect(posted(0).url).toBe("/file-objects/presign");
    expect(posted(1).url).toBe("/file-objects/register");

    // ③ 不能顺带再走一遍 multipart（否则同一张图上传两次）
    expect(post.mock.calls.some(([url]) => MEDIA_RE.test(String(url)))).toBe(false);
    expect(post.mock.calls.some(([url]) => String(url).includes("/products/field_fence/media"))).toBe(
      false,
    );

    // 元数据齐（服务端据此定 object_key / 归属）
    expect(posted(0).body).toMatchObject({
      owner_type: "product",
      owner_id: "field_fence",
      kind: "product_photo",
      media_kind: "production",
      name: "主图",
      content_type: "image/png",
      size: 5,
      file_name: "hello.png",
    });

    // sha256 = 文件内容真实的 SHA-256（64 位小写十六进制），presign 与 register 必须一致
    expect(posted(0).body.sha256).toBe(HELLO_SHA256);
    expect(posted(1).body.sha256).toBe(HELLO_SHA256);
    expect(posted(1).body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(posted(1).body).toMatchObject({ owner_id: "field_fence", content_type: "image/png" });

    // PUT 打到 presign 给的地址，body 是文件本体、Content-Type 跟随文件
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [putUrl, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(putUrl).toBe(UPLOAD_URL);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(file);
    expect(init.headers).toMatchObject({ "Content-Type": "image/png" });
  });

  it("直传 PUT 400 ⇒ 不整体失败：回退 multipart 且带回退标记（真相不被吞掉）", async () => {
    const file = helloFile();
    const post = vi.mocked(apiClient.post);
    post.mockResolvedValueOnce(ok({ configured: true, upload_url: UPLOAD_URL }));
    post.mockResolvedValueOnce(ok({ id: 92, name: "主图", storage: "r2_binding" }));

    // 生产实测：S3 密钥填错时 R2 对预签名 PUT 直接回 400 InvalidArgument
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal("fetch", fetchMock);

    view = renderUploadHook();
    const v = view;
    const result = await v.run(() => v.hook().mutateAsync({ file, ...INPUT }));

    // 最终成功，但**如实**标记走了兜底（返回体里的 storage 说明字节落在哪）
    expect(result).toMatchObject({ id: 92, storage: "r2_binding" });
    expect(result.fellBackToProxy).toBe(true);
    expect(result.fallbackReason).toContain("直传被拒");
    expect(result.fallbackReason).toContain("HTTP 400");

    // 只 PUT 一次；**没有** register（字节没上去就登记 ⇒ 库里留一条指向空对象的记录）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2); // presign → media
    expect(posted(0).url).toBe("/file-objects/presign");
    expect(posted(1).url).toBe("/products/field_fence/media");
    expect(post.mock.calls.some(([url]) => String(url) === "/file-objects/register")).toBe(false);
    // 兜底那条路径本身必须是完整的（multipart 三件套都在）
    expect(posted(1).form.get("file")).toBe(file);
    expect(posted(1).form.get("name")).toBe("主图");
    expect(posted(1).form.get("media_kind")).toBe("production");
    expect(posted(1).config.headers?.["Content-Type"]).toBe("multipart/form-data");
  });

  it("直传 PUT 抛异常（网络/CORS）⇒ 同样回退 multipart，不整体失败", async () => {
    const file = helloFile();
    const post = vi.mocked(apiClient.post);
    post.mockResolvedValueOnce(ok({ configured: true, upload_url: UPLOAD_URL }));
    post.mockResolvedValueOnce(ok({ id: 93 }));

    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    view = renderUploadHook();
    const v = view;
    const result = await v.run(() => v.hook().mutateAsync({ file, ...INPUT }));

    expect(result).toMatchObject({ id: 93 });
    expect(result.fellBackToProxy).toBe(true);
    expect(result.fallbackReason).toContain("直传异常");
    expect(result.fallbackReason).toContain("Failed to fetch");
    expect(posted(1).url).toBe("/products/field_fence/media");
  });

  it.each([500, 403])(
    "presign 自身 %i ⇒ 依然回退 multipart（代理那条路可能还是好的）",
    async (status) => {
      const file = helloFile();
      const post = vi.mocked(apiClient.post);
      post.mockRejectedValueOnce(httpError(status));
      post.mockResolvedValueOnce(ok({ id: 94 }));

      const fetchMock = vi.fn(() => {
        throw new Error("presign 都没成功，不该有直传 PUT");
      });
      vi.stubGlobal("fetch", fetchMock);

      view = renderUploadHook();
      const v = view;
      const result = await v.run(() => v.hook().mutateAsync({ file, ...INPUT }));

      expect(result).toMatchObject({ id: 94 });
      expect(result.fellBackToProxy).toBe(true);
      expect(result.fallbackReason).toContain("预签名失败");
      expect(result.fallbackReason).toContain(`HTTP ${status}`);
      // presign(失败) → media；没有 register，也没有盲目的 PUT
      expect(post).toHaveBeenCalledTimes(2);
      expect(posted(0).url).toBe("/file-objects/presign");
      expect(posted(1).url).toBe("/products/field_fence/media");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("字节已直传成功但 register 失败：明确报错，**不回退重传**（避免重复对象/重复流量）", async () => {
    // 取舍理由：此刻字节已经落在对象存储里（流量已付），若默默改走 multipart，
    // 同一份字节会被服务端再写一次 ⇒ 重复对象 + 重复流量；而 object_key 由 sha256 决定，
    // 用户重试本身幂等 ⇒ 选"报错让用户重试"，并在文案里说清"字节已上去、登记没成"。
    const file = helloFile();
    const post = vi.mocked(apiClient.post);
    post.mockResolvedValueOnce(ok({ configured: true, upload_url: UPLOAD_URL }));
    post.mockRejectedValueOnce(httpError(500)); // register 失败

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    view = renderUploadHook();
    const v = view;
    const err = await v.runCatching(() => v.hook().mutateAsync({ file, ...INPUT }));

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("登记失败");
    expect((err as Error).message).toContain("HTTP 500");
    // 字节只写一次；没有再走 multipart（否则同一份字节写两次）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(posted(0).url).toBe("/file-objects/presign");
    expect(posted(1).url).toBe("/file-objects/register");
    expect(post.mock.calls.some(([url]) => MEDIA_RE.test(String(url)))).toBe(false);
  });
});

describe("产品图上传 · 未配对象存储时回退 multipart", () => {
  let view: ReturnType<typeof renderUploadHook> | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    view?.cleanup();
    vi.unstubAllGlobals();
  });

  it("configured=false：走 /products/{key}/media，FormData 带 file/name/media_kind", async () => {
    const file = helloFile();
    const post = vi.mocked(apiClient.post);
    post.mockResolvedValueOnce(ok({ configured: false }));
    post.mockResolvedValueOnce(ok({ id: 5, name: "主图" }));

    const fetchMock = vi.fn(() => {
      throw new Error("没配对象存储时不该有直传 PUT");
    });
    vi.stubGlobal("fetch", fetchMock);

    view = renderUploadHook();
    const v = view;
    const result = await v.run(() => v.hook().mutateAsync({ file, ...INPUT }));

    expect(result).toMatchObject({ id: 5 });
    // 没配对象存储 = 设计如此，不算"回退"，界面不该被吓到
    expect(result.fellBackToProxy).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(2);
    expect(posted(0).url).toBe("/file-objects/presign");
    expect(posted(0).body.sha256).toBe(HELLO_SHA256);

    // ② 回退：multipart 到产品媒体接口（不是 register）
    expect(posted(1).url).toBe("/products/field_fence/media");
    const form = posted(1).form;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("file")).toBe(file);
    expect(form.get("name")).toBe("主图");
    expect(form.get("media_kind")).toBe("production");
    // 必须显式声明 multipart，否则 axios 会把它当 JSON 发出去（文件传丢）
    expect(posted(1).config.headers?.["Content-Type"]).toBe("multipart/form-data");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("configured=true 但没给 upload_url：同样回退，不空 PUT", async () => {
    const file = helloFile();
    const post = vi.mocked(apiClient.post);
    post.mockResolvedValueOnce(ok({ configured: true }));
    post.mockResolvedValueOnce(ok({ id: 6 }));

    const fetchMock = vi.fn(() => {
      throw new Error("没有 upload_url 时不该直传");
    });
    vi.stubGlobal("fetch", fetchMock);

    view = renderUploadHook();
    const v = view;
    const result = await v.run(() => v.hook().mutateAsync({ file, ...INPUT }));

    expect(result).toMatchObject({ id: 6 });
    // configured=true 却不给 URL 是服务端异常 ⇒ 如实标记为回退（别当成"没配"）
    expect(result.fellBackToProxy).toBe(true);
    expect(result.fallbackReason).toContain("upload_url");
    expect(post).toHaveBeenCalledTimes(2);
    expect(posted(1).url).toBe("/products/field_fence/media");
    expect(posted(1).form.get("media_kind")).toBe("production");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("crypto.subtle 不可用（jsdom/非安全上下文）：不崩，跳过直传直接代传并标记回退", async () => {
    // 模拟非安全上下文：crypto 存在但没有 subtle（HTTP 明文页面实测形态）。
    // beforeAll 已把 webcrypto polyfill 进来，这里临时剥掉 subtle。
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const file = helloFile();
      const post = vi.mocked(apiClient.post);
      post.mockResolvedValueOnce(ok({ id: 7, name: "主图" }));

      const fetchMock = vi.fn(() => {
        throw new Error("没有 sha256 时不该发直传 PUT");
      });
      vi.stubGlobal("fetch", fetchMock);

      view = renderUploadHook();
      const v = view;
      const result = await v.run(() => v.hook().mutateAsync({ file, ...INPUT }));

      expect(result).toMatchObject({ id: 7, name: "主图" });
      // 功能不缺失：服务端代传照样成功，但回退真相必须带出来
      expect(result.fellBackToProxy).toBe(true);
      expect(String(result.fallbackReason)).toContain("crypto.subtle");

      // 只发了 multipart 这一次 POST：没有 presign（sha256 算不出）、没有 register、没有 PUT
      expect(post).toHaveBeenCalledTimes(1);
      expect(String(post.mock.calls[0]![0])).toBe("/products/field_fence/media");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });
});

/**
 * 产品图排序（task-6 新增）。
 *
 * ⚠️ 范围说明：「只对位次真的变了的图发请求」的**过滤**发生在页面
 * （`app/(app)/products/page.tsx` 的 `moveMedia`：`if (m.sort_order !== i) patches.push(...)`），
 * 不是在 hook 里。所以这里钉的是 **hook 契约**：调用方给什么就发什么（不自己全量重排、
 * 不做"交换两张"的误动作）、请求体形状、并发、空补丁不发请求、失败必须冒泡给
 * 调用方的 `onError`（页面据此 `toast.error("排序失败，请重试")`）。
 */
describe("产品图排序 · useReorderProductMedia 的请求契约", () => {
  let view: ReturnType<typeof renderReorderHook> | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    view?.cleanup();
  });

  it("按传入顺序逐条 PATCH /file-objects/{id}，body 只有 sort_order，且并发发出", async () => {
    const patch = vi.mocked(apiClient.patch);
    // 挂起所有 PATCH：用来证明"第 2 条没等第 1 条 resolve 就发出去了"（并发，不是串行）
    const resolvers: ((value: GetResp) => void)[] = [];
    patch.mockImplementation(
      () =>
        new Promise<GetResp>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    view = renderReorderHook();
    const v = view;
    const box: { p?: Promise<unknown> } = {};

    await act(async () => {
      box.p = v.hook().mutateAsync([
        { id: 11, sort_order: 0 },
        { id: 12, sort_order: 1 },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 两条都发出去了 → Promise.all 并发；串行实现只会发出 1 条
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls.map(([url, body]) => [String(url), body])).toEqual([
      ["/file-objects/11", { sort_order: 0 }],
      ["/file-objects/12", { sort_order: 1 }],
    ]);

    await act(async () => {
      resolvers.forEach((resolve) => resolve(ok({})));
      await box.p;
    });
  });

  it("调用方只给一条（页面对比位次后过滤的结果）⇒ 只发这一条；空补丁一条都不发", async () => {
    const patch = vi.mocked(apiClient.patch).mockResolvedValue(ok({}));

    view = renderReorderHook();
    const v = view;

    await v.run(() => v.hook().mutateAsync([{ id: 12, sort_order: 0 }]));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(String(patch.mock.calls[0]![0])).toBe("/file-objects/12");
    expect(patch.mock.calls[0]![1]).toEqual({ sort_order: 0 });

    // 点了个"本来就在正确位次"的图 ⇒ 页面过滤出空数组：不发请求，也不报错
    await v.run(() => v.hook().mutateAsync([]));
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("任一条 PATCH 失败 ⇒ mutateAsync 抛错（不静默成功）", async () => {
    const patch = vi.mocked(apiClient.patch);
    patch.mockResolvedValueOnce(ok({}));
    patch.mockRejectedValueOnce(new Error("422 SORT_ORDER_OUT_OF_RANGE"));

    view = renderReorderHook();
    const v = view;

    const err = await v.runCatching(() =>
      v.hook().mutateAsync([
        { id: 21, sort_order: 0 },
        { id: 22, sort_order: 100000 },
      ]),
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("SORT_ORDER_OUT_OF_RANGE");
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("失败会调调用方传的 onError（页面据此 toast.error，不静默）", async () => {
    const patch = vi.mocked(apiClient.patch);
    patch.mockRejectedValue(new Error("network"));

    view = renderReorderHook();
    const v = view;
    const onError = vi.fn();
    const onSuccess = vi.fn();

    await act(async () => {
      v.hook().mutate([{ id: 31, sort_order: 3 }], { onError, onSuccess });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("network");
  });
});

describe("usePatchFile · sort_order 入参（排序落库走这条）", () => {
  let view: ReturnType<typeof renderPatchFileHook> | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    view?.cleanup();
  });

  it("PATCH body 只带调用方给的字段（不给的字段不能变成 undefined 发上去）", async () => {
    const patch = vi.mocked(apiClient.patch).mockResolvedValue(ok({}));

    view = renderPatchFileHook();
    const v = view;

    await v.run(() => v.hook().mutateAsync({ id: 41, sort_order: 2 }));
    expect(String(patch.mock.calls[0]![0])).toBe("/file-objects/41");
    expect(patch.mock.calls[0]![1]).toEqual({ sort_order: 2 });

    await v.run(() => v.hook().mutateAsync({ id: 42, name: "主图" }));
    expect(String(patch.mock.calls[1]![0])).toBe("/file-objects/42");
    expect(patch.mock.calls[1]![1]).toEqual({ name: "主图" });
    expect(patch.mock.calls[1]![1]).not.toHaveProperty("sort_order");
  });
});
