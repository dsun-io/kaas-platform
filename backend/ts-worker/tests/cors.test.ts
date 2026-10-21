/** CORS 中间件单测——语义对齐 backend/worker/src/main.py cors_middleware。 */
import { describe, expect, it } from "vitest";

import app from "../src/index";

describe("cors middleware（对齐 Python cors_middleware）", () => {
  it("OPTIONS + 白名单 Origin → 204 且带允许头", async () => {
    const res = await app.request("/", {
      method: "OPTIONS",
      headers: { Origin: "https://kaas.powervoy.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://kaas.powervoy.com");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, X-Tenant-Id, X-Use-V2",
    );
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("OPTIONS + localhost:3000 在白名单内", async () => {
    const res = await app.request("/", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });

  it("OPTIONS + 非法 Origin → 回退默认来源（不回显）", async () => {
    const res = await app.request("/", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://kaas.powervoy.com");
  });

  it("普通 GET 响应带 CORS 头与 Vary: Origin", async () => {
    const res = await app.request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("普通 GET 无 Origin 头 → 默认来源", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://kaas.powervoy.com");
  });
});
