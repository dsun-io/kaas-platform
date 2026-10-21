/** /health 探针单测。 */
import { describe, expect, it } from "vitest";

import app from "../src/index";

describe("GET /health", () => {
  it("返回 200 {status:'ok', service:'kaas-edge'}", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok", service: "kaas-edge" });
  });
});
