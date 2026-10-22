import { defineConfig } from '@playwright/test';

/**
 * 导出态 e2e（2026-10-22 立项）—— 跑在**真实静态导出产物**上，不是 `next dev`。
 *
 * 为什么单独一套：现有 27 条 e2e 全部跑 `next dev` + mock，抓不到只在导出态出现的缺陷。
 * 2026-10-21/22 两个线上事故（侧边栏点击导航挂死、逐段预取全站 404）都在这个盲区里。
 *
 * 关键差异（与 playwright.config.ts 对照）：
 *   · webServer = `node scripts/serve-export.mjs`（伺服 `frontend/out`，SPA 回退语义对齐 Workers Assets）
 *   · baseURL = http://localhost:4173（与构建时内联的 NEXT_PUBLIC_API_BASE_URL 同源）
 *   · 产物由 `pnpm e2e:export` 先构建（mock 模式），本配置只负责"拿产物 + 起服务 + 跑用例"
 *
 * 只在 nightly / 手动跑（见 .github/workflows/frontend-ci.yml 的 e2e-export job）：
 * 单次含构建约 3–4 分钟，放 push/PR 不划算。
 */

// 同 playwright.config.ts：webServer 探测必须绕过本机常驻代理，否则 400 被当成"已就绪"
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1']
  .filter(Boolean)
  .join(',');

const PORT = Number(process.env.E2E_EXPORT_PORT || 4173);

export default defineConfig({
  testDir: './e2e-export',
  // 导出态用例少但都依赖构建产物与服务，串行最稳（并发点侧边栏容易互相干扰 prefetch 观测）
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  globalSetup: './e2e-export/global-setup.ts',
  outputDir: './e2e-export/test-results',
  reporter: process.env.CI ? [['list']] : [['list'], ['html', { outputFolder: './e2e-export/report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    storageState: './e2e-export/.auth/state.json',
    trace: 'on-first-retry',
  },
  webServer: {
    command: `node scripts/serve-export.mjs ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    cwd: __dirname,
    env: { ...(process.env as Record<string, string>) },
  },
});
