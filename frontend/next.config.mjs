import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
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
