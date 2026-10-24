/**
 * 产品类查询的「提示策略」—— 产品数据层（`use-products.ts` / `tenant-products.ts`）共用。
 *
 * `silent: true` = **失败时不弹全局 toast**（axios 的 `silent` 开关，见 `lib/api/client.ts`）。
 *
 * 为什么需要：2026-10-24 用户反馈「刷新页面后控制台大量报错、产品无法正常加载」——
 * 后端内核冷启动间歇 502 时，产品页一次并发 7~10 个查询，每个失败都弹一条
 * 「后端忙碌」+ 记一条 error，于是"一次抖动 = 一屏报错"。产品页/图库自己渲染
 * 明确的错误态（`ErrorState` + 重试按钮），所以这些查询应当静音。
 *
 * 为什么按调用方传、而不是把产品查询全局静音：同一批 hook 还被单证工位、报价行、
 * 询盘表单复用，那些页面没有产品页这套错误态，不能顺手把提示吞掉。
 * 留痕（Sentry breadcrumb）不受 `silent` 影响，排障信息不丢。
 */
export interface ProductQueryOptions {
  /** true = 失败不弹全局 toast，由调用方自己呈现错误态 */
  silent?: boolean;
}

/** 组装成 axios 请求配置；不需要静音时返回 undefined（不改变默认行为）。 */
export function queryConfig(opts?: ProductQueryOptions) {
  return opts?.silent ? { silent: true } : undefined;
}
