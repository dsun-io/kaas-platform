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
    origins: [],
  };

  fs.writeFileSync(
    path.join(authDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}
