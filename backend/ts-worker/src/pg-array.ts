/**
 * PG 数组字面量编码（2026-10-21 W5 M1 生产实测新增）。
 *
 * 背景：src/db.ts 的 postgres.js 设了 fetch_types:false，该模式下 JS 数组参数
 * 会被错误序列化成扁平字符串 → Postgres 22P02 malformed array literal。
 * 显式字面量 {a,b} + ::text[] 强转是该配置下唯一可靠写法。
 */
export function pgTextArray(values: readonly string[]): string {
  const escaped = values.map((v) => {
    const s = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return '"' + s + '"';
  });
  return '{' + escaped.join(',') + '}';
}