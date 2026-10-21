/**
 * KaaS TS 门面 · 数据库访问封装（postgres.js）。
 *
 * 语义对齐 Python 侧 platform/db.py / main._acquire（ADR-004）：
 * **每请求建立一个 Hyperdrive 连接，请求结束关闭，不做任何跨请求池化**。
 * Hyperdrive 在边缘侧做连接池与预热，Worker 端再池化反而引入 isolate 生命周期问题。
 *
 * ⚠️ 本文件只是**连接与资源管理**壳；业务 SQL 按域迁移时逐条从 Python 侧直译，
 * 并在金标 harness（backend/ts-migration/golden/）下对照，禁止顺手"优化"。
 */
import postgres from "postgres";

import type { Env } from "./env";

/** 用 Hyperdrive 暴露的连接字段创建 postgres.js 客户端（对齐 asyncpg.connect(host/port/user/password/database, ssl=False)）。 */
export function createSql(env: Env): postgres.Sql {
  const hd = env.HYPERDRIVE;
  return postgres({
    host: hd.host,
    port: hd.port,
    user: hd.user,
    password: hd.password,
    database: hd.database,
    ssl: false, // 与 Python 侧一致：到 Hyperdrive 的连接不叠 TLS
    // Workers 上 postgres.js 的推荐项：
    max: 1, // 每请求单连接，等价语义下不池化
    fetch_types: false, // 省去逐列类型预取（Pyodide 端 asyncpg 无此层，行值为原生类型）
    prepare: false, // Workers 上不支持 prepared statement
  });
}

/**
 * 请求级数据库会话（对齐 Python async with acquire(request) as conn）。
 * 用法：
 *   const rows = await withDb(env, async (sql) => await sql`SELECT ...`);
 */
export async function withDb<T>(env: Env, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = createSql(env);
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}
