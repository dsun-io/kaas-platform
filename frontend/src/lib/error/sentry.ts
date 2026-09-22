// 未配置 DSN 时完全不加载 Sentry SDK（懒加载）：
// 顶层静态 import 会把浏览器 SDK 拉进首屏包，而 .env.production 里 DSN 为空时
// SDK 实际上什么也不做——即“关闭却仍在加载”。
// 配置 NEXT_PUBLIC_SENTRY_DSN 后即可自动启用，调用方无需改动。

type SentryModule = typeof import('@sentry/nextjs');

let sentryPromise: Promise<SentryModule> | null = null;

function loadSentry(): Promise<SentryModule> | null {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return null;
  sentryPromise ??= import('@sentry/nextjs');
  return sentryPromise;
}

export function captureException(error: unknown, extra?: Record<string, unknown>) {
  void loadSentry()
    ?.then((Sentry) => Sentry.captureException(error, { extra }))
    .catch(() => {});
}

export function addBreadcrumb(breadcrumb: {
  category: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}) {
  void loadSentry()
    ?.then((Sentry) => Sentry.addBreadcrumb(breadcrumb))
    .catch(() => {});
}

export function setContext(name: string, context: Record<string, unknown>) {
  void loadSentry()
    ?.then((Sentry) => Sentry.setContext(name, context))
    .catch(() => {});
}
