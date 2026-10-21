/**
 * KaaS TS 门面 · 鉴权原语（JWT 校验 + bcrypt 校验）。
 *
 * 只提供函数与单测，不接路由（路由按域迁移时接线）。
 *
 * 兼容性铁约束（OPTIMIZATION_PLAN §2 Phase 1）：
 * - JWT：HS256，与 Python 侧 pyjwt decode 语义对齐（校验 exp；Bearer 提取在调用方）；
 * - bcrypt：bcryptjs 与 Python bcrypt **$2b$ 格式互通**，已有用户密码哈希零迁移成本。
 *
 * 错误体对齐 Python _decode_token 的 envelope（401）：
 *   {"error": "unauthorized", "message": "Invalid or expired token"}
 */
import bcrypt from "bcryptjs";
import { jwtVerify } from "jose";

/** 与 Python 侧 JWT_ALGORITHM 同口径。 */
export const JWT_ALGORITHM = "HS256";

/** 401 错误 envelope（与 Python 侧 _decode_token 同形状；前端统一按 envelope 取 message）。 */
export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  readonly body = { error: "unauthorized", message: "Invalid or expired token" } as const;
  constructor() {
    super("Invalid or expired token");
    this.name = "UnauthorizedError";
  }
}

export interface JwtPayload {
  /** 用户 id（Python 侧 sub=str(user_id)）。 */
  sub: string;
  /** 过期时间（unix 秒）。 */
  exp?: number;
  /** 签发时间（unix 秒）。 */
  iat?: number;
  [key: string]: unknown;
}

/**
 * 校验 JWT（对齐 Python jwt.decode(token, secret, algorithms=["HS256"])）。
 * exp 过期与签名非法统一抛 UnauthorizedError（Python 侧两者同 401 envelope）。
 * secret 缺失属配置错误，抛 MissingSecretError（调用方转 503），绝不回退默认串。
 */
export async function verifyToken(token: string, secret: string): Promise<JwtPayload> {
  if (!secret) {
    throw new Error("JWT_SECRET not configured");
  }
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: [JWT_ALGORITHM],
    });
    // jose 默认校验 exp/nbf/iat；sub 必填（对齐 Python 侧 payload["sub"]）
    if (typeof payload.sub !== "string") {
      throw new UnauthorizedError();
    }
    return payload as JwtPayload;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError();
  }
}

/** 从 Authorization 头提取 Bearer token；缺失/非 Bearer 返回 null（Python 侧由调用方判 401 "Authentication required"）。 */
export function extractBearer(authorization: string | null | undefined): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

/**
 * 校验密码（对齐 Python bcrypt.checkpw(password.encode(), hashed.encode())）。
 * bcryptjs 与 C 实现 bcrypt 同格式族（$2a$/$2b$/$2y$ 互通），已有哈希零迁移。
 */
export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(password, hashed);
}
