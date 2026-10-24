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
export const dbState: {
  calls: DbCall[];
  handler: DbHandler;
  /**
   * 工位订阅桩（2026-10-24）：
   * 门面新增「工位闸门」中间件（src/workstation-gate.ts），开关 on 时会对**收费工位前缀**的请求
   * 查一次 team_subscriptions/user_subscriptions。这里集中给一个默认值，避免几十个既有用例
   * 各自补桩；**闸门本身的拒绝路径**在 tests/workstation-gate.test.ts 里显式设空断言。
   * 默认 full_chain = 开通全部工位（与"已付费客户"的常态一致）。
   */
  subscriptionCodes: string[];
} = {
  calls: [],
  handler: () => [],
  subscriptionCodes: ["full_chain"],
};

export function resetDb(handler: DbHandler = () => []): void {
  dbState.calls.length = 0;
  dbState.handler = handler;
  dbState.subscriptionCodes = ["full_chain"];
}

/** 只改订阅桩（闸门用例用：设 [] 即"未开通任何工位"）。 */
export function resetSubscriptions(codes: string[]): void {
  dbState.subscriptionCodes = codes;
}

/** 取包含某 SQL 片段的调用（断言 tenant/owner 过滤条件、绑定参数用）。 */
export function dbCallsContaining(fragment: string): DbCall[] {
  return dbState.calls.filter((call) => call.query.includes(fragment));
}

function record(query: string, params: unknown[]): Promise<DbRow[]> {
  dbState.calls.push({ query, params });
  // 只有**工位闸门**的订阅查询由共享桩回答（SQL 里带 /*gate*/ 标记，见 src/routes/workstations.ts）；
  // 其它订阅查询（如 /me/workstations）仍交给各测试自己的桩，避免被劫持。
  // 顺序：先让测试自己的 handler 有机会回答（可用于模拟"DB 抛错 ⇒ 闸门放行"）；它给空数组时
  // 才回落到 subscriptionCodes 默认值。
  if (query.includes("/*gate*/") && (query.includes("FROM team_subscriptions") || query.includes("FROM user_subscriptions"))) {
    const fromHandler = dbState.handler(query, params);
    if (Array.isArray(fromHandler) && fromHandler.length > 0) return Promise.resolve(fromHandler);
    return Promise.resolve(dbState.subscriptionCodes.map((code) => ({ code })));
  }
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
