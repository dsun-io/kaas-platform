import fs from 'node:fs';
import path from 'node:path';

/**
 * E2E 全局准备 —— 一键可跑三件事：
 *
 * 1. 自动登录：写入"已登录"会话状态（has_token cookie，见 src/middleware.ts），
 *    所有测试共享，无需每个用例重复登录。
 * 2. 自动造数：测试数据由前端自带的假数据层提供（src/mocks/handlers.ts，MSW），
 *    playwright.config.ts 的 webServer 已锁定 NEXT_PUBLIC_API_MODE=mock，
 *    不需要真数据库 / 真后端。
 * 3. 自动起后端（开发服务）：playwright.config.ts 的 webServer 用 `npm run dev`
 *    自动拉起前端开发服务（mock 模式下假数据层即"后端"）。
 *
 * 真后端联调场景见 quote-real-backend.spec.ts（无数据库环境自动跳过）。
 */
export default async function globalSetup() {
  const authDir = path.join(__dirname, '.auth');
  fs.mkdirSync(authDir, { recursive: true });

  const state = {
    cookies: [
      {
        name: 'has_token',
        value: '1',
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    // ⚠️ 光有 `has_token` cookie **不够**：那个只让 middleware 放行路由，
    // 而 `AuthProvider` 恢复会话走的是 **token store**，不是 cookie：
    //   `auth-context.tsx` → restore() 里 `const token = getToken()`
    //   拿不到就直接 return（**根本不会去调 `/auth/me`**）→ user 始终为 null
    //   → `account_type` 缺失 → `?? "customer"` 当成非管理员
    //   → 所有 `<RouteGuard adminOnly>` 页面渲染「您没有访问此页面的权限」。
    //
    // 这就是那 18 条 e2e 失败的真实机制（失败清单正好等于用 adminOnly 的 7 个页面）。
    // `TOKEN_KEY = "kaas_token"`（见 lib/auth/token-store.ts），且优先读 localStorage，
    // 所以必须在 origins.localStorage 里种一个。
    origins: [
      {
        origin: 'http://localhost:3000',
        localStorage: [{ name: 'kaas_token', value: 'mock-access-token' }],
      },
    ],
  };

  fs.writeFileSync(
    path.join(authDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}
