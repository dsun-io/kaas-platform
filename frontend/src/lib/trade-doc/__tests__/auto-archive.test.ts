import { beforeEach, describe, expect, it, vi } from "vitest";

import apiClient from "@/lib/api/client";
import { renderTradeDoc } from "@/lib/trade-doc/render";
import { autoArchiveIssuedDoc } from "@/lib/trade-doc/auto-archive";

vi.mock("@/lib/api/client", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("@/lib/trade-doc/render", () => ({
  renderTradeDoc: vi.fn(() => "<html>doc</html>"),
}));

const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);

describe("autoArchiveIssuedDoc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({
      data: { doc: { doc_type: "ci" }, data: { currency: "USD" } },
    } as never);
    post.mockResolvedValue({ data: { bytes: 2048 } } as never);
  });

  it("签发后取 render-data → 渲染 HTML → 调 /pdf 归档", async () => {
    const result = await autoArchiveIssuedDoc(7);

    expect(get).toHaveBeenCalledWith("/trade-docs/7/render-data");
    expect(renderTradeDoc).toHaveBeenCalledWith("ci", { currency: "USD" });
    expect(post).toHaveBeenCalledWith("/trade-docs/7/pdf", {
      html: "<html>doc</html>",
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("渲染器未配置（503）→ 明确提示手动归档，不假装成功", async () => {
    post.mockRejectedValue({ response: { status: 503 } });

    const result = await autoArchiveIssuedDoc(8);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("手动归档");
  });

  it("渲染接口失败 → 返回可读失败原因", async () => {
    get.mockRejectedValue({ response: { status: 404 } });

    const result = await autoArchiveIssuedDoc(9);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("自动归档失败");
  });
});
