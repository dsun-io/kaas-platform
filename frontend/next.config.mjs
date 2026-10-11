import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 并发安全：构建产物目录可由环境变量覆盖（NEXT_DIST_DIR）。
  // 为什么需要：同一 worktree 里若有 `next dev` 在跑，它和 `next build` 会互相
  // 破坏默认的 `.next`（实测报 Cannot find module '.next/server/middleware-manifest.json'），
  // 于是"构建门禁"在某些时刻根本跑不起来。换目录即可并存，不必停别人的 dev。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
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
