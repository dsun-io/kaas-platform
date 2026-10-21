/**
 * bcryptjs 对 Python 侧已知 $2b$ 哈希的校验——证明互通（已有用户密码哈希零迁移成本）。
 * 哈希由 backend/worker 的 Python venv 生成（tests/helpers.ts），非本仓库任何真实用户数据。
 */
import { describe, expect, it } from "vitest";

import { verifyPassword } from "../src/auth";
import { PYTHON_BCRYPT_HASH, TEST_PASSWORD } from "./helpers";

describe("verifyPassword（bcryptjs ↔ Python bcrypt $2b$ 互通）", () => {
  it("Python 生成的 $2b$ 哈希 + 正确密码 → true", async () => {
    expect(await verifyPassword(TEST_PASSWORD, PYTHON_BCRYPT_HASH)).toBe(true);
  });

  it("错误密码 → false", async () => {
    expect(await verifyPassword("wrong-password", PYTHON_BCRYPT_HASH)).toBe(false);
  });

  it("哈希格式完整保留 $2b$ 前缀与 cost 段", () => {
    expect(PYTHON_BCRYPT_HASH.startsWith("$2b$12$")).toBe(true);
  });
});
