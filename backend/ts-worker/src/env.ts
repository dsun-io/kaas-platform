/**
 * KaaS TS 门面 · Bindings 类型声明（ADR-008）。
 *
 * 取值纪律（对齐 Python 侧 main._binding 的请求期读取）：
 * Workers 上 env 天然按请求注入 c.env，不存在 Python import 期 os.environ 为空的历史坑；
 * 但仍保持「绝不保留公开默认值」的铁律——secret 缺失一律显式报错，不回退默认串
 * （2026-10-19 生产实证教训：JWT_SECRET 回退默认串 = 任何人可伪造管理员 token）。
 */

/** Hyperdrive 绑定暴露的连接字段（postgres.js 直连用，与 Python 侧 hd.host/... 同口径）。 */
export interface HyperdriveBinding {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Python 内核 Worker 的 Service Binding（wrangler.jsonc services 绑定 KERNEL）。 */
export interface KernelBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface Env {
  // ── 平台绑定 ──
  HYPERDRIVE: HyperdriveBinding;
  FILES: R2Bucket;
  /** Browser Rendering binding（单证 PDF quickAction）。 */
  BROWSER: unknown; // TODO(TODO:TS1) workers-types 的 Browser 类型接入后收窄
  /** Python 内核 Service Binding（见 kernel.ts）。 */
  KERNEL: KernelBinding;

  // ── 非机密 vars（值与 backend/worker/wrangler.jsonc 对齐）──
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_PRESIGN_EXPIRES: string;
  /** 前端基址（重置密码链接用；对齐 Python _binding("FRONTEND_BASE_URL")，未配则回退官方域名）。 */
  FRONTEND_BASE_URL?: string;

  // ── secrets（占位：wrangler secret put 写入，绝不入仓/打印）──
  /** JWT HS256 签名密钥。缺失 = 503（对齐 Python _jwt_secret）。 */
  JWT_SECRET: string;
  /** Resend 发信密钥。 */
  RESEND_API_KEY?: string;
  /** admin bootstrap 一次性令牌（对齐 Python ADMIN_SETUP_TOKEN）。 */
  ADMIN_SETUP_TOKEN?: string;
  /** S3 预签名机密（S3 直传路径用；未配置时由 R2 binding/inline 接管，同 ADR-003）。 */
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;

  [key: string]: unknown;
}

/** 从 Hono context 取 env（类型收窄）。 */
export function getEnv(c: { env: unknown }): Env {
  return c.env as Env;
}

/**
 * 必填 secret 取值（对齐 Python _jwt_secret：缺失即视为未配置，绝不回退默认值）。
 * 调用方应将其转成 503 响应。
 */
export function requireSecret(env: Env, key: "JWT_SECRET" | "RESEND_API_KEY" | "ADMIN_SETUP_TOKEN" | "S3_ACCESS_KEY" | "S3_SECRET_KEY"): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MissingSecretError(key);
  }
  return value;
}

export class MissingSecretError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`${key} not configured`);
    this.name = "MissingSecretError";
    this.key = key;
  }
}
