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
