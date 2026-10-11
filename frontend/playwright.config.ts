import { defineConfig } from '@playwright/test';

// Playwright 的 webServer 探测会走 HTTP_PROXY（本机常驻代理对 localhost 回 400），
// 400 被误判为"服务已存在"，于是 webServer 从不启动，测试全部 ERR_CONNECTION_REFUSED。
// 让探测绕过代理直连本机。
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1']
  .filter(Boolean)
  .join(',');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // 有限内存环境下并发过高会让 next dev 编译期 OOM 崩掉（Zone Allocation failed），
  // 服务一死测试全部 ERR_CONNECTION_REFUSED。固定 2 个并发最稳。
  workers: process.env.CI ? 1 : 2,
  reporter: 'html',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    storageState: './e2e/.auth/state.json',
  },
  webServer: {
    // 用 npm run dev 而非 pnpm dev：pnpm 在部分 Windows 环境被依赖构建门禁拦（ERR_PNPM_IGNORED_BUILDS），
    // 导致 e2e 起不了服务（UNCERTAIN #4/#6）。npm 不受该门禁影响。
    //
    // 但**不能把整套 e2e 锁死在 npm 上**：有些环境（如 DSH 的托管 node 运行时）
    // 根本没有 npm，于是 webServer 起不来 → 所有用例 ERR_CONNECTION_REFUSED，
    // 看起来像"一大批产品缺陷"，实际是环境没配好（2026-10-11 实测：26 条里
    // 约 10 条由此产生）。所以允许用 E2E_WEB_SERVER 覆盖，默认仍是 npm。
    command: process.env.E2E_WEB_SERVER ?? 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    cwd: __dirname,
    env: {
      // 合并 process.env（Playwright 传 env 会替换整个环境，丢 PATH 会让 npm 起不来）
      ...(process.env as Record<string, string>),
      // 锁定假数据模式 = 自动造数（MSW handlers 即种子数据，无需数据库）
      NEXT_PUBLIC_API_MODE: 'mock',
      // 给 next dev 更大堆内存，防止并发编译时 OOM 崩掉服务
      NODE_OPTIONS: '--max-old-space-size=2048',
    },
  },
});
