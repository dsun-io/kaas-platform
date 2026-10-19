// 只有配置了 DSN 才加载 Sentry SDK。
//
// 之前是无条件顶层 import + init({ enabled: false })：即使 DSN 为空，整个浏览器 SDK
// （browser + replay + feedback + canvas）也会被打进客户端包，并在**每次页面加载**时执行。
// NEXT_PUBLIC_SENTRY_DSN 是构建期内联常量，为空时下面的分支会被直接消除。
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void import('@sentry/nextjs').then((Sentry) => {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
    });
  });
}

// Next 16 / Sentry 10 的客户端导航埋点要求导出 `onRouterTransitionStart`。
// 保持「无 DSN 不加载 SDK」的既有优化：只有配了 DSN 才动态 import 并上报，
// 因此这里导出的是轻量 wrapper，而不是直接 `Sentry.captureRouterTransitionStart`。
export function onRouterTransitionStart(
  href: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  if (!dsn) return;
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.captureRouterTransitionStart(href, navigationType);
  });
}
