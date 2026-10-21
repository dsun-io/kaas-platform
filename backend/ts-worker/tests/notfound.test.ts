import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("未知 API 路由 404 信封", () => {
  it("/api/* 未知路径返回 JSON {'detail':'Not Found'}（对齐 FastAPI）", async () => {
    const res = await app.request("/api/v1/files", {}, { JWT_SECRET: "x" } as never);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ detail: "Not Found" });
  });

  it("非 /api 未知路径保持纯文本 404（资产回退语义）", async () => {
    const res = await app.request("/no-such-page", {}, { JWT_SECRET: "x" } as never);
    expect(res.status).toBe(404);
  });
});
