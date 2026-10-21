/** 测试共享常量与请求期 env/DB 注入（Hono app.request 第三参 + withDb mock）。 */
import type { Env } from "../src/env";

/** bcrypt 哈希由 Python 侧生成（backend/worker venv，cost 12），证明 $2b$ 互通。 */
export const PYTHON_BCRYPT_HASH = "$2b$12$tQlccOVrGR5rA9lgHXiK9e.m0.05ExyC.KPs4h8fucs0IhrX69XdW";
export const TEST_PASSWORD = "ts-interop-test-password";
export const FIXED_SECRET = "ts-edge-test-secret-at-least-32-chars!!";

/** 请求期 env（Workers 上由 c.env 注入；测试用 app.request 第三参等价注入）。 */
export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    HYPERDRIVE: {
      host: "localhost",
      port: 5432,
      user: "test",
      password: "test",
      database: "test",
    },
    FILES: {} as unknown as Env["FILES"],
    BROWSER: {},
    KERNEL: { fetch: async () => new Response("{}", { status: 200 }) },
    S3_ENDPOINT: "http://localhost",
    S3_BUCKET: "test-bucket",
    S3_REGION: "auto",
    S3_PRESIGN_EXPIRES: "900",
    JWT_SECRET: FIXED_SECRET,
    ...overrides,
  } as Env;
}

export const TEST_ENV = makeTestEnv();

/** 假 DB 行（路由层只按列名读取，不需要真实表结构）。 */
export type DbRow = Record<string, unknown>;

export interface DbCall {
  query: string;
  params: unknown[];
}

type DbHandler = (query: string, params: unknown[]) => DbRow[] | Promise<DbRow[]>;

/**
 * 惰性 DB 桩：每个测试在 beforeEach 里 resetDb(handler)，按 SQL 片段返回行。
 * 这是「env 注入 + sql mock」模式的单一入口——测试不触网、不建 postgres.js 连接。
 */
export const dbState: { calls: DbCall[]; handler: DbHandler } = {
  calls: [],
  handler: () => [],
};

export function resetDb(handler: DbHandler = () => []): void {
  dbState.calls.length = 0;
  dbState.handler = handler;
}

/** 取包含某 SQL 片段的调用（断言 tenant/owner 过滤条件、绑定参数用）。 */
export function dbCallsContaining(fragment: string): DbCall[] {
  return dbState.calls.filter((call) => call.query.includes(fragment));
}

function record(query: string, params: unknown[]): Promise<DbRow[]> {
  dbState.calls.push({ query, params });
  return Promise.resolve(dbState.handler(query, params));
}

/** postgres.js 的最小可用替身：tagged template + unsafe + begin + json。 */
const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<DbRow[]> => {
  const query = strings.reduce(
    (acc, part, index) => acc + part + (index < values.length ? "?" : ""),
    "",
  );
  return record(query, values);
}) as unknown as {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<DbRow[]>;
  unsafe(query: string, params?: unknown[]): Promise<DbRow[]>;
  begin<T>(fn: (tx: unknown) => T | Promise<T>): Promise<T>;
  json(value: unknown): unknown;
  end(): Promise<void>;
};

fakeSql.unsafe = (query: string, params: unknown[] = []) => record(query, params);
fakeSql.begin = async <T>(fn: (tx: unknown) => T | Promise<T>): Promise<T> => fn(fakeSql);
fakeSql.json = (value: unknown): unknown => value;
fakeSql.end = async (): Promise<void> => undefined;

export { fakeSql };
