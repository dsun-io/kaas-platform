/** JWT 校验单测（jose，HS256）——用固定 secret 签 known token 验通过/过期/错签。 */
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { extractBearer, UnauthorizedError, verifyToken } from "../src/auth";
import { FIXED_SECRET } from "./helpers";

const key = new TextEncoder().encode(FIXED_SECRET);
const now = Math.floor(Date.now() / 1000);

async function sign(claims: Record<string, unknown>, secret: string = FIXED_SECRET): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .setSubject("42");
  return jwt.sign(new TextEncoder().encode(secret));
}

describe("verifyToken（对齐 Python jwt.decode 语义）", () => {
  it("合法 token 通过，sub 原样返回", async () => {
    const token = await sign({ team_id: "t1" });
    const payload = await verifyToken(token, FIXED_SECRET);
    expect(payload.sub).toBe("42");
    expect(payload.team_id).toBe("t1");
  });

  it("过期 token → UnauthorizedError（Python 侧 ExpiredSignatureError 同 401 envelope）", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("42")
      .setIssuedAt(now - 1200)
      .setExpirationTime(now - 600)
      .sign(key);
    await expect(verifyToken(expired, FIXED_SECRET)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("错签 token（不同 secret）→ UnauthorizedError", async () => {
    const token = await sign({}, "another-secret-at-least-32-chars-x!");
    await expect(verifyToken(token, FIXED_SECRET)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("篡改 payload → UnauthorizedError", async () => {
    const token = await sign({});
    const [h, p] = token.split(".");
    const tampered = [h, Buffer.from(JSON.stringify({ sub: "7", exp: now + 600 })).toString("base64url"), "sig"].join(".");
    void p;
    await expect(verifyToken(tampered, FIXED_SECRET)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("缺 sub → UnauthorizedError（Python 侧 payload['sub'] 语义）", async () => {
    const noSub = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(now + 600)
      .sign(key);
    await expect(verifyToken(noSub, FIXED_SECRET)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("空 secret 视为未配置（绝不回退默认串）", async () => {
    const token = await sign({});
    await expect(verifyToken(token, "")).rejects.toThrow("JWT_SECRET not configured");
  });
});

describe("extractBearer（对齐 Python Authorization.startswith('Bearer ')）", () => {
  it("提取 token", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });
  it("缺失/非 Bearer → null", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
  });
});
