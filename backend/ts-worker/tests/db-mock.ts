/**
 * ../src/db 的测试替身（vi.mock 工厂指向本模块）。
 * 路由层只依赖 withDb(env, fn)；这里把它接到 helpers.fakeSql，不建真实连接。
 */
import { fakeSql } from "./helpers";

export async function withDb<T>(
  _env: unknown,
  fn: (sql: typeof fakeSql) => T | Promise<T>,
): Promise<T> {
  return fn(fakeSql);
}

export function createSql(): never {
  throw new Error("createSql is not available in unit tests (use withDb mock)");
}
