import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 并发安全：构建产物目录可由环境变量覆盖（NEXT_DIST_DIR）。
  // 为什么需要：同一 worktree 里若有 `next dev` 在跑，它和 `next build` 会互相
  // 破坏默认的 `.next`（实测报 Cannot find module '.next/server/middleware-manifest.json'），
  // 于是"构建门禁"在某些时刻根本跑不起来。换目录即可并存，不必停别人的 dev。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  // 本地预览不显示 Next dev 指示器：它固定在左下角，会压在侧栏上（2026-10-20 用户反馈）。
  devIndicators: false,
  // Next 15.5+：typedRoutes 从 experimental 提升为顶层选项（Next 16 仍支持）
  typedRoutes: true,
  // Cloudflare deploy: static export (assets-only Worker). Rewrites only apply
  // in dev/server mode; the exported site calls the API directly via
  // NEXT_PUBLIC_API_BASE_URL.
  ...(process.env.NEXT_EXPORT === "1"
    ? {
        output: "export",
        images: { unoptimized: true },
      }
    : {
        async rewrites() {
          return [
            {
              source: "/api/v1/:path*",
              destination: `${process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000"}/api/v1/:path*`,
            },
          ];
        },
      }),
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  sourcemaps: {
    disable: true,
  },
});
