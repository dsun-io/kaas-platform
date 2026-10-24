/**
 * XHR 上传传输层（`lib/api/xhr-upload.ts`）—— 无后端单测。
 *
 * 为什么单独测：产品图上传的所有「字节发去哪」断言都在
 * `products/__tests__/use-products.test.ts` 里，但那里把本模块替身掉了
 * （否则每个用例都要手搓 XHR）。真正的 XHR 行为——鉴权头、进度事件、
 * 非 2xx 不 reject、错误形状像 axios——只能在这里钉。
 *
 * 用假 XMLHttpRequest：记录 open/setRequestHeader/send，由用例手动触发
 * onload / onerror / upload.onprogress。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({
  accessToken: "tok-123" as string | null,
}));
const useV2Mock = vi.hoisted(() => ({ value: true }));

vi.mock("@/lib/auth/session-cache", () => ({
  getCurrentSession: () => ({ accessToken: sessionMock.accessToken }),
}));
vi.mock("../use-v2-resolver", () => ({
  resolveUseV2: () => useV2Mock.value,
}));
vi.mock("../config", () => ({
  API_BASE_URL: "https://api.example.com",
  API_MODE: "real",
  isMockMode: false,
}));

import { xhrPostForm, xhrSend, XhrHttpError } from "../xhr-upload";

class FakeXhr {
  static last: FakeXhr | null = null;

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  timeout = 0;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  send(body: unknown) {
    this.body = body;
  }

  /** 模拟上传进度 */
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({
      lengthComputable: total > 0,
      loaded,
      total,
    } as ProgressEvent);
  }

  finish(status: number, text = "") {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

const realXhr = globalThis.XMLHttpRequest;

beforeEach(() => {
  sessionMock.accessToken = "tok-123";
  useV2Mock.value = true;
  FakeXhr.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.XMLHttpRequest = realXhr;
});

describe("xhrSend", () => {
  it("站内路径自动补 baseURL，并带 Bearer 与 X-Use-V2（与 client.ts 同口径）", async () => {
    const p = xhrSend({
      method: "POST",
      path: "/products/x/media",
      body: new FormData(),
    });
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("https://api.example.com/api/v1/products/x/media");
    expect(xhr.headers.Authorization).toBe("Bearer tok-123");
    expect(xhr.headers["X-Use-V2"]).toBe("true");
    // 不再注入 X-Tenant-Id（租户恒 default，团队才是隔离边界）
    expect(xhr.headers["X-Tenant-Id"]).toBeUndefined();

    xhr.finish(201);
    await expect(p).resolves.toMatchObject({ ok: true, status: 201 });
  });

  it("绝对地址（预签名 URL）**不带**我们的鉴权头（S3 会当成签名不符）", async () => {
    const p = xhrSend({
      method: "PUT",
      url: "https://r2.example.com/put?a=1",
      body: new Blob(["x"]),
      headers: { "Content-Type": "image/png" },
    });
    const xhr = FakeXhr.last!;
    expect(xhr.url).toBe("https://r2.example.com/put?a=1");
    expect(xhr.headers.Authorization).toBeUndefined();
    expect(xhr.headers["X-Use-V2"]).toBeUndefined();
    expect(xhr.headers["Content-Type"]).toBe("image/png");

    xhr.finish(200);
    await expect(p).resolves.toMatchObject({ ok: true, status: 200 });
  });

  it("FormData body 时删掉作者设的 Content-Type —— boundary 只能由浏览器补", async () => {
    // 2026-10-24 线上事故：手写 "Content-Type: multipart/form-data" ⇒ XHR 不再补
    // "; boundary=…" ⇒ 内核 Starlette 400「Missing boundary in multipart.」。
    // 这里钉住兜底：即使调用方传了这个头，也不许发出去。
    const form = new FormData();
    const p = xhrSend({
      method: "POST",
      url: "https://r2.example.com/put",
      body: form,
      headers: { "Content-Type": "multipart/form-data", "X-Custom": "1" },
    });
    const xhr = FakeXhr.last!;
    expect(xhr.headers["Content-Type"]).toBeUndefined();
    expect(xhr.headers["X-Custom"]).toBe("1");
    xhr.finish(200);
    await p;

    // 大小写不敏感：小写形式同样删掉
    const p2 = xhrSend({
      method: "POST",
      url: "https://r2.example.com/put",
      body: new FormData(),
      headers: { "content-type": "multipart/form-data" },
    });
    expect(FakeXhr.last!.headers["content-type"]).toBeUndefined();
    FakeXhr.last!.finish(200);
    await p2;
  });

  it("没有 token 时不发 Authorization", async () => {
    sessionMock.accessToken = null;
    const p = xhrSend({ method: "POST", path: "/x", body: new FormData() });
    expect(FakeXhr.last!.headers.Authorization).toBeUndefined();
    FakeXhr.last!.finish(200);
    await p;
  });

  it("进度事件换算成 0–100 整数；total 未知时为 null", async () => {
    const seen: (number | null)[] = [];
    const p = xhrSend({
      method: "PUT",
      url: "https://r2.example.com/put",
      body: new Blob(["x"]),
      onProgress: (e) => seen.push(e.percent),
    });
    const xhr = FakeXhr.last!;
    xhr.emitProgress(0, 1000);
    xhr.emitProgress(250, 1000);
    xhr.emitProgress(1000, 1000);
    xhr.emitProgress(10, 0); // 服务端没给 total
    xhr.finish(200);
    await p;
    expect(seen).toEqual([0, 25, 100, null]);
  });

  it("HTTP 非 2xx 不 reject（交给调用方决定回退还是报错）", async () => {
    const p = xhrSend({
      method: "PUT",
      url: "https://r2.example.com/put",
      body: new Blob(["x"]),
    });
    FakeXhr.last!.finish(400, "InvalidArgument");
    await expect(p).resolves.toMatchObject({
      ok: false,
      status: 400,
      text: "InvalidArgument",
    });
  });

  it("网络错误 reject TypeError（hook 据此判定「直传异常」并回退）", async () => {
    const p = xhrSend({
      method: "PUT",
      url: "https://r2.example.com/put",
      body: new Blob(["x"]),
    });
    FakeXhr.last!.onerror?.();
    await expect(p).rejects.toBeInstanceOf(TypeError);
  });

  it("超时 reject，文案带秒数", async () => {
    const p = xhrSend({
      method: "PUT",
      url: "https://r2.example.com/put",
      body: new Blob(["x"]),
      timeoutMs: 5000,
    });
    FakeXhr.last!.ontimeout?.();
    await expect(p).rejects.toThrow(/超时（5s）/);
  });
});

describe("xhrPostForm", () => {
  it("2xx 返回解析后的 JSON", async () => {
    const p = xhrPostForm("/products/x/media", new FormData());
    FakeXhr.last!.finish(201, JSON.stringify({ id: 7, name: "主图" }));
    await expect(p).resolves.toEqual({ id: 7, name: "主图" });
  });

  it("不手写 Content-Type：浏览器才会补 boundary（线上 400 的根因回归）", async () => {
    const form = new FormData();
    const p = xhrPostForm("/products/x/media", form);
    const xhr = FakeXhr.last!;
    expect(xhr.headers["Content-Type"]).toBeUndefined();
    // 鉴权头不受影响（别为了修这个把整条路弄丢）
    expect(xhr.headers.Authorization).toBe("Bearer tok-123");
    expect(xhr.body).toBe(form);
    xhr.finish(201, "{}");
    await p;
  });

  it("非 2xx 抛 XhrHttpError，且 response.data 带后端错误体（upload-errors 依赖这个形状）", async () => {
    const p = xhrPostForm("/products/x/media", new FormData());
    FakeXhr.last!.finish(
      422,
      JSON.stringify({
        detail: { code: "FILE_TOO_LARGE", detail: "超过上限 8MB" },
      }),
    );
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XhrHttpError);
    const typed = err as XhrHttpError;
    expect(typed.response.status).toBe(422);
    expect(typed.response.data).toMatchObject({
      detail: { code: "FILE_TOO_LARGE", detail: "超过上限 8MB" },
    });
  });

  it("非 JSON 响应体不炸（按原文返回）", async () => {
    const p = xhrPostForm("/x", new FormData());
    FakeXhr.last!.finish(200, "OK");
    await expect(p).resolves.toBe("OK");
  });
});
